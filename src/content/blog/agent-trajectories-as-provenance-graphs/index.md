---
title: 'Agent Trajectories Should Be Provenance Graphs'
description: '为什么 Agent 可追溯性不等于保存聊天记录：从消息序列走向连接输入、能力、决策与状态变化的证据图。'
publishDate: '2026-07-24'
tags:
  - Agent
  - AI Engineering
  - Provenance
  - Observability
  - Systems
language: '中文'
comment: true
---

> Agent Trajectory 不应该只是一串消息和 Tool Call，而应该是一张能够解释结果来源、执行依据与状态变化的 Provenance Graph。

排查普通服务故障时，我通常先看日志：哪个请求失败、异常从哪里抛出、数据库返回了什么。程序路径相对固定，日志里的时间线往往足以定位问题。

Agent 系统不太一样。

同一个用户目标可能产生不同计划；一次 Tool Result 会改变下一轮推理；子 Agent 可以并行工作；Capability 和 Policy 可能在任务之间更新；最终答案正确，也不代表中间没有越权读取或错误写入。

于是“把聊天记录和 Tool Call 全部保存下来”看起来像最直接的可观测方案。它确实比只保存最终答案更好，却仍然缺少一些关键关系：

- 最终结论具体用了哪份输入和哪个 Tool Result？
- 某次写入是哪个候选行动经过哪条 Policy 后提交的？
- 子 Agent 的结果有没有在父任务取消后才返回？
- 同名 Skill 当时解析到哪个不可变 Snapshot？
- 一个外部状态是本次执行创建的，还是运行前已经存在？
- 日志中没有出现的事件是没有发生，还是记录链路丢失？

这些不是单纯的时间线问题，而是来源、派生、委托与责任问题。

这让我逐渐形成一个判断：

> **An Agent trajectory is not a transcript. It is a provenance graph.**
>
> Agent 轨迹不是一份对话抄本，而是一张来源与因果证据图。

这里的 Provenance 不是声称能够读取模型隐藏的“真实思维”，也不是把所有内部状态永久保存。它关注系统能够验证的事件：哪些输入进入了哪个活动，活动代表谁执行，使用了什么能力版本，产生了哪些结果，以及哪些结果跨过 Commit Boundary 改变了外部状态。

## Transcript、Trace 与 Provenance 回答不同问题

三者经常被混用：

| 表示 | 主要结构 | 擅长回答 |
|---|---|---|
| Transcript | 按时间排列的消息 | 用户和 Agent 说了什么？ |
| Trace | Span 的父子关系与时序 | 请求在哪个组件耗时或失败？ |
| Provenance Graph | Entity、Activity、Agent 及派生关系 | 结果从哪里来、由谁基于什么产生？ |

一个 OpenTelemetry Trace 可以告诉我：

```text
turn span
├── model call  2.1s
├── tool call   0.8s
└── model call  1.7s
```

但如果 Tool Call 读取了三个文档，只引用其中一个生成报告，普通 Span 并不会自动表达“报告由文档 A 派生、与文档 B 无关”。如果模型并行发起两个工具，完成顺序也不等于数据依赖顺序。

Transcript 适合回看交互，Trace 适合性能与控制流，Provenance 用来解释工件、决策和状态的来源。实际系统需要把它们关联，而不是选择其中一个替代全部。

## 为什么消息列表表达不了 Agent 的真实结构

最简单的 Agent Loop 通常保存：

```text
User message
Assistant tool call
Tool result
Assistant response
```

当执行包含并行和子任务时，结构很快变成图：

```text
                    ┌→ web search ─→ source A ─┐
user request ─→ plan                           ├→ synthesis ─→ report
                    └→ file read  ─→ source B ─┘

plan ─→ sub-agent ─→ draft ────────────────────┘
```

线性序列必须人为选择一种排列。按开始时间、完成时间或写入日志的时间排序，都可能掩盖实际依赖。

更复杂的是状态提交：

```text
draft
  ↓ policy decision
approved candidate
  ↓ publish tool
external artifact v2
```

最终 `artifact v2` 不只由 `draft` 派生，也依赖授权决策、目标资源的旧版本、执行者身份和 Tool 实现。把它们压成一条文本日志，很难支持反向查询。

