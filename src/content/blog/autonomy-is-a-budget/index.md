---
title: 'Agent 可以自己做主到哪一步？'
description: '从并行工具、子任务取消和文件权限聊起：怎样给 Agent 留出探索空间，又让执行结果可控。'
updatedDate: '2026-09-20'
publishDate: '2026-07-23'
tags:
  - Agent
  - AI Engineering
  - LLM
  - MCP
  - Systems
language: '中文'
comment: true
---

给 Agent 接上工具之后，很容易想继续往前加：多开几个任务，多给一点权限，让它自己决定接下来做什么。看着它一口气完成一长串操作，确实很有吸引力。

不过，有几个问题让我更在意它背后的执行代码。两个工具同时修改一份配置，结果会不会互相覆盖？用户点了取消，已经启动的子任务怎么办？模型把文件路径填对了，这次读取就一定被允许吗？

这篇想聊的就是这些看起来不太起眼的地方。我把管理工具调度、状态、权限和任务生命周期的那层代码叫作 **Execution Harness**。名字可以换，事情总要有人做。

## 先看一个很容易写出来的并行调用

模型一次返回多个工具请求，最直接的处理方式大概是这样：

```python
results = await asyncio.gather(
    *[execute_tool(call) for call in tool_calls]
)
```

如果几个请求分别查询互不相关的资料，这样做通常能省下不少等待时间。但把搜索换成配置更新，问题就来了。

假设两个工具分别修改名称和描述。它们都先读取整份配置，在本地改一个字段，再把整份配置写回去：

```python
async def update_name():
    config = await get_config()
    config["name"] = "new name"
    await put_config(config)


async def update_description():
    config = await get_config()
    config["description"] = "new description"
    await put_config(config)
```

字段不同，听起来互不影响。可一旦两个工具读到同一个旧版本，后写入的那个就会把前一个的修改盖掉：

```text
T1: read  {name: old, description: old}
T2: read  {name: old, description: old}
T1: write {name: new, description: old}
T2: write {name: old, description: new}
```

这就是丢失更新，Lost Update。`gather` 做了它该做的事，把两个协程并发跑起来；它并不知道这两次写入在业务上会发生冲突。

所以，判断能不能并行时，光看函数是不是 `async` 不够，还得看它们操作什么资源、怎样写入。对于共享配置，可以考虑串行执行、原子字段更新，或者在写入时检查读取到的版本。幂等键能处理重复请求，却不能单独解决两个不同请求互相覆盖的问题。

我把可运行的小例子和几种修复方式放在了[这篇笔记](/notes/parallel-tool-calls-lost-update)。这里先记住一件事：模型提出的调用顺序，不能替代系统对共享状态的判断。

## 点了取消，事情就结束了吗

启动子 Agent 也很容易写成一行：

```python
task = asyncio.create_task(run_sub_agent(query))
```

但一个子任务跑起来以后，可能已经打开文件、创建临时目录，或者向远程服务发出了请求。用户取消任务时，系统要处理的是这些正在发生的事。

`task.cancel()` 会发出取消请求，任务需要有机会响应。它不会让远程请求倒着执行，也不会自动收回已经写出去的数据。更麻烦的是，子任务有时会晚一点才返回：父任务已经结束，它却带着旧结果回来，准备继续写入。

我会把这件事分成两部分处理。一部分是尽快让工作停下来：传播取消、等待清理、为清理设置时限。另一部分是在提交处挡住过期结果：检查任务是否还有效、它使用的授权或版本是否已经失效。

资源也要分清楚。子任务自己创建的临时目录可以由它清理；从父任务借来的连接，不能在退出时顺手关掉。否则一个子任务取消了，旁边仍在运行的任务也会跟着出问题。

这也是我觉得“能启动多少个 Agent”之外，另一个值得看的指标：任务不想继续了，系统能不能把它妥善收尾。具体的生命周期和资源处理，放在[子任务取消笔记](/notes/sub-agent-cancellation-resource-ownership)里。

## 参数正确，只是走完了第一步

再看一个文件工具请求：

```json
{
  "action": "file_process",
  "abs_path": "/workspace/project/report.md"
}
```

它可能完全符合 Schema，路径也确实存在。但这些只能说明请求格式没有问题。文件属于谁，当前任务能不能访问，目标是不是只读资源，都还没检查。

路径本身也会带来麻烦。`..` 可能把目标指向另一个目录，符号链接可能把访问带出工作区；检查结束到真正打开文件之间，目录还可能被替换。因此，执行器需要把授权绑定到实际操作的资源，而不是只看模型提供的字符串。

读到的内容又是另一层问题。网页或文件里出现一句“忽略之前的规则”，它仍然只是外部数据。不能因为它被放进了上下文，就让它变成新的授权依据。

我会让各层各自负责一件事：Schema 校验参数，权限代码检查主体和资源，工具执行器完成操作并记录结果。提示词可以帮助模型理解边界，但真正拦住越界操作，还得靠执行代码。[文件授权那篇笔记](/notes/tool-schema-policy-mcp-file-authorization)把这条流程拆得更细。

## 把检查放在事情真正发生之前

说到这里，似乎每走一步都要检查，会不会让 Agent 变得很笨重？

我觉得关键在于检查放在哪里。生成几个候选方案、比较资料、重写一段草稿，这些地方可以给模型比较大的尝试空间。准备覆盖共享文件、发布内容，或者把数据发送出去时，系统就需要核对当前授权和状态。

可以把提交前的检查理解成这样：

```text
Candidate action
    ↓
Commit Boundary
    ├── 是否有权限？
    ├── 状态是否仍然有效？
    ├── 是否可以并行？
    ├── 是否需要确认？
    ├── 能否取消或回滚？
    └── 是否留下执行证据？
    ↓
External side effect
```

这里的“需要确认”也不是每次都弹窗。已经明确授权、范围没有变化的操作，可以按规则执行；超出约定范围、后果又难以撤回时，才需要把决定交还给用户。具体规则要跟任务一起设计。

工作流和自主规划也可以配合使用。确定的步骤交给代码，开放的问题留给模型，不必为了显得更“Agent”而把每个环节都变成一次推理。[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)里从简单方案开始的思路，我觉得很适合拿来提醒自己。

## 下次做功能时，我会先问什么

与其先决定要接多少工具，我更想先问：失败以后会留下什么？是一个可以重写的草稿，还是一份已经被覆盖的文件？任务能不能停下来，停下来之后有没有人清理？出了错，能不能找到当时的输入、授权和状态版本？

这些问题的答案，会影响并行策略、权限范围和记录方式。成本、最大步骤数和时间限制也要在这里考虑，否则一次本来很小的探索，很容易变成没有明确终点的后台任务。

我想保留的自由度，是模型可以在合适的范围里尝试不同路径。至于写入是否冲突、权限是否有效、资源有没有回收，最好不用靠它这一次恰好想起来。

这也是“自主性预算”这个说法对我的意义：先看行动的后果，再决定让它自己做主到哪一步。

## 参考资料

- Sierra Research, [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045)
- Apple, [ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities](https://arxiv.org/abs/2408.04682)
- ETH Zürich, [AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://arxiv.org/abs/2406.13352)
- Princeton et al., [AI Agents That Matter](https://arxiv.org/abs/2407.01502)
- Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- OpenAI, [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- Yang et al., [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)
