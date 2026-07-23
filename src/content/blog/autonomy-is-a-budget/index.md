---
title: 'Autonomy Is a Budget：Agent 应该把自由度留在哪里？'
description: '从有状态工具、子 Agent 生命周期、权限边界和能力发布出发，讨论概率模型与确定性系统应该如何分工。'
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

> Agent 的自主性不是越多越好。越不可逆、越有副作用的操作，模型拥有的自由度应该越少，系统需要保证的确定性应该越强。

最开始做 Agent 项目时，我关注的问题很直接：模型能不能理解任务，能不能选对工具，能不能经过几轮推理完成目标。

在这样的视角里，Agent 越能自主规划、调用更多工具、启动子任务，似乎就越强。很多 Demo 也确实强化了这种印象：给模型一个目标、一组工具和一个循环，它就能表现出相当完整的行动能力。

但在个人项目之外接触更复杂的 Agent 系统后，我逐渐发现，真实问题经常不在“模型不会做”，而在“系统不知道什么时候应该允许它做”。

同一轮生成的两个 Tool Call 能否并行？已经启动的子 Agent 怎样取消？参数合法的文件读取为什么仍然可能越权？一个 Prompt、Tool 或 Skill 被其他人依赖以后，谁来管理它的版本与权限？

这些问题让我形成了一个还在持续修正的判断：

> **Autonomy is a budget, not a feature.**
>
> 自主性是一种需要被分配的预算，而不是一个越多越好的功能。

系统不应该消灭模型的自主性。相反，我们需要识别哪些地方适合让模型探索，哪些地方必须由确定性机制承担后果。

## 自主性为什么需要预算

传统程序的大部分行为由代码路径决定，输入相同时通常会进入相似的状态转换。Agent 则把一部分控制流交给了概率模型：模型可以决定下一步做什么、选择哪个工具、怎样组织参数，以及何时结束任务。

这种自由度带来了适应性，也同时带来了不确定性。

