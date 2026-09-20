---
title: '点了取消，子 Agent 为什么还在跑？'
description: '从 task.cancel() 开始，整理取消传播、资源清理和迟到结果的处理方式。'
publishDate: '2026-07-23'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Harness
  - Asyncio
  - Structured Concurrency
  - Lifecycle
language: '中文'
status: '待补充'
---

启动一个子 Agent 可以很简单：创建任务，等它返回结果。用户改变主意、父任务超时，或者服务准备退出时，真正麻烦的部分才会出现。

这篇笔记沿着“取消”往下看。关心的事情有三件：工作怎样停下来，资源由谁清理，迟到的结果还能不能提交。下面涉及业务存储的代码都是伪代码，用来说明约束，不是可以直接用于生产的完整实现。

## cancel 发出去以后，发生了什么

在 asyncio 里，`Task.cancel()` 请求任务在后续执行中接收 `CancelledError`。任务需要获得执行机会，并正确处理这个异常，取消过程才能往下走。

因此，调用 `cancel()` 后不能马上把任务当成已经结束。没有让出执行权的同步代码不会因此立刻停下；远程服务已经接到的请求，也不会自动撤回。

清理通常放在 `finally` 中。需要捕获 `CancelledError` 时，完成必要处理后应继续传播，避免上层把一次取消误判成正常完成。尤其要注意 `except BaseException` 这样的宽泛捕获，它可能连取消也一起吞掉。

取消的业务原因最好另外记录。用户撤回、父任务结束、超过预算和服务关闭，后续处理可能不同，不必都塞进一段异常文本里再反向解析。

## 先让子任务有一个明确的归属

随手调用 `create_task` 很方便，但句柄放在哪里、异常由谁接收、父任务退出时谁来等待，都需要自己管理。

如果任务关系适合放在同一个作用域里，可以考虑 `TaskGroup`：

```python
async def run_turn(request):
    async with asyncio.TaskGroup() as group:
        researcher = group.create_task(research(request))
        reviewer = group.create_task(review(request))

    return researcher.result(), reviewer.result()
```

这里的研究和审阅任务都归这次调用管理。离开作用域时，不能把它们当作与父任务无关的后台工作丢在那里。不过，正常退出 TaskGroup 通常会等待子任务完成，并不等于自动取消所有子任务；具体取消和异常传播仍要按它的语义处理。

结构化并发能帮助我们管理任务关系，但它不知道哪个临时目录属于谁，也不知道某次工具调用是否已经在远端写入。后面这些还是业务层的工作。

## 用过一个资源，不代表拥有它

一个子任务可能自己创建 Sandbox，也可能借用父任务的浏览器或连接池。这两类资源退出时不该走同一条清理逻辑。

可以给资源记录一个简单的租约：

```python
@dataclass
class ResourceLease:
    resource_id: str
    ownership: Literal["owned", "borrowed"]
    close: Callable[[], Awaitable[None]] | None
```

`owned` 表示当前任务负责释放，`borrowed` 表示只是在使用。共享资源需要引用计数或独立的管理者；如果所有权会转移，也应有明确的交接，不能靠“最后碰过它的人”来猜。

这是我觉得很容易在正常流程里看不出来的问题：任务顺利完成时都没事，一旦父子任务接连取消，同一份资源就可能被释放两次，或者谁都没释放。

## 清理也可能超时

把释放操作放进 `finally` 是起点，还要考虑释放本身卡住的情况。有些短小的必要操作可以用 `shield` 避免被外层取消一并打断，但被保护的任务仍可能继续运行。

因此，加一个 `wait_for` 超时，并不意味着里面的工作已经被终止；特别是内层任务受到 `shield` 保护时，上层不等了，它可能仍在执行。需要保留任务引用，安排后续回收或记录清理失败，而不是超时后就忘掉它。

如果远程资源确实无法及时关闭，可以把它记为待清理事项，交给独立回收流程。任务状态也应该能反映“业务已取消，但清理尚未完成”，这样排查时不会只看到一个过于乐观的 cancelled。

## 取消和提交，可能同时发生

假设父任务刚更新为新一轮，旧子任务就返回了一份结果。只靠之前发出的取消信号，未必来得及阻止写入。

一种思路是在任务上记录 generation，把结果和它开始执行时的那一代绑定：

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

这段伪代码里，前面的读取检查只是提前发现失效。最后的条件提交才需要在存储层原子地验证 generation。取消也必须使提交所依赖的版本或租约失效，否则“检查通过到真正写入之间”仍然留着窗口。

对于已经发往远程服务的操作，还需要对方支持相应的条件写入或 fencing 机制。如果它完全不支持取消和版本校验，就不能假装本地任务退出以后，远端也一定停止了；应保留结果未知的状态，再查询或补偿。

## 已经发生的事情，要另行处理

假设流程是创建草稿、上传文件、发送通知。走到第三步时取消，前两步未必可以自动撤回。

是否删除草稿、清理上传文件，需要按产品语义决定；通知是否已发送，也可能要向外部服务核对。这里处理的是补偿和幂等，不能只依赖协程的取消异常。

所以，任务最后除了成功和失败，还可能有“已取消但留下部分结果”“远端结果未知”这样的状态。把它们如实记录下来，后续才知道该恢复什么。

## 我想补的几个实验

下一步想把 TaskGroup、任务注册表和资源租约放进一个小例子里，在读取、写入、清理几个位置分别触发取消。

检查时会特别看：自有资源是否只释放一次，借用资源是否仍可使用，旧 generation 的结果能否被拒绝，以及清理超时有没有留下可处理的记录。只断言抛出了 `CancelledError`，覆盖不到这些问题。

我现在对“取消完成”的理解也因此具体了一些：任务不再产生新的、未经允许的后果，已有结果和未完成的清理都能被上层看见。至于远端不能撤回的部分，需要明确留下来，不能用一个状态字段把它抹平。

## 继续读

- [Agent 可以自己做主到哪一步？](/blog/autonomy-is-a-budget)
- Python documentation: [`Task Cancellation`](https://docs.python.org/3/library/asyncio-task.html#task-cancellation)
- Python documentation: [`Task Groups`](https://docs.python.org/3/library/asyncio-task.html#task-groups)
- Nathaniel J. Smith: [Notes on structured concurrency, or: Go statement considered harmful](https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/)
- Trio documentation: [Structured concurrency](https://trio.readthedocs.io/en/stable/reference-core.html#structured-concurrency)
