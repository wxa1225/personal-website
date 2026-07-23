---
title: '取消一个子 Agent：结构化并发与资源所有权'
description: '从 asyncio 的取消语义出发，分析子 Agent 的任务注册、取消传播、清理超时、资源所有权与结果提交。'
publishDate: '2026-07-23'
tags:
  - Agent
  - Harness
  - Asyncio
  - Structured Concurrency
  - Lifecycle
language: '中文'
status: '已整理'
---

> 核心结论：`task.cancel()` 只是向任务注入一个取消请求。可靠地结束子 Agent，需要同时关闭它的执行树、回收它拥有的资源，并阻止过期结果越过 Commit Boundary。

## 问题不在于怎样启动，而在于谁负责收尾

一个最小的后台子任务只需要：

```python
task = asyncio.create_task(run_sub_agent(query))
```

但这行代码隐去了三个关系：

1. **父子关系**：父任务结束时，子任务是否仍被允许运行？
2. **所有权关系**：子任务创建或借用了哪些资源，分别由谁释放？
3. **提交关系**：子任务完成后，它的结果是否仍然属于当前 Turn？

只保存一个 `Task` 对象无法完整回答这些问题。如果父 Agent 超时、用户撤回请求或当前 Turn 已被替换，仍在运行的子任务可能继续调用工具、写入状态，最后把一个已经过期的结果交给新的上下文。

因此，“停止计算”只是取消协议的一部分。完整目标应该是：

```text
不再产生新的外部副作用
∧ 最终状态可观察
∧ 自有资源被释放
∧ 借用资源保持有效
∧ 过期结果不能提交
```

## `asyncio.cancel()` 实际做了什么

在 Python 中，`Task.cancel()` 会安排任务在下一次获得执行机会时抛出 `CancelledError`。它不是线程终止，也不是立即中断：

```python
async def worker():
    try:
        await do_work()
    finally:
        await cleanup()

task.cancel()
await task
```

这里至少存在四种情况：

- 任务在下一个可取消点收到 `CancelledError`，随后进入 `finally`。
- 被等待的协程正确传播取消，整条调用链开始退出。
- 某层捕获 `CancelledError` 却没有重新抛出，取消被吞掉。
- 某段同步阻塞代码长时间不让出控制权，取消迟迟无法被观察。

所以 `cancel_requested`、`cancelling` 和 `cancelled` 不是同一状态。调用 `cancel()` 后立刻把业务任务标记为 `CANCELLED`，会制造一个危险窗口：控制面认为它已经结束，数据面却可能仍在执行。

更准确的状态机可以是：

```text
CREATED → RUNNING → CANCEL_REQUESTED → CLEANING_UP → CANCELLED
                    ↘ FAILED
RUNNING → SUCCEEDED
```

`CANCEL_REQUESTED` 表示系统已经改变意图；`CANCELLED` 应表示执行树已经停止，并完成了规定范围内的清理。

## 取消原因不是异常文本

不同取消原因对应不同的上游行为：

```python
class CancelReason(str, Enum):
    USER_REVOKED = "user_revoked"
    PARENT_CANCELLED = "parent_cancelled"
    DEADLINE_EXCEEDED = "deadline_exceeded"
    TURN_SUPERSEDED = "turn_superseded"
    SERVICE_SHUTDOWN = "service_shutdown"
```

例如，超时可能允许从检查点重试；用户撤回通常不应自动重试；Turn 被替换时，结果必须作废，但某些只读缓存工作未必需要立刻终止。

`CancelledError` 负责控制流，`CancelReason` 负责业务语义。把原因作为结构化状态保存，才能让父任务、日志和恢复逻辑得到一致结论。

## 结构化并发解决的是任务所有权

非结构化的 `create_task` 类似手动分配内存：灵活，但调用者必须自己保存句柄、处理异常并保证回收。结构化并发要求子任务的生命周期不逃出一个明确的作用域。

Python 3.11 的 `TaskGroup` 提供了基本语义：

```python
async def run_turn(request):
    async with asyncio.TaskGroup() as group:
        researcher = group.create_task(research(request))
        reviewer = group.create_task(review(request))

    return researcher.result(), reviewer.result()
```

作用域退出前，组内任务必须完成；其中一个任务以非取消异常失败时，其余任务会被取消，异常最终以 `ExceptionGroup` 汇总。这比裸 `gather` 更接近“这组子任务共同属于当前操作”。

