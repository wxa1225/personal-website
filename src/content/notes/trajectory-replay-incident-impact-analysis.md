---
title: '把 Agent 再跑一遍，能找出上次的原因吗？'
description: '区分回看记录、固定响应测试和真实重跑，让排查结论有明确的适用范围。'
publishDate: '2026-07-24'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Provenance
  - Replay
  - Incident Analysis
  - Supply Chain
language: '中文'
status: '待补充'
---

“把上次任务重放一下”听起来很明确，实际可能指几件完全不同的事：回看旧消息、固定工具响应测试新代码，或者真的再调一次模型和外部服务。

如果没有先区分，界面上同一个 Replay 按钮，可能一会儿只是展示记录，一会儿又发出了一次真实写入。这篇先划清实验范围，再看重放能怎样帮助排查问题。

## 先说清楚要做哪一种重放

我会把常见方式分成四类：

| 方式 | 实际做什么 | 外部影响 |
|---|---|---|
| 回看记录 | 展示当时保存的事件和内容 | 不重新调用工具 |
| 固定响应测试 | 用记录下来的工具响应测试流程 | 阻止真实外部写入 |
| 隔离环境重跑 | 在独立状态副本里运行组件 | 影响限制在测试环境 |
| 真实重新执行 | 重新访问模型与外部服务 | 可能产生新的结果和副作用 |

回看记录时，如果正文已经删除，就显示缺失标记，不能悄悄重新读取今天的文件来补齐。那样看起来更完整，却已经不是当时发生的事情。

真实重新执行则应该作为新任务重新授权。旧日志里的 allow 决定，不能直接当作今天仍然有效的通行证。

## 给实验留一份清楚的条件记录

下面是一份 Replay Manifest 草案，用来列出哪些内容被固定、哪些行为被禁止：

```yaml
replayVersion: 1
sourceRun: run:original
sourceCheckpoint: sha256:...
mode: fixture

subject:
  resolution: sha256:72cd...
  harness: sha256:5f20...
  policy: sha256:b519...
  model:
    id: provider/model
    revision: observed-revision

inputs:
  contextManifest: sha256:...
  stateSnapshot: snapshot:...
  toolFixtures: fixture-set:...
  clock: frozen:2026-07-24T00:00:00Z
  randomness:
    seed: 42

effects:
  network: deny
  externalWrite: deny
  sandboxRoot: sandbox:replay-91

comparison:
  baselineRun: run:original
  invariants: suite:trajectory-regression-v2
```

它记录源任务、内容版本、模型信息、工具响应集合和比较目标。有些远程依赖无法真正冻结，就明确写出能观察到的标识与限制。

这份记录不会保证输出相同。它的作用是让两次实验之间的变化有处可查，而不是环境悄悄变了以后，把差异全算到模型头上。

## 工具响应不能只按名称匹配

固定响应测试里，一个简单实现可能是：工具调用来了，就从记录中返回对应结果。但对应关系不能只看工具名。

`search` 的查询词、数量或调用范围改变了，却仍然收到同一份旧响应，会把新代码的问题藏起来。比较合理的键至少考虑：

```text
tool binding digest
+ canonical arguments
+ caller scope if relevant
+ fixture state version
```

参数规范化也要尊重工具语义。调整 JSON 键顺序通常不改变含义，随手把搜索词全部转成小写，则未必是等价操作。

匹配不到的请求应该明确失败或标记缺少 Fixture，不能悄悄退回真实服务。否则测试跑着跑着，就越出了原先约定的范围。

## 有状态工具，需要真的模拟状态变化

如果流程是先读配置、更新配置、再读一次，不能把每次读取都机械地替换成同一个旧响应。

```text
read config v1
write config v2
read config v2
```

这类测试需要状态机或隔离快照，保留资源版本、条件更新和幂等语义。否则即使流程里有丢失更新或重复提交，录制好的“成功”结果也可能一路把它遮住。

时间和调度同样是输入。两个并行工具谁先完成、哪次调用超时，都会影响后续路径。需要研究这些问题时，可以使用虚拟时钟和明确的完成顺序；只固定一个随机种子，覆盖不到全部环境变化。

## 最终答案不同，未必就是回归

远程模型即使使用相同名称和参数，也未必逐字返回相同文本。反过来，最终答案碰巧相同，也不代表中间的权限和状态行为正确。

我会分层比较：确定性转换看精确结果，工具选择和参数看结构，状态写入和权限看必须满足的约束，开放式文字再结合合适的评价方式。

