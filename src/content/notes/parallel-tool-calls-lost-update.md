---
title: 'Parallel Tool Calls、Lost Update 与执行分组'
description: '用一个可复现的异步写入案例，分析为什么 Tool Call 能并发执行不代表它们在业务语义上可以安全并行。'
publishDate: '2026-07-23'
tags:
  - Agent
  - Harness
  - Concurrency
  - Python
  - Tool Calling
language: '中文'
status: '待补充'
---

> 核心结论：并行性不是 Tool Call 的语法属性，而是 Tool 对共享状态产生何种影响的语义属性。

## 核心内容

支持 Parallel Tool Calls 后，最直接的实现通常是把模型在同一轮返回的调用全部交给 `asyncio.gather`：

```python
results = await asyncio.gather(
    *[execute_tool(call) for call in tool_calls]
)
```

这段代码可以正确地并发等待多个协程，却无法回答更重要的问题：这些操作在业务语义上是否允许同时发生？

当 Tool 只是搜索、读取或独立计算时，并行通常安全；当多个 Tool 基于同一份旧状态执行读—改—写时，即使它们修改不同字段，也可能产生 Lost Update。

本文只讨论这个窄问题：Execution Harness 在执行一组 Tool Calls 前，需要知道哪些信息，才能决定并行、串行或拒绝。

## 最小复现

下面的程序用一个内存字典模拟配置服务。两个操作分别更新 `name` 和 `description`，但 `put_config` 采用全量覆盖：

```python
import asyncio


state = {
    "name": "old name",
    "description": "old description",
    "version": 1,
}

both_read = asyncio.Event()
read_count = 0
read_lock = asyncio.Lock()


async def get_config():
    global read_count
    snapshot = state.copy()

    async with read_lock:
        read_count += 1
        if read_count == 2:
            both_read.set()

    await both_read.wait()
    return snapshot


async def put_config(snapshot):
    await asyncio.sleep(0)
    state.clear()
    state.update(snapshot)


async def update_name():
    config = await get_config()
    config["name"] = "new name"
    await put_config(config)


async def update_description():
    config = await get_config()
    config["description"] = "new description"
    await put_config(config)


async def main():
    await asyncio.gather(
        update_name(),
        update_description(),
    )
    print(state)


asyncio.run(main())
```

一种可能的输出是：

```text
{
  'name': 'old name',
  'description': 'new description',
  'version': 1
}
```

`update_name` 明明成功执行了，但结果被另一次全量写回覆盖。

## 为什么修改不同字段仍然冲突

两个协程执行的不是“修改一个字段”，而是：

```text
读取整个资源
→ 在本地副本上修改一个字段
→ 覆盖整个资源
```

时间线如下：

```text
T1 读取 V1: {name: old, description: old}
T2 读取 V1: {name: old, description: old}

T1 基于 V1 写入: {name: new, description: old}
T2 基于 V1 写入: {name: old, description: new}
```

从 Python 的角度看，没有数据竞争导致的内存损坏；每次字典更新都正常完成。从业务状态看，T2 用旧快照覆盖了 T1 的结果。

因此需要区分两种正确性：

- **协程执行正确性**：任务是否被正常调度、等待和收集。
- **状态转换正确性**：一组操作完成后，业务状态是否包含所有应该保留的更新。

`asyncio.gather` 只负责前者。

## `gather` 实际保证了什么