但 `TaskGroup` 不会自动解决：

- Sandbox、浏览器会话和临时文件由谁拥有；
- 已经发出的远程请求是否支持取消；
- 外部副作用是否需要补偿；
- 业务取消原因如何持久化；
- 结果是否仍有资格写入当前 Turn。

结构化并发给出了任务树，Harness 仍需为资源树和提交规则建模。

## 资源应该区分 owned 与 borrowed

子 Agent 使用的资源至少分成两类：

| 类型 | 示例 | 子 Agent 结束时 |
|---|---|---|
| `owned` | 自己创建的临时 Sandbox、临时目录、专属浏览器页 | 由子 Agent 释放 |
| `borrowed` | 父 Agent 的工作区、共享客户端、会话级缓存 | 只解除引用，不能销毁底层资源 |

可以把所有权明确写入租约：

```python
@dataclass
class ResourceLease:
    resource_id: str
    ownership: Literal["owned", "borrowed"]
    close: Callable[[], Awaitable[None]] | None
```

清理规则随后变得可测试：

```python
async def release(lease: ResourceLease):
    if lease.ownership == "owned" and lease.close is not None:
        await lease.close()
```

如果不区分这两种关系，系统会在两个方向犯错：不释放自有资源造成泄漏，或者错误关闭借用资源，破坏仍在运行的父任务和兄弟任务。

所有权还应支持转移。例如子任务生成一个工件并成功提交后，工件可能从 `child-owned` 转移为 `turn-owned`；如果提交前被取消，则仍由子任务清理。资源转移本身就是一个 Commit Boundary。

## `shield` 只能保护 await，不能创造清理协议

取消发生后，某些短小且必要的清理步骤不应再次被外层取消打断。常见做法是：

```python
async def bounded_cleanup(resource):
    cleanup_task = asyncio.create_task(resource.close())
    try:
        await asyncio.wait_for(
            asyncio.shield(cleanup_task),
            timeout=5,
        )
    except TimeoutError:
        record_cleanup_debt(resource.id)
```

这里三个机制各自解决不同问题：

- `shield`：外层等待被取消时，不自动取消被保护的清理任务。
- `wait_for`：清理不能无限阻塞关闭流程。
- `cleanup debt`：超时不等于资源已经消失，需要记录并交给后台回收或告警。

不应把整个子 Agent 放进 `shield`。那会让父任务失去生命周期控制，也正是孤儿任务的来源之一。保护范围应尽量小，只覆盖维持系统不变量所必需的清理或提交步骤。

## 取消不是回滚

假设子 Agent 已经执行：

```text
创建草稿 → 上传文件 → 发送通知
```

取消发生在“上传文件”之后，`CancelledError` 无法撤回已经完成的远程副作用。此时系统需要显式选择：

- 接受部分完成，并记录可观察状态；
- 执行补偿操作，例如删除已上传但未提交的临时文件；
- 使用服务端事务或 prepare/commit 协议；
- 在高后果操作前再次验证取消状态与授权。

这也是取消与 Commit Boundary 的连接点：取消信号只能阻止未来的 Python 控制流；真正阻止过期副作用，需要执行器在每个不可逆提交之前重新验证任务租约。

```python
async def commit_result(ctx, result):
    lease = await ctx.turn_store.get_lease(ctx.turn_id)

    if lease.generation != ctx.generation or lease.cancel_requested:
        raise StaleExecution("turn is no longer active")

    await ctx.result_store.compare_and_set(
        key=ctx.turn_id,
        expected_generation=ctx.generation,
        value=result,
    )
```

这里检查两次仍不必然消除竞态，因此最终提交最好由带版本条件的原子操作完成。取消标志负责表达意图，generation/CAS 负责保证旧执行不能覆盖新状态。

## 一个最小的生命周期骨架

下面的伪代码把注册、取消、清理与注销放进同一协议：

```python
async def run_registered_child(registry, spec):
    handle = await registry.register(
        parent_id=spec.parent_id,
        turn_id=spec.turn_id,
        generation=spec.generation,
    )

    try:
        await registry.mark_running(handle.id)
        result = await run_child(spec, handle)
        await commit_result(handle.context, result)
        await registry.mark_succeeded(handle.id)
        return result

    except asyncio.CancelledError:
        await registry.mark_cleaning_up(handle.id)
        raise

    except Exception as exc:
        await registry.mark_failed(handle.id, summarize(exc))
        raise

    finally:
        await bounded_release_owned_resources(handle.resources)
        await registry.finalize(handle.id)
```

