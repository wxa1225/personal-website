---
title: 'Agent 出了错，为什么翻聊天记录还不够？'
description: '从一份报告追到它用过的资料、工具和授权：聊聊 Agent 执行记录里容易丢失的关系。'
publishDate: '2026-07-24'
updatedDate: '2026-09-20'
tags:
  - Agent
  - AI Engineering
  - Provenance
  - Observability
  - Systems
language: '中文'
comment: true
---

假设 Agent 生成了一份有问题的报告。打开聊天记录，能看到它搜过资料、读过文件，也调用过几个工具。但报告里的那句话来自哪份资料？写入时用了哪个版本？按时间排好的消息，未必能直接回答。

并行任务会让问题更明显。先返回的结果不一定被使用，子任务写出的草稿也不一定被采纳。只把消息接成一长串，很容易把“发生在前面”看成“导致了后面”。

我想补上的，是这些可以核对的联系：一次调用收到了哪些输入，生成了什么结果，又经过什么授权改变了外部状态。这样的来源追溯，通常叫 **Provenance**。

这篇沿着那份报告往回看，试着把需要记录的东西串起来。讨论的都是系统能观察到的事件，不涉及模型内部隐藏的思维过程。

## 日志已经很多了，还缺什么

聊天记录适合回看交互，调用链适合查耗时和失败位置。比如一份 Trace 可以清楚地展示：

```text
turn span
├── model call  2.1s
├── tool call   0.8s
└── model call  1.7s
```

但如果工具读了三份文档，模型请求最后只放进一份，普通的耗时记录不会自动替我们标出这件事。需要在组织输入的地方，明确记录“这次调用收到了哪份数据”。

报告的形成过程也很容易分叉。搜索和文件读取可以并行，另一个子任务又交来一份草稿：

```text
                    ┌→ web search ─→ source A ─┐
user request ─→ plan                           ├→ synthesis ─→ report
                    └→ file read  ─→ source B ─┘

plan ─→ sub-agent ─→ draft ────────────────────┘
```

把这些联系保存成图，方便之处在于可以从结果往回查，也可以从某份有问题的输入向后查。时间线仍然有用，只是它回答的是另一类问题。

## 先用三个概念把事情分开