成本、耗时、重试次数和子任务结果是否被采纳，也可以进入差异报告。这样才能区分一个只是换了表达方式的回答，和一个表面成功、实际多写了一次文件的运行。

## 隔离环境不要借用生产凭证

需要真实运行组件时，测试环境应明确限制网络、文件和数据库范围，使用专门的凭证。消息发送和发布工具可以替换成隔离的接收端，不要因为叫作“调试”就默认允许真实副作用。

不支持隔离的工具，要标明它需要真实执行，或当前不可重放。遇到未知工具时，默认阻止通常比自动接到线上接口更容易维护实验边界。

新的运行也要有自己的身份，再用关系指回原任务。直接复用原来的 Run ID，会把历史事实和新实验混在一起。

## 排查先找一个确定发生的结果

相比直接问“Agent 为什么做错了”，我更愿意先选一个具体起点：一份错误报告、一个未经允许的外部产物，或者一次迟到结果被采纳的事件。

从这个点向前查输入、授权、能力版本和委托关系，向后查它影响了哪些产物。时间邻近的记录可以提供线索，但不要直接把附近所有事件都当成原因。

图里的祖先也只是候选。某份文档被放进上下文，说明模型有机会看到它，不足以证明它是错误决定的唯一原因。调查结论需要区分观察、组件声明、验证结果和推测，并留下尚未排除的解释。

取消相关的事故尤其如此。两台机器上的时间戳有偏差时，要结合任务 generation、授权失效和提交关系判断，不能只看某条日志显示得晚不晚。

## 查影响范围，别把安装量当作受影响数量

如果某份 Skill 快照被撤销，我会沿着具体内容身份往后查，而不是搜索同名安装：

```text
revoked Snapshot
  ↓ includedIn
Resolution records
  ↓ loadedBy
Agent Runs / Turns
  ↓ usedBy
Model, Tool and Policy Activities
  ↓ generated
Artifacts / State Versions / External Effects
  ↓ derivedInto
Downstream reports, caches, evaluation cases
```

安装了、运行时加载了、执行中使用了、实际产物受到影响，是不同层次。中间缺少记录时，也要把不确定性留下来，不能自动推导成全部受影响或全部没问题。

关系的类型同样重要。确定的派生边、观察到的输入关系和相似度推断，不该在影响查询里被一视同仁。查询可以明确限定允许遍历的关系与证据等级。

找到范围以后，再分别处理未来解析、正在运行的任务、已有授权和外部产物。升级 Registry 的指针，只覆盖了其中一部分。

## 换一个策略跑通了，能说明什么

这是很有价值的对照实验，但结论应限定在这次实验条件里。新策略阻止某次操作后，模型可能换一条路径；重复运行也可能出现不同结果。

所以我会尽量只改变想研究的变量，记录新旧 Manifest，做必要的重复实验，再报告观察到的差异。不能因为换策略后成功一次，就断言历史事故一定会被它阻止。

确认有价值的失败场景之后，可以缩小输入、处理敏感内容，再加入回归测试。保留来源和适用条件，后面的人才知道这个用例想防什么。

## 调查本身也需要收尾

多跳查询要限制深度、节点数和执行时间，并在遍历过程中执行权限检查。否则一次“查全部下游”的请求，可能拖垮服务，或沿着关系暴露其他租户的数据。

最后可以把起点、证据引用、缺口、结论和处置整理成一份带版本的调查记录。结论改变时生成新版本，比直接覆盖旧报告更方便核对。

我接下来想先做一个固定响应和可控调度的小例子，演示取消与提交交错时会发生什么。让“重放”有明确条件，让“原因”有具体证据，这两个目标比把日志播放得更顺滑更值得先完成。

## 继续读

- [Agent 出了错，为什么翻聊天记录还不够？](/blog/agent-trajectories-as-provenance-graphs)
- [给 Agent 的执行记录连上线：事件、身份和因果](/notes/agent-provenance-event-model-identity-causality)
- [Agent 日志该留多少，又该怎样删？](/notes/trajectory-integrity-redaction-retention)
- W3C: [PROV-DM — The PROV Data Model](https://www.w3.org/TR/prov-dm/)
- OpenTelemetry: [Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- AgentTrails: [Execution-Trace-Based Evaluation of LLM Agents](https://arxiv.org/abs/2607.18816)
- Google SRE Book: [Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)
- NIST SP 800-61 Rev. 2: [Computer Security Incident Handling Guide](https://csrc.nist.gov/pubs/sp/800/61/r2/final)
- OpenSSF: [SLSA Provenance](https://slsa.dev/provenance/)