根据 Python 的 [`asyncio.gather` 文档](https://docs.python.org/3/library/asyncio-task.html#asyncio.gather)，它负责并发运行 awaitables，并按照输入顺序聚合结果。它并不提供：

- 事务
- 隔离级别
- 共享资源锁
- 幂等保证
- 写冲突检测
- 失败后的全组回滚

还有一个容易误解的行为：默认情况下，其中一个 awaitable 抛出异常后，异常会立即传播给等待 `gather` 的调用者，但其他 awaitables 不一定因此被取消。对 Tool Runtime 来说，这意味着可能出现部分成功：

```text
Tool A 成功并产生副作用
Tool B 失败
Tool C 仍在执行
```

这未必错误，但 Harness 必须明确自己采用的是：

- Best-effort 并行执行
- 任一失败即取消其余任务
- 全部执行后汇总错误
- 事务性 all-or-nothing

如果没有显式定义，系统就会把并发库的默认行为误当成业务语义。

## 不能只按工具名称分类

一种快速方案是根据名称判断：

```python
if tool.name.startswith(("update_", "delete_", "register_")):
    run_serially(tool)
else:
    run_in_parallel(tool)
```

这在已有系统中可以作为保守的止损规则，但它存在明显局限：

- `get_or_create_user` 名字像读取，实际可能写入。
- `search` 可能更新缓存、计费或访问时间。
- `update_local_draft` 与 `update_shared_config` 的风险不同。
- 同一个 Tool 在不同参数下可能影响不同资源。
- 两个写操作如果目标资源不同，实际上可以并行。

工具名称只能提供启发式信息，无法完整描述副作用。

## Harness 真正需要的元数据

更有表达力的 Tool 定义可以声明执行语义：

```json
{
  "name": "update_project_config",
  "effects": "write",
  "idempotent": false,
  "resource_keys": ["project:{project_id}:config"],
  "concurrency": "exclusive",
  "requires_confirmation": false
}
```

可能需要的字段包括：

| 字段 | 作用 |
|---|---|
| `effects` | `read / write / external_side_effect` |
| `resource_keys` | 这次调用会影响哪些逻辑资源 |
| `idempotent` | 重复执行是否得到相同结果 |
| `concurrency` | 允许并行、按资源串行或全局串行 |
| `reversible` | 是否存在补偿或回滚操作 |
| `requires_confirmation` | 执行前是否需要用户确认 |

真正的资源键通常需要结合参数动态生成。例如：

```python
resource_key = f"project:{args.project_id}:config"
```

这样两个不同项目的更新可以并行，同一项目的配置更新则进入同一串行队列。

## 一个简单的执行分组思路

Harness 可以先把调用转换为带资源信息的执行计划：

```python
class PlannedCall:
    call: ToolCall
    effects: str
    resource_keys: set[str]
    concurrency: str
```

然后使用保守规则分组：

1. 纯读取且资源之间无特殊限制，可以并行。
2. 写操作与访问同一资源的其他操作串行。
3. 用户交互、发布、删除等操作单独形成 Commit Boundary。
4. 无法确定副作用的第三方工具，默认串行。
5. 一个并行组的结果全部落库后，再让模型进入下一轮推理。

示意：

```text
Model returns 5 tool calls
        ↓
Resolve origin names and resource keys
        ↓
┌─────────────────────────────────┐
│ Group 1: read A, read B, read C │  并行
└─────────────────────────────────┘
        ↓
┌─────────────────────────────────┐
│ Group 2: update shared config   │  串行
└─────────────────────────────────┘
        ↓
┌─────────────────────────────────┐
│ Group 3: publish result         │  确认后执行
└─────────────────────────────────┘
```

这不是最优调度算法，但比“同一轮全部并行”更接近真实业务约束。

## 四种常见修复方案

### 1. 全部串行

```python
for call in tool_calls:
    results.append(await execute_tool(call))
```

优点是简单、保守。缺点是无关的搜索与读取也失去并行收益。它适合副作用未知或调用规模较小的系统。

### 2. 使用 PATCH 或原子字段更新

让服务端只更新指定字段：

```http
PATCH /config
{"name": "new name"}
```

如果两个请求修改不同字段，服务端可以分别原子应用。但如果它们修改同一字段，仍需定义冲突策略；PATCH 也不能自动解决跨字段业务不变量。

### 3. 乐观并发控制

读取时返回版本号，写入时要求版本仍然一致：

```text
GET  → version = 7
PUT  → If-Match: 7
```

第一个写入将版本更新为 8，第二个基于版本 7 的写入被拒绝。系统随后可以重新读取、合并或交给模型重新规划。

它避免静默覆盖，但把冲突转化成了需要处理的显式失败。

### 4. 按资源加锁或排队

```python
lock = locks[resource_key]
async with lock:
    await execute_tool(call)
```

它可以保证同一资源上的本进程操作串行，但需要注意：

- 多进程或多 Pod 需要分布式锁或服务端事务。
- 锁只能保护遵守同一协议的调用方。
- 锁粒度太大会降低吞吐量。
- 持锁期间调用外部服务可能造成长时间阻塞。

## 幂等性不能单独解决 Lost Update

幂等通常表示同一个请求重复执行多次，最终效果与执行一次相同。例如用固定 Idempotency Key 创建订单，服务端只创建一次。

但两个不同更新都可以是幂等的，同时仍然发生 Lost Update：

```text
set_name("new")        # 重复执行仍是 new
set_description("new") # 重复执行仍是 new
```

如果底层仍用旧快照全量覆盖，它们彼此之间依然可能冲突。

所以要分别讨论：

- **幂等性**：同一操作重复执行会怎样？
- **隔离性**：不同操作并发执行会怎样？

## 失败隔离与结果顺序

并行 Tool Calls 还需要决定两个问题。

### 一个工具失败，其他工具怎么办

如果工具互不依赖，允许其余工具完成可以保留有效结果；如果后续操作依赖全组成功，就应该取消或补偿。

不存在通用答案，关键是不能让执行库的默认异常传播方式替代产品决策。

### Tool Result 以什么顺序进入上下文

并发完成顺序可能是：

```text
C → A → B
```

但很多 API 要求 Tool Result 与模型返回的 Tool Call 正确对应。Harness 至少要保持 `tool_call_id`，并选择：

- 按原始 Tool Call 顺序写回
- 按实际完成顺序写回，同时保留关联 ID

如果顺序会影响下一轮模型理解，应该固定协议并加入测试。

## 当前理解 / 结论

这次分析后，我对 Parallel Tool Calls 的理解是：

1. 并行执行是性能机制，不是业务正确性保证。
2. Tool 是否可以并行，取决于副作用和资源冲突，而不是函数是否为 `async`。
3. 名称前缀可以作为保守启发式，但长期应让 Tool 声明执行语义。
4. Harness 需要定义部分失败、结果顺序、取消和补偿策略。
5. PATCH、乐观锁、幂等键和资源锁分别解决不同问题，不能互相替代。

它与 Blog 1 中 `Commit Boundary` 的关系是：

> 模型可以同时提出多个行动，但 Execution Harness 必须在提交前把它们转换为满足状态不变量的执行计划。

## 待补充

- 将最小复现扩展为一个可运行的公开示例仓库。
- 对比串行、资源锁和乐观并发控制的吞吐量。
- 研究 Tool Schema 是否应该原生携带副作用和并发语义。
- 补充跨进程、消息队列和分布式执行场景。

## 相关链接 / 来源

- [Autonomy Is a Budget：Agent 应该把自由度留在哪里？](/blog/autonomy-is-a-budget)
- Python documentation: [`asyncio.gather`](https://docs.python.org/3/library/asyncio-task.html#asyncio.gather)
- PostgreSQL documentation: [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities](https://arxiv.org/abs/2408.04682)