## Provenance Graph 的最小词汇

[W3C PROV](https://www.w3.org/TR/prov-overview/) 使用三类核心概念：

- **Entity**：数据、文档、配置、模型响应、Capability Snapshot、外部状态版本。
- **Activity**：模型调用、Tool 执行、评测、审核、状态提交。
- **Agent**：用户、软件 Agent、服务账户、组织或负责的执行主体。

常见关系包括：

```text
Activity used Entity
Entity wasGeneratedBy Activity
Activity wasAssociatedWith Agent
Entity wasDerivedFrom Entity
Activity wasInformedBy Activity
Agent actedOnBehalfOf Agent
```

把它映射到一次 Agent 执行：

```text
(user request) Entity
        ↓ used
[planning] Activity ← wasAssociatedWith ─ (agent instance) Agent
        ↓ generated
(candidate tool call) Entity
        ↓ used
[policy evaluation] Activity
        ↓ generated
(allow decision) Entity
        ↓ used
[file write] Activity
        ↓ generated
(artifact version 7) Entity
```

这张图不需要把模型每个 Token 都表示为节点。粒度应该围绕可验证边界：输入快照、模型响应、Tool Call、Policy Decision、外部状态版本和提交结果。

## 时间先后不是因果关系

日志常让人产生一个错觉：事件 B 紧跟在 A 后面，所以 B 由 A 导致。

假设并行执行：

```text
T1: search result A arrives
T2: file result B arrives
T3: model produces report
```

仅从时间看，报告发生在 A 和 B 之后。但模型请求的实际上下文可能只包含 B，A 因超时被丢弃；或者报告使用的是此前缓存的 C。

Provenance 关系应该由执行器在构造输入时记录：

```text
model-call-3 used:
  message:user-1
  tool-result:file-B
  capability-resolution:72cd…
  policy-profile:b519…
```

“used” 是系统知道某 Entity 被提供给 Activity；它仍不必然证明模型在语义上依赖了其中每句话。更强的 `wasDerivedFrom` 应谨慎使用，最好由确定性转换、显式引用或验证器支持。

因此 Provenance 图也有证据强度：

```text
observed input      系统确认数据进入活动
declared citation   模型或组件声明使用了来源
verified derivation 确定性转换或验证器确认关系
inferred relation   分析器根据行为推断
```

如果不区分，图会把推测伪装成事实。

事件 Envelope、稳定身份、乱序投影和因果边的具体设计，整理在 Note：
[Agent Provenance：事件模型、稳定身份与因果边](/notes/agent-provenance-event-model-identity-causality)。

## 模型调用应该记录什么，而不是记录“思维”

可追溯性不要求保存隐藏 Chain-of-Thought。系统真正能稳定记录的是模型调用边界：

```text
Model Activity
├── model identity / observable revision
├── sampling configuration
├── input message/entity references
├── exposed tool schemas and capability resolution
├── policy/harness version
├── response entity digest
├── token / latency / cost metadata
└── finish reason and error
```

这些信息可以回答：模型看到了什么、能够选择什么工具、返回了什么可观察响应。它不能证明内部是怎样推理的，也不应该声称可以。

如果为了调试保存 Prompt 和 Response 全文，还要处理 Secret、用户隐私、第三方数据和保留期限。更合理的设计是把图中的身份与敏感 Payload 分开：图保存 Entity ID、Digest、分类和受控引用，正文放在有权限与生命周期管理的存储中。

## Tool Call 需要连接意图、授权和后果

很多 Trace 只保存：

```json
{"tool": "write_file", "status": "success", "duration_ms": 84}
```

但从可追溯角度，一次有副作用的 Tool Call 至少跨越三个阶段：

```text
Candidate Action
    ↓ authorization
Authorized Invocation
    ↓ execution
State Transition
```

对应关系可以是：

```text
candidate-call entity
  ├── wasGeneratedBy model activity
  ├── usedBy policy activity
  └── invalidated / authorized by decision entity

tool activity
  ├── used authorized invocation
  ├── used resource version 6
  ├── wasAssociatedWith service principal
  └── generated resource version 7
```

这样才能回答：模型提出了什么，系统允许了什么，工具真正改变了什么。三者可能不同——Policy 可以收窄参数，Tool 可能部分失败，外部服务也可能返回与预期不同的状态。

这正是 Blog 1 中 `Model proposes; the execution harness commits` 的证据形式。

## Capability Supply Chain 怎样进入执行图

Blog 2 讨论了 Capability Snapshot、Resolution 与评测 Attestation。它们不能停留在 Registry；运行时需要把供应链身份带入 Trajectory：

```text
Capability Snapshot ─┐
Dependency Resolution ├→ loaded by → Agent Turn
Evaluation Attestation┘
                              ↓
                         Model / Tool Activities
                              ↓
                         External Artifacts
```

如果一次事故来自某个被撤销的传递依赖，平台可以查询：

```text
revoked snapshot
  → included in which resolutions
  → loaded by which runs
  → influenced which activities
  → generated which artifacts
```

这比“搜索日志里是否出现 Skill 名称”更可靠，因为名称可变、可能重名，也无法识别间接依赖。

供应链 Provenance 与执行 Provenance 在 Resolution ID 处连接：前者解释能力从哪里来，后者解释能力被怎样使用。

## 子 Agent 需要委托关系，而不只是 parent_id

`parent_id` 可以构造任务树，但不能完整表达委托：父 Agent 给了子 Agent什么目标、上下文和权限？子 Agent 的结果何时被父 Agent 接受？

一条委托边可以携带：

```text
Delegation
├── delegator / delegatee
├── task specification entity
├── visible input entities
├── authority grant / policy ceiling
├── capability resolution
├── deadline / generation
└── expected output contract
```

子 Agent 生成结果后，还需要一个 Adoption Activity：父 Agent 读取并选择是否采用。子任务完成不等于它的内容影响了最终答案。

```text
sub-agent draft
      ↓ used
[adoption decision]
      ↓ generated
accepted evidence
      ↓ used
[final synthesis]
```

如果父任务取消或 generation 已变化，draft 可以存在于历史图中，但 Adoption 被拒绝，它就不会成为当前结果的祖先。这比简单把晚到结果从日志删除更诚实。

## “重放”有三种不同目标

Agent 平台常说保存 Trajectory 以便 Replay，但需要说明是哪一种：

### 1. Transcript Replay

重新展示已经发生的消息和事件。不执行模型和工具，适合审查与 UI 回看。

### 2. Deterministic Tool Replay

把记录的 Tool Result 作为 Fixture 重新喂给 Agent，检查 Harness、Parser 或 Policy 的变化。它复用旧环境输出，不证明真实外部服务仍会返回相同结果。

### 3. Live Re-execution

重新调用模型和外部工具。即使 Prompt、参数和 Seed 相同，模型服务、搜索结果、时间和外部状态也可能变化。

因此应区分：

```text
Forensic reproducibility  能否重建当时看到了什么、做了什么
Behavioral reproducibility 相同条件下是否再次产生同样行为
Environmental reproducibility 能否恢复当时外部世界
```

Provenance Graph 最直接提升的是第一种。它为后两种提供输入身份与环境描述，但不能让可变世界自动冻结。

## 外部状态必须有版本语义

如果图只说“读取了 `/project/config.json`”，之后文件改变，引用就失去意义。理想 Entity 是一个状态版本：

```text
file:/project/config.json@sha256:…
database:record/42@version:17
http-response@etag:…
capability@sha256:…
```

不是所有系统都提供版本号。此时可以记录：

- 内容摘要（允许读取内容时）；
- ETag、Last-Modified 或数据库 Revision；
- 观测时间与请求参数；
- 外部系统返回的 Request ID；
- “身份无法固定”的显式标记。

不能固定的资源不应被包装成可复现 Entity。承认证据缺口，比生成虚假的精确性更有价值。

## 图本身也需要完整性证据

如果攻击者可以删除一个失败的 Tool Call 或修改 Policy Decision，Provenance 图会成为更精致的错误叙事。

一种基础方案是对事件使用只追加存储，并让每个事件引用前序摘要：

```text
event_1 → hash_1
event_2 includes hash_1 → hash_2
event_3 includes hash_2 → hash_3
```

分支与并行可以使用 Merkle DAG 或按执行流维护多个链头，周期性把根摘要写入独立可信存储。签名和时间戳可以增强来源与防篡改证据。

但 Hash Chain 只证明“拿到的事件序列没有被悄悄修改”，不证明：

- 记录器没有从一开始就漏记事件；
- Tool Server 报告的结果是真实外部状态；
- 主机没有在受控记录器之外执行操作；
- 签名密钥没有泄露。

完整性机制的保证范围必须明确。高风险执行可能需要 Tool Server 自己签发结果证据，或把关键状态转换记录在事务系统中，而不是只信任 Agent Host 的日志。

## Provenance 与隐私存在天然张力

图记录越完整，越可能暴露：

- 用户 Prompt 和文件内容；
- 内部资源名称与组织结构；
- Tool 参数、Token 或凭证；
- 模型推断出的敏感属性；
- 审批者和操作人员身份；
- 外部服务返回的受版权保护内容。

因此“全量永久保存”不是成熟设计。可以采用分层存储：

```text
Graph metadata      较长保留：ID、类型、时间、关系、摘要、分类
Operational payload 较短保留：Prompt、Response、Tool Result
Secrets             不进入记录，写入前确定性脱敏
Audit evidence      按合规需求受控保留
```

访问控制也需要图感知：有权查看一次 Run 的概要，不等于有权读取它引用的所有 Entity Payload。跨租户查询必须在每个节点和边上保持授权边界。

当用户要求删除数据时，内容寻址会带来额外问题：Digest 可能仍被视为个人数据，多个 Run 也可能共享同一 Payload。删除策略需要区分图结构、内容对象、法律保留和不可逆外部审计要求。

## Redaction 之后如何保留图的解释力

直接删除敏感节点会让图断裂：

```text
input → [redacted] → report
```

可以保留一个受控的 Tombstone：

```json
{
  "entityId": "entity:…",
  "type": "redacted-input",
  "digest": "sha256:…",
  "classification": "confidential",
  "redactionReason": "retention_expired",
  "payloadAvailable": false
}
```

它证明图中曾存在一个输入，并保留关系与完整性检查，但不再提供内容。是否保留 Digest 需要根据威胁模型决定：低熵敏感值可能被字典攻击反推出原文，可以使用带域分离的 keyed digest 或完全移除摘要。

Redaction 事件本身也应进入 Provenance：由谁、依据什么 Policy、在何时删除了什么类型的数据。

Hash/Merkle 完整性证据、Payload 分层、加密擦除和保留状态机的具体设计，整理在 Note：
[Trajectory 完整性、Redaction 与保留策略](/notes/trajectory-integrity-redaction-retention)。

## 从事件流构造图，而不是让模型自报

模型可以生成引用和解释，但不应成为系统 Provenance 的唯一来源。更可靠的事件产生点包括：

```text
Context Builder   记录哪些 Entity 被放入模型请求
Model Gateway     记录调用身份与可观察响应
Tool Router       记录候选调用与 Tool 绑定
Policy Engine     记录授权决策及版本
Tool Runtime      记录实际执行与结果
State Store       记录原子状态版本变化
Task Registry     记录委托、取消与 Adoption
Capability Loader 记录 Resolution 与快照验证
```

这些组件各自只声明自己能够观察到的事实。图构建器用稳定 ID 和 Trace Context 把事件连接起来。

模型生成的“我使用了文档 A”可以作为 declared relation 保存，但要与系统确认的 `Context Builder included A` 区分。

## 图查询比更长的日志更有价值

一旦关系被结构化，可以回答具体问题：

### 结果解释

```text
这个报告的所有输入祖先是什么？
哪些来源由模型声明引用，哪些由验证器确认？
```

### 事故分析

```text
哪个 Policy Decision 允许了这次外发？
当时使用的 Policy 与 Tool 实现版本是什么？
```

### 供应链影响

```text
被撤销 Snapshot 出现在哪些 Resolution？
这些 Run 产生了哪些仍对外可见的 Artifact？
```

### 生命周期审计

```text
哪些子 Agent 在父任务取消后仍执行了 Tool？
它们的结果是否被后续 Turn Adoption？
```

### 数据治理

```text
某个用户 Entity 派生出了哪些缓存、报告和评测样本？
删除请求影响哪些 Payload 与下游 Artifact？
```

如果数据模型无法支持这些查询，保存再多原始日志也不一定形成可追溯性。

Replay Manifest、事故 Causal Cone 与供应链影响查询的具体设计，整理在 Note：
[Trajectory Replay、事故分析与供应链影响查询](/notes/trajectory-replay-incident-impact-analysis)。

## Provenance 也不能被用来假装确定性

一张细致的图容易制造“系统完全知道为什么模型这样做”的错觉。但图只能表达可观察关系与声明：

- 输入进入了上下文，不代表模型语义上使用了它；
- 两个节点存在派生边，不代表它是唯一原因；
- 模型给出引用，不代表引用支持该结论；
- 重放得到相同答案，不代表未来仍稳定；
- 图完整，不代表每个外部组件都诚实。

成熟的 Provenance 应保留不确定性：关系类型、证据来源、置信或验证状态，以及已知缺口。

> 可追溯性的目标不是把概率系统伪装成确定性程序，而是让不确定行为留下足够准确的证据边界。

## 我认为值得保留的设计原则

### 1. 记录可验证边界，不追求保存隐藏思维

输入快照、可观察响应、Tool Call、Policy Decision 和状态提交比“解释模型内心”更可靠。

### 2. 用图表达因果候选，用时间线表达发生顺序

二者都需要，但不能互相替代。

### 3. 把候选行动、授权调用和实际后果分成不同节点

模型意图、系统许可与现实结果并不总是一致。

### 4. 供应链身份必须进入运行 Trace

Capability Snapshot 与 Resolution 是连接发布证据和执行后果的桥。

### 5. 明确关系的证据强度

observed、declared、verified 与 inferred 不应混成同一种边。

### 6. Payload 与图身份分离

支持最小化存储、分层权限、Redaction 和不同保留期。

### 7. Replay 要说明复现的是什么

取证重建、固定 Fixture 重放和真实重新执行具有不同保证。

### 8. 完整性机制也要声明边界

Hash 与签名防止部分篡改，不证明记录器没有漏记，也不证明外部世界真实。

## 结语

Agent 的价值来自它能够根据上下文动态决定路径。可也正因为路径不是预先写死的，系统不能只保留最终答案或一串难以查询的日志。

Blog 1 的 Commit Boundary 讨论“哪些候选行动可以真正产生后果”；Blog 2 的 Capability Supply Chain 讨论“这些行动能力从哪里来”；Provenance Graph 则把两者连接到一次具体执行中：哪个能力版本，在什么上下文与 Policy 下，通过哪些活动，生成了哪个外部状态。

它不会让模型变得确定，也不能自动证明一个答案正确。它提供的是更现实的东西：当系统成功、失败、越权或被撤销时，我们不必只相信一段事后叙述，而有机会沿着证据关系找到来源和影响范围。

我现在更愿意用这句话概括 Agent 可追溯性：

> **A useful trajectory does not merely replay what happened; it preserves enough provenance to ask what a result depended on, who authorized it, and what it changed.**
>
> 有价值的轨迹不只是重放发生了什么，而是保留足够的来源证据，让我们追问结果依赖什么、由谁授权，以及改变了什么。

后续适合拆成三篇 Notes：Provenance Graph 的事件模型与稳定身份；Trajectory 完整性、Redaction 与保留策略；以及从图到 Replay、事故分析与供应链影响查询。

## 参考资料

- W3C, [PROV Overview](https://www.w3.org/TR/prov-overview/)
- W3C, [PROV-DM: The PROV Data Model](https://www.w3.org/TR/prov-dm/)
- OpenTelemetry, [Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- in-toto, [Attestation Framework](https://github.com/in-toto/attestation)
- SLSA, [Provenance](https://slsa.dev/provenance/)
- AgentTrails, [A Framework for Execution-Trace-Based Evaluation of LLM Agents](https://arxiv.org/abs/2607.18816)
- Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