对应的取消入口不伪装成同步完成：

```python
async def request_cancel(registry, task, reason):
    await registry.mark_cancel_requested(task.id, reason)
    task.runtime_task.cancel(reason.value)

    try:
        await asyncio.wait_for(task.runtime_task, timeout=10)
    except asyncio.CancelledError:
        pass
    except TimeoutError:
        await registry.mark_cleanup_timed_out(task.id)
```

生产实现还需处理注册与启动之间的竞态、进程崩溃后的租约过期、远程 worker 失联和重复取消。这个骨架的价值不在于覆盖全部情况，而是让每个状态变化都有明确责任人。

## 常见失败模式

### 1. 创建任务后丢失强引用

后台任务既没有注册表也没有结果消费者，异常无人观察，服务关闭时也无法枚举和取消。

### 2. 吞掉 `CancelledError`

```python
try:
    await work()
except BaseException:
    return fallback
```

宽泛捕获可能把取消变成普通成功。需要单独重新抛出 `CancelledError`，并谨慎使用 `uncancel()` 等机制。

### 3. 先标记 cancelled，再等待真实退出

状态与现实脱节，上游可能启动替代任务，而旧任务仍在写同一资源。

### 4. 清理没有超时

一个失联的浏览器或远程 worker 会让整个关闭流程永久挂起。

### 5. 清理超时后假装成功

系统失去资源泄漏的证据。至少需要保存 cleanup debt、资源标识和后续回收状态。

### 6. 只检查任务是否取消，不检查结果是否过期

取消与提交并发时，旧结果仍可能越过边界。结果提交需要 Turn/generation 条件，而非只读一次布尔标志。

## 应该测试哪些不变量

生命周期测试不应只断言“抛出了 `CancelledError`”。更有价值的是验证：

1. 父任务取消后，不存在仍可提交结果的子任务。
2. 一个子任务失败时，同组兄弟任务按策略退出。
3. 每个 `owned` 资源恰好释放一次，`borrowed` 资源从未被子任务关闭。
4. 清理超时会留下可追踪的 cleanup debt。
5. 旧 generation 的结果无法覆盖新 Turn。
6. 重复发送取消请求不会造成重复补偿或状态倒退。
7. 进程重启后，过期租约能够被发现和回收。

测试时应主动把取消注入到 `register`、资源创建、远程调用返回、提交前和清理中等边界，而不是只在任务稳定等待时取消。真正的错误往往藏在这些相邻状态之间。

## 当前理解 / 结论

1. 取消是协作式协议，不是强制终止指令。
2. 结构化并发约束任务作用域，但资源所有权仍需单独建模。
3. `owned`、`borrowed` 与 ownership transfer 决定谁可以释放资源。
4. `shield` 适合保护有界清理，不适合让整个子 Agent 逃离父任务。
5. 取消不能撤回已经发生的副作用；补偿、事务和提交前校验解决的是另一层问题。
6. 可靠性最终取决于执行租约：旧任务即使尚未停止，也不能再跨过 Commit Boundary。

它与 Blog 1 的关系可以概括为：

> 父任务决定子 Agent 是否还值得继续，Execution Harness 决定一个已经失去资格的执行不能再产生什么后果。

## 待补充

- 将示例扩展成可运行的 `TaskGroup` 故障注入实验。
- 对比本地 Task Registry 与分布式租约的失效模型。
- 补充远程 Tool Call 不支持取消时的 fencing token 设计。
- 研究清理债务的重试、告警和人工处置策略。

## 相关链接 / 来源

- [Autonomy Is a Budget：Agent 应该把自由度留在哪里？](/blog/autonomy-is-a-budget)
- Python documentation: [`Task Cancellation`](https://docs.python.org/3/library/asyncio-task.html#task-cancellation)
- Python documentation: [`Task Groups`](https://docs.python.org/3/library/asyncio-task.html#task-groups)
- Nathaniel J. Smith: [Notes on structured concurrency, or: Go statement considered harmful](https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/)
- Trio documentation: [Structured concurrency](https://trio.readthedocs.io/en/stable/reference-core.html#structured-concurrency)