[τ-bench](https://arxiv.org/abs/2406.12045) 用真实业务规则、状态数据库和多轮用户交互评测 Tool Agent。论文中的先进 Function Calling Agent 在任务上的单次成功率仍低于 50%，多次重复执行的一致性更差；零售场景的 `pass^8` 低于 25%。这说明“偶尔成功”与“可以可靠使用”之间仍有很大距离。

[ToolSandbox](https://arxiv.org/abs/2408.04682) 进一步加入了有状态工具、工具之间的隐式依赖和中间状态评测。实验显示，状态依赖、参数规范化以及信息不足等问题，即使对能力很强的模型也很困难。

因此，自主性不能只按“模型能不能做”来分配，还应该看失败后会发生什么。

我尝试用五个维度描述一项操作需要多少自主性预算：

1. **可逆性**：执行后能否撤销或恢复？
2. **状态影响**：是否会改变其他任务依赖的共享状态？
3. **权限风险**：是否涉及用户数据、凭证或跨项目资源？
4. **可观测性**：失败后能否知道发生了什么？
5. **失败成本**：错误只是生成一个差答案，还是会真正产生外部副作用？

它不是一个严格的数学公式，但可以作为设计 Agent 行为边界的检查表：

```text
Autonomy Budget
  = f(reversibility, state impact, permission risk,
      observability, failure cost)
```

下面是几个让我开始重视这件事的工程场景。

## 观察一：模型可以提出并行，系统必须理解状态

支持 Parallel Tool Calls 后，一个很自然的优化是把模型在同一轮生成的工具全部并发执行：

```python
results = await asyncio.gather(
    *[execute_tool(call) for call in tool_calls]
)
```

对于互不影响的搜索、读取和计算，这通常很有效。但“接口可以异步调用”并不代表“业务语义允许并行”。

假设两个工具分别修改同一份配置的名称和描述：

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

它们修改的字段不同，看起来可以并行。但如果 `put_config` 是全量覆盖，两个任务可能都读到同一个旧版本：

```text
T1: read  {name: old, description: old}
T2: read  {name: old, description: old}
T1: write {name: new, description: old}
T2: write {name: old, description: new}
```

最终名称的修改丢失了。这是典型的 Lost Update。

问题不在 `asyncio.gather`，也不在模型“选错了工具”。真正的问题是并发决策缺少状态语义：Runtime 不知道这是纯读取、幂等写入、局部更新，还是基于旧快照的全量覆盖。

因此，我现在更倾向于把工具至少区分为：

| 类型 | 例子 | 默认策略 |
|---|---|---|
| 纯读取 | 搜索、读取文件、查询状态 | 可以并行 |
| 独立计算 | 格式转换、无共享状态计算 | 可以并行 |
| 幂等写入 | 带唯一键的确定性覆盖 | 有条件并行 |
| 共享状态修改 | 更新配置、修改任务计划 | 串行或并发控制 |
| 外部副作用 | 发消息、发布、删除、支付 | 严格控制并确认 |

更完整的解决方案可能包括 PATCH 语义、乐观锁、版本号、幂等键和事务。但无论采用什么机制，都不应该只根据“模型在同一轮生成了多个 Tool Call”就推断它们可以并行。

> 模型可以提出行动计划，但只有系统知道哪些状态变化可以安全地同时发生。

## 观察二：启动子 Agent 容易，可靠地结束它很难

创建一个后台子任务可能只需要一行代码：

```python
task = asyncio.create_task(run_sub_agent(query))
```

但当用户撤回请求、父任务回退、服务关闭或执行超时时，“取消”并不只是调用一次 `task.cancel()`。

一个真实的子 Agent 可能同时拥有：

- 正在进行的模型请求
- 尚未完成的工具调用
- 临时 Sandbox
- 浏览器或文件资源
- 正在写入的任务状态
- 等待父 Agent 消费的结果

如果父任务已经回退，但旧子任务仍在后台运行，它可能继续写文件、返回过期结果，甚至修改新一轮任务依赖的状态。于是系统需要知道：任务由谁创建、属于哪个 Turn、拥有了哪些资源，以及取消原因是什么。

更合理的取消过程接近一条协议：

```text
记录业务取消原因
→ 向子任务发送取消信号
→ 等待 finally / cleanup
→ 设置清理超时
→ 释放子任务自己拥有的资源
→ 保留从父任务继承的资源
→ 注销任务
→ 将最终状态同步给上游
```

这里最容易被忽略的是资源所有权。子 Agent 自己申请的 Sandbox 应该由它释放；从父 Agent 继承的资源则不能在子任务结束时随意销毁。

这让我开始用另一个标准判断 Agent Runtime 是否成熟：

> 一个系统是否真正拥有子 Agent，不取决于它能不能启动子 Agent，而取决于它能不能在任何时刻可靠地结束子 Agent。

## 观察三：合法的 Tool Call 仍然不能被信任

Tool Schema 可以约束参数类型：

```json
{
  "action": "file_process",
  "abs_path": "/workspace/project/report.md"
}
```

这条调用可能完全符合 JSON Schema，路径也真实存在，但仍然不代表它应该被执行。

至少还需要回答：

- 当前用户是否有权访问这个文件？
- 文件是否属于当前项目？
- 这个 Agent 是否加载了对应 Skill？
- 路径是否位于共享或只读区域？
- 当前操作是读取、覆盖还是删除？
- Tool 返回的数据是否可能包含恶意指令？

[AgentDojo](https://arxiv.org/abs/2406.13352) 用 97 个真实任务和 629 个安全测试案例研究了外部工具数据对 Agent 的 Prompt Injection。它提醒我们，Tool 的返回内容进入模型上下文以后，也可能反过来影响下一步行动。

因此，工具安全不能只依赖系统提示词中的一句“不要访问未授权数据”。Prompt 是给概率模型的行为指导，权限则必须是执行层的确定性判断。

我现在更认同这样的分工：

```text
Model / Prompt:  表达意图，提出候选行动
Tool Schema:     约束调用形状与参数协议
Policy Layer:    判断当前主体是否允许执行
Tool Runtime:    执行、记录并返回结构化结果
```

> Prompt 负责表达意图，Policy 负责决定权限；两者不能合并。

## 观察四：能力被别人依赖后，就不再只是配置

在个人项目里，一段 Prompt 或一个 Tool 可以直接修改并重新运行。但当一项 Agent 能力需要被其他用户、任务和业务场景复用时，问题会迅速变化。

一项能力可能同时依赖：

```text
Business Scenario
  └── Task Template
       ├── Toolset
       │    ├── MCP Tool
       │    └── Sub-agent
       ├── Skill Files
       └── Model Configuration
```

修改底层 Tool 的参数，会不会破坏上层 Toolset？发布一个新版本时，依赖应该跟随升级还是锁定旧版本？私有能力被分享以后，接收者拥有什么权限？一项能力测试通过，是否代表它依赖的所有子资产都可用？

这时，Prompt、Tool 和 Skill 已经开始表现得像软件资产，需要：

- 稳定身份与可读名称
- 版本与快照
- 依赖关系
- 测试与验证
- 发布和审核状态
- 权限与可见性
- 回滚与下架

2026 年的研究 [Skills Are Not Islands](https://arxiv.org/abs/2607.01136) 将这个问题称为 Agent Skill Supply Chains。作者分析了超过 143 万个 Skills，发现 Skill 的真实依赖可能跨越其他 Skill、软件包和外部服务；只检查单个 Skill，会遗漏依赖链中的安全风险。

这项研究很新，相关实践也仍在演进，但它支持了一个越来越明确的方向：

> 当 Agent 能力开始被别人依赖时，它就不再只是一段 Prompt，而是一份需要版本、依赖、验证和治理的软件资产。

## 确定性应该放在哪里

如果自主性不是越多越好，那么是不是应该把所有 Agent 都改回固定 Workflow？我认为也不是。

Anthropic 在 [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) 中区分了 Workflow 和 Agent：Workflow 用预先定义的代码路径协调模型，更可预测；Agent 则由模型动态决定过程，更灵活。它给出的建议是从最简单的方案开始，只在确实需要时增加复杂性。

这两者不是非此即彼。一个系统可以在不同层分配不同程度的自由：

| 层级 | 适合交给模型 | 应由系统保证 |
|---|---|---|
| 理解与规划 | 意图理解、任务拆解、候选方案 | 预算、最大步骤、结束条件 |
| 工具选择 | 在授权能力中选择工具 | 权限、参数验证、调用范围 |
| 工具执行 | 解释结果、决定后续行动 | 并发、超时、幂等、事务 |
| 子任务协作 | 选择是否需要专业子任务 | 生命周期、取消、资源所有权 |
| 能力复用 | 组合 Skill、Tool 和 Agent | 版本、依赖、审核、可见性 |
| 外部副作用 | 提出操作建议 | 确认、审计、回滚、Policy |

我更愿意把这个原则总结为：

> **把概率性留在适合探索的地方，把确定性放在需要承担后果的边界上。**

模型适合处理开放问题：理解不完整的意图、生成候选计划、从复杂上下文中寻找路径。系统适合处理不应该靠运气的问题：权限、状态一致性、资源回收、版本和审计。

## 自主性预算如何落地

如果要为一个新的 Agent 功能决定边界，我会先问以下问题：

### 1. 失败是否可逆？

生成一个候选草稿失败，通常可以重试；删除数据、发送消息或发布资源失败，后果更难撤销。后者应该要求更强的确认、事务和审计。

### 2. 操作是否改变共享状态？

多个读取可以并行，不代表多个更新也可以并行。需要识别资源版本、写入语义和冲突策略。

### 3. 权限依据来自哪里？

如果“允许执行”的依据只存在于 Prompt 中，安全边界就仍然是概率性的。执行层需要独立验证主体、资源和操作。

### 4. 任务能否被停止和恢复？

长任务与子 Agent 应该有清晰的身份、状态、所有者和取消路径。否则后台执行越多，孤儿任务越难管理。

### 5. 失败后能否解释？

没有结构化 Trace、状态变化和 Tool Result，系统只能知道“Agent 又失败了”，却不知道失败发生在规划、权限、工具还是状态冲突。

### 6. 这项能力是否会被别人依赖？

一旦答案是“会”，就应该开始考虑版本、兼容性、依赖、验证和回滚，而不只是修改 Prompt 后立即生效。

## 结语

Agent 的吸引力来自自主性：它可以面对没有被完整编码的问题，动态选择行动路径。但自主性本身不等于可靠性。

[AI Agents That Matter](https://arxiv.org/abs/2407.01502) 指出，Agent 不应该只追求 Benchmark Accuracy，还需要同时考虑成本、复杂度、可复现性和对真实应用的价值。对我来说，“自主性预算”也是同一类问题：我们不能只展示模型完成了什么，还要说明系统如何约束失败。

我现在对 Agent 工程的理解是：

> 好的 Agent 系统不是最大化模型自由，而是把自由留在探索有价值、失败可承受的地方。

这不是一套已经完成的答案。并行工具如何声明副作用、子 Agent 如何实现真正的结构化并发、能力依赖怎样形成可验证的供应链，都还有很多具体问题值得展开。

后续我会分别讨论其中的技术细节。但在进入实现之前，我想先保留这条原则：**模型负责探索，系统负责后果。**

## 参考资料

- Sierra Research, [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045)
- Apple, [ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities](https://arxiv.org/abs/2408.04682)
- ETH Zürich, [AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://arxiv.org/abs/2406.13352)
- Princeton et al., [AI Agents That Matter](https://arxiv.org/abs/2407.01502)
- Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- Jia et al., [Skills Are Not Islands: Measuring Dependency and Risk in Agent Skill Supply Chains](https://arxiv.org/abs/2607.01136)