[W3C PROV](https://www.w3.org/TR/prov-overview/)里的三个核心概念，可以拿来做起点：Entity 表示某份数据或状态，Activity 表示一次活动，Agent 表示为这次活动负责的主体。

放到一个写文件的例子里，旧文件和新文件是两份 Entity，写入是 Activity，执行者可能是代表用户行动的服务账户。这里的 Agent 不只指大模型。

粒度不用细到每个 token。先记录输入快照、模型响应、工具调用、授权决定和产物版本，就已经能把很多原本挤在一行日志里的事拆开。

```text
file:/project/config.json@sha256:…
database:record/42@version:17
http-response@etag:…
capability@sha256:…
```

上面这些引用带了版本信息，是因为路径本身会变化。今天的 `config.json`，不一定还是昨天读过的那份。如果外部服务无法给出固定版本，就留下可获得的 ETag、请求标识和观测时间，并明确说明哪些内容没能固定。

## 放进上下文，不等于真的支撑了结论

假设搜索 A 先返回，文件 B 后返回，然后模型写出报告。仅凭时间顺序，不能断定报告同时使用了 A 和 B。A 可能已经被丢弃，实际请求里只有 B。

因此，输入关系应该由构造模型请求的代码来记录，而不是让模型事后回忆。记录可以像这样：

```text
model-call-3 used:
  message:user-1
  tool-result:file-B
  capability-resolution:72cd…
  policy-profile:b519…
```

即使记录了 B 进入上下文，也不能据此说模型使用了 B 的每句话。模型自己给出的引用、系统观察到的输入、验证器确认的派生关系，证据强度不一样：

```text
observed input      系统确认数据进入活动
declared citation   模型或组件声明使用了来源
verified derivation 确定性转换或验证器确认关系
inferred relation   分析器根据行为推断
```

我觉得这一步很重要。一张图画得再完整，如果所有边都混成同一种“因为”，它仍然可能把猜测包装成事实。事件格式和关系证据的细节，放在[这篇笔记](/notes/agent-provenance-event-model-identity-causality)里。

## 请求、获准和真正写入，要分别记录

模型提出 `write_file`，权限检查返回允许，远程服务完成写入，这其实是三个不同的时刻：

```text
Candidate Action
    ↓ authorization
Authorized Invocation
    ↓ execution
State Transition
```

中间任何一步都可能失败。模型提了请求，不代表系统允许；系统允许了，远程调用也可能超时；超时又不一定意味着外部完全没发生变化。

所以我希望记录里能找到候选调用、授权决定、实际执行尝试，以及写入前后的状态版本。只看到一句 `write_file succeeded`，仍然不知道谁批准了它，批准的是哪个对象，重试有没有重复产生结果。

Skill 的版本也应该跟进来。某份内容在发布时有测试记录，运行时却只记了名字，两边就断开了。把快照、依赖解析结果、工具绑定和策略版本关联到当前任务，之后才查得到某次更新影响了哪些执行。

## 子任务完成了，父任务用了吗

子 Agent 交回来一份草稿，不等于主任务已经采用它。父任务可能认为它过期、内容不合适，或者在它完成前就被用户取消了。

因此，除了父子关系，我还想记录委托时给了哪些输入和权限、任务属于哪一轮，以及返回结果有没有被采纳：

```text
sub-agent draft
      ↓ used
[adoption decision]
      ↓ generated
accepted evidence
      ↓ used
[final synthesis]
```

“产出了”和“被使用了”分开以后，排查也更有针对性。旧子任务返回了结果，但系统没有让它进入新一轮上下文，这与旧结果被直接写入最终报告，显然是两回事。

同样，任务取消和实际提交的关系需要通过任务版本、授权失效和因果记录来核对，不能只比较两台机器日志上的时间戳。

## 为了排查，把所有内容永久存下来？

我不太愿意这么做。模型请求和工具响应里可能有用户文件、访问凭证或内部资源名称。保存得越完整，访问范围和删除问题就越需要认真处理。

一个比较容易继续讨论的方案，是把图里的关系和实际正文分开。关系保存必要的身份、类型和引用；正文采用独立的访问权限和保留期限。密钥之类的内容则应该尽量在进入日志之前排除。

正文到期以后，可以留下“这里曾经有一份输入、现在已经不可用”的标记，让下游关系仍然能解释。但这个标记不能再证明原来的具体内容，查询时也要如实展示缺口。

Hash 和签名同样有边界。它们能帮助发现某些修改，却不能证明记录器从未漏记，也不能保证外部服务说的每句话都是真的。低熵敏感值即使只留下摘要，也可能被猜出来，不能把 Hash 当成通用的匿名化方法。

更细的存储、校验和删除问题，整理在[日志保留笔记](/notes/trajectory-integrity-redaction-retention)里。

## 重放时，先说清楚想重放什么

看一遍旧记录，用固定工具响应测试新代码，再次调用真实模型和工具，这几种行为经常都叫“重放”。但它们的用途和后果不同。

来源图能帮助找回当时的输入与执行关系。要重复实验，还需要固定环境、工具状态和调度条件；如果重新访问外部服务，就可能读到新内容，也可能产生新的写入。即使参数一样，远程模型也未必逐字返回相同答案。

所以我更想比较的是关键行为：有没有越权、有没有重复提交、使用了哪些输入、最终状态是否满足约束。把这些和文本差异一起看，比只盯着最终回答更有帮助。[重放与事故分析笔记](/notes/trajectory-replay-incident-impact-analysis)沿着这个方向继续展开。

## 最后还是回到那份报告

有了这些记录，排查时可以从报告找到实际输入，从写入找到授权，从某个被撤销的 Skill 版本找到仍然存在的产物。答案不一定立刻出现，但下一步要查什么会清楚很多。

我也不希望为了“可追溯”先搭一张包罗万象的大图。可以先选几个确实会问的问题，检查现有事件能不能回答，再补缺失的关系。比如：这次写入是谁允许的？子任务的哪份结果进入了报告？哪份输入已经到期删除了？

对我来说，好的执行记录应该能支撑这样的追问。它不替我们做最后的因果判断，但可以让判断有材料可查，也让那些暂时不知道的地方明明白白地留在记录里。

## 参考资料

- W3C, [PROV Overview](https://www.w3.org/TR/prov-overview/)
- W3C, [PROV-DM: The PROV Data Model](https://www.w3.org/TR/prov-dm/)
- OpenTelemetry, [Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- in-toto, [Attestation Framework](https://github.com/in-toto/attestation)
- SLSA, [Provenance](https://slsa.dev/provenance/)
- AgentTrails, [A Framework for Execution-Trace-Based Evaluation of LLM Agents](https://arxiv.org/abs/2607.18816)
- Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
