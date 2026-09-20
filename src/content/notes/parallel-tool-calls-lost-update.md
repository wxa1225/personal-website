---
title: '两个工具一起改文件，为什么只剩一份结果？'
description: '用一个异步写入的小例子，弄清 Lost Update，以及哪些工具调用可以一起执行。'
publishDate: '2026-07-23'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Harness
  - Concurrency
  - Python
  - Tool Calling
language: '中文'
status: '待补充'
---

两个工具，一个改名称，一个改描述。乍看之下，它们改的是不同字段，应该可以一起执行。

但如果两个工具都先读整份配置，再把改好的整份配置写回去，就可能只留下一份修改。这篇笔记想把这个过程拆开，也顺便理清 `asyncio.gather` 到底帮我们做了什么。

## 先把问题跑出来

下面用一个内存字典模拟配置服务。为了稳定地展示问题，`get_config` 里加了一个屏障，让两个任务都拿到旧快照以后再继续。这里的等待是实验安排，不是实际配置服务应该采用的实现。

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

运行后，名称和描述中会有一项仍然保持旧值。具体哪次写入最后完成，决定哪项修改留下；关键是两项修改没有合并。

注意代码里的 `version` 只是普通字段。没有任何地方在写入时比较它，所以加上这个名字，并不会自动获得版本控制。

## 改的是一个字段，写回的却是整个对象

把两个任务交错展开，就容易看出问题：

```text
T1 读取 V1: {name: old, description: old}
T2 读取 V1: {name: old, description: old}

T1 基于 V1 写入: {name: new, description: old}
T2 基于 V1 写入: {name: old, description: new}
```

两个任务都以 V1 为基础做修改。第二个任务写回的对象里，还带着它读到的旧名称，于是第一个任务刚改好的名称被覆盖了。

这也解释了为什么“它们改的字段不同”不是充分条件。真正需要看的，是存储接口如何更新资源。如果后端原子地只修改指定字段，情况会不同；如果它内部仍然做一次没有并发保护的读—改—写，换成 PATCH 这个方法名也不会解决问题。

## gather 不会替我们管理共享状态

`gather` 可以并发运行多个 awaitable，并按传入顺序组织返回结果。它不会给配置加锁，也不会在某个任务失败时把其他任务已经完成的写入撤回。

默认情况下，一个任务抛出异常后，其他任务也不一定都停止了。因此，上层收到错误时，不能直接断言“这一批调用什么都没做”。可能有的成功了，有的仍在执行。

对于 Agent 调度器，这意味着结果里最好保留每次调用的身份、状态和错误。把返回值和原来的调用 ID 对齐，也比按完成先后随手拼回上下文可靠。

## 判断冲突，需要知道实际操作的资源

按 `read_`、`update_` 这样的名称前缀分组，可以作为最初的保守办法，但很快会遇到例外：名字叫 `get` 的工具可能会刷新缓存，名字不同的两个工具也可能更新同一个对象。

工具定义可以提供一些更明确的信息。例如，下面是一个示意格式，不是现有协议要求的字段：

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

这里我最关心的是资源键。它应该由执行器根据经过检查的参数生成，例如 `project:42:config`，不能直接相信模型自己声明“不会冲突”。如果一个调用会读写多个资源，也需要把相关资源都纳入判断。

有了这些信息，调度器就能先把冲突的调用分到同一组，组内按顺序执行，互不依赖的组再并发。如果某个工具的行为还不清楚，先串行处理通常更容易检查。

## 几种修复方式，分别解决什么

最简单的是串行执行。在没有外部写入者、每次读取都能看到前一次写入的前提下，它可以避免这里的交错覆盖。但别直接把上面的实验改成串行：那个等待“两次读取都完成”的屏障也要移除，否则第一个任务就会一直等下去。

如果接口支持原子的字段更新，可以让存储层只改对应字段。对于需要根据旧值计算新值的操作，我会再考虑乐观并发控制：读取时带回版本，写入时要求版本仍然相同。

```text
GET  → version = 7
PUT  → If-Match: 7
```

版本不匹配时，重新读取并计算，或者把冲突交给上层处理。不能简单拿着旧快照无限重试。

资源锁也是一种办法，但范围要看清楚。进程内的 `asyncio.Lock` 只能协调使用同一把锁的协程，另一个进程或者外部客户端并不会受它约束。需要跨进程保护时，数据库事务、条件更新或其他共享协调机制才是要继续考虑的地方。

## 幂等键为什么还不够

幂等键主要处理“同一个请求又来了一遍”。这里却是两个不同的请求，各自只执行一次，也照样可能互相覆盖。

所以幂等、互斥和版本检查不能混为一谈。它们经常一起出现，是因为实际系统可能同时遇到重复提交和并发更新，而不是其中一个能包办所有问题。

## 接下来怎样验证

我会先保留这个稳定制造冲突的小实验，再分别换上原子更新和版本检查。验证时看最终字段和值，也看冲突有没有被明确报告，而不只是看协程有没有抛异常。

之后还想补上跨进程写入，以及一项成功、另一项失败的情况。调度器需要清楚地知道哪一步已经产生结果，才能决定重试、补偿还是停止。

这篇先记到这里。以后看到模型一次返回多个工具调用，我会先问它们会碰到哪些共享状态，再决定要不要直接交给 `gather`。

## 继续读

- [Agent 可以自己做主到哪一步？](/blog/autonomy-is-a-budget)
- Python documentation: [`asyncio.gather`](https://docs.python.org/3/library/asyncio-task.html#asyncio.gather)
- PostgreSQL documentation: [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities](https://arxiv.org/abs/2408.04682)
