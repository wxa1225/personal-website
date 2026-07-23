---
title: 'Agent Provenance：事件模型、稳定身份与因果边'
description: '从 Event Envelope 到 Entity、Activity 和 Edge，设计可处理并行、乱序、重复与迟到事件的 Agent Provenance Graph。'
publishDate: '2026-07-24'
tags:
  - Agent
  - Provenance
  - Event Model
  - Distributed Systems
  - Observability
language: '中文'
status: '已整理'
---

> 核心结论：时间戳只能帮助排列事件，不能单独证明因果。Agent Provenance 需要由执行边界产生稳定身份和显式关系，并对每条边记录它是观察、声明、验证还是推断所得。

## 先区分 Event 与 Graph Fact

系统运行时产生的是事件：

```text
model.request.started
tool.call.proposed
policy.decision.completed
tool.execution.completed
artifact.version.created
```

Provenance Graph 保存的是关于 Entity、Activity、Agent 和关系的事实：

```text
model-activity used prompt-entity
candidate-call wasGeneratedBy model-activity
tool-activity used authorization-decision
artifact-v7 wasGeneratedBy tool-activity
```

一个 Event 可以产生多个 Graph Fact；一个 Fact 也可能需要组合多个 Event 才能确认。例如 `tool.execution.started` 只能创建一个正在运行的 Activity，直到 `tool.execution.completed` 到达后，才知道它生成了哪个结果 Entity。

因此不要把消息队列中的 Event JSON 直接等同于最终图数据。二者关系更接近：

```text
Runtime Event Stream
        ↓ validate / normalize / correlate
Provenance Facts
        ↓ materialize
Graph + indexes + evidence references
```

Event 是可重放的观察记录，Graph 是从记录构造出的查询模型。

## 一份最小 Event Envelope

不同组件产生的事件需要共享一个 Envelope：

```json
{
  "schema": "agent.event/v1",
  "eventId": "evt_01J…",
  "eventType": "tool.execution.completed",
  "occurredAt": "2026-07-24T00:00:03.420Z",
  "observedAt": "2026-07-24T00:00:03.487Z",
  "producer": {
    "service": "tool-runtime",
    "instance": "worker-7",
    "version": "sha256:…"
  },
  "scope": {
    "tenantId": "tenant:…",
    "runId": "run:…",
    "turnId": "turn:…",
    "traceId": "trace:…"
  },
  "subject": {
    "activityId": "activity:tool:…"
  },
  "causationId": "evt_…",
  "correlationId": "call:…",
  "sequence": 14,
  "payload": {},
  "integrity": {
    "previousDigest": "sha256:…",
    "digest": "sha256:…"
  }
}
```

字段承担不同职责：

| 字段 | 作用 |
|---|---|
| `eventId` | 事件的幂等身份，用于去重 |
| `eventType` / `schema` | 选择验证和投影规则 |
| `occurredAt` | Producer 认为事件发生的时间 |
| `observedAt` | Collector 收到事件的时间 |
| `producer` | 谁观察并声明了这件事 |
| `scope` | 多租户与 Run/Turn 隔离 |
| `subject` | 事件主要更新的图对象 |
| `causationId` | 哪个事件直接触发了当前事件 |
| `correlationId` | 哪些事件属于同一业务交互 |
| `sequence` | 单个有序流中的局部顺序 |
| `integrity` | 检测事件链被修改或截断的材料 |

`causationId` 与 `correlationId` 不能互换。一次 Turn 中的全部事件可以共享 Correlation，但只有其中一个候选 Tool Call 直接导致某次 Policy Evaluation。

## 稳定 ID 应该由谁生成

ID 生成位置决定它能否在重试与跨服务调用中保持稳定。

一种基本规则是：

```text
业务意图 ID       在意图首次创建处生成，重试复用
执行尝试 ID       每次真实尝试生成新 ID
状态版本 ID       由拥有状态的 Store 返回
内容 Entity ID    可由内容摘要派生
事件 ID           每次不可变 Event 唯一
```

例如模型提出一个 Tool Call：

```text
invocation_id = inv_42          # 逻辑调用
attempt_id    = attempt_1       # 首次执行
attempt_id    = attempt_2       # 超时后的重试
```

如果两次 Attempt 共用一个 ID，无法区分哪次产生了副作用；如果重试又创建新的 Invocation ID，系统可能把同一逻辑意图误认为两次独立操作。

推荐把关系显式化：

```text
candidate invocation inv_42
  ├── attempt_1  timed out, outcome unknown
  └── attempt_2  succeeded
```

外部写操作还需要 Idempotency Key 或条件写入，使业务状态能够判断两个 Attempt 是否属于同一提交意图。Provenance 记录关系，但不会自动消除重复副作用。

## 随机 ID、内容 ID 与复合 ID

不同对象适合不同 ID：

### 随机或时间有序 ID

适合 Activity、Event、Run 与 Attempt。UUIDv7/ULID 一类 ID 便于索引，但可排序性不意味着因果顺序。

### 内容寻址 ID

适合不可变 Prompt Snapshot、Tool Result Payload、Capability Snapshot：

```text
entity:sha256:<canonical-bytes-digest>
```

它支持去重和完整性验证，却可能泄露低熵敏感内容是否存在；敏感 Entity 可能需要租户域分离、keyed digest 或随机 ID + 受控摘要。

### 资源版本复合 ID

适合外部状态：

```text
entity:file:<resource-id>@<version-or-digest>
entity:record:<table>/<key>@<revision>
```

资源路径不是稳定身份。重命名后逻辑资源可能相同，路径相同也可能已经被删除并重新创建。最好使用资源系统提供的对象 ID 和版本。

## Entity 是状态版本，不是可变对象名

在 W3C PROV 的语义中，Entity 表示某组固定属性。如果文件内容变化，应生成新 Entity：

```text
file logical resource
├── entity v6 sha256:aaa…
└── entity v7 sha256:bbb…
```

一次覆盖写可以表示：

```text
write activity
  used file-v6
  generated file-v7

file-v7 wasDerivedFrom file-v6
```

逻辑资源名适合作为查询维度，不能取代版本 Entity。否则图会把三个月前读取的内容与今天的文件混成同一节点。

对于无法取得版本的 HTTP 内容，可以生成 Observed Entity：

```json
{
  "entityId": "entity:observation:…",
  "resource": "https://example.com/data",
  "observedAt": "…",
  "requestDigest": "sha256:…",
  "responseDigest": "sha256:…",
  "externalVersion": null,
  "reproducibility": "not-guaranteed"
}
```

它代表“某次观测到的响应”，而不是声称 URL 永远对应这份内容。

## Activity 的开始和结束不是两个 Activity

Activity 通常跨时间发生：

```text
tool.execution.started
tool.execution.progressed
tool.execution.completed
```

这些 Event 应更新同一个 Activity，而不是创建三个图节点：

```json
{
  "activityId": "activity:tool:…",
  "type": "tool-execution",
  "status": "succeeded",
  "startedAt": "…",
  "endedAt": "…",
  "attempt": 2,
  "toolBinding": "sha256:…"
}
```

状态转换需要单调约束：

```text
planned → running → succeeded
                  ↘ failed
                  ↘ cancelled
                  ↘ outcome-unknown
```

迟到的 `started` 事件不能把已 `succeeded` 的 Activity 改回 `running`。投影器应保存事件事实，同时按状态机和版本规则计算当前 Materialized View。

`outcome-unknown` 很重要：远程请求超时只说明调用者没得到结果，不证明外部操作没有发生。

## Agent 表示责任主体，不只表示模型名字

一次执行可能涉及：

```text
user principal
  ↓ delegated to
agent instance
  ↓ acted through
service principal
  ↓ invoked
remote tool service
```

如果图只记录 `model=gpt-*`，无法回答谁授权、代表谁行动。Agent 节点可以包括：

- 用户或组织 Principal；
- Agent Runtime 实例；
- 子 Agent；
- Service Account；
- 人工 Reviewer；
- Capability Author/Publisher。

模型版本通常更适合作为 Activity 使用的 Execution Environment Entity，而不是承担全部责任关系的 Agent。

`actedOnBehalfOf` 应来自受信身份链，不能只因 Prompt 写着“代表管理员”就创建。

## Edge 需要自己的身份和证据

图关系不应只是无属性连线：

```json
{
  "edgeId": "edge:…",
  "type": "used",
  "from": "activity:model:3",
  "to": "entity:tool-result:B",
  "role": "context.tool_result",
  "evidence": {
    "level": "observed",
    "producer": "context-builder",
    "eventId": "evt:…"
  },
  "validAt": "…"
}
```

至少区分：

| 证据等级 | 含义 | 例子 |
|---|---|---|
| `observed` | 系统组件直接观察到关系 | Context Builder 确认输入进入请求 |
| `declared` | 主体声明关系 | 模型声明引用了文档 A |
| `verified` | 独立机制验证关系 | Parser 验证引用片段存在于 A |
| `inferred` | 分析器推断关系 | 时间与相似度推断可能来源 |

它们不是简单的线性可信度排名。`observed used` 证明数据被提供，`verified citation` 证明某段引用匹配；二者描述不同事实。

关系还需要 `role`。同一 Model Activity 可能使用：

```text
system instruction
user request
tool result
capability instruction
policy summary
```

没有 Role 的 `used` 边无法支持上下文与来源查询。

## 不要从 Timestamp 推导 `used`

假设：

```text
00:01 search A completed
00:02 search B completed
00:03 model C started
```

不能据此自动创建：

```text
C used A
C used B
```

Context Builder 可能因 Token Budget 只选择 B。正确来源是它构造请求时生成的 Input Manifest：

```json
{
  "modelActivity": "activity:model:C",
  "inputs": [
    {"entity": "entity:search:B", "role": "tool_result"}
  ],
  "manifestDigest": "sha256:…"
}
```

Timestamp 可以用于发现异常候选，例如一个 Activity 声称使用了未来才生成的 Entity；它不应代替显式依赖记录。

## 并行执行需要 Partial Order

分布式系统中不存在可靠的全局时钟。两个 Worker 的 `occurredAt` 可能漂移，Collector 收到顺序也会因网络改变。

Provenance 更关心 happens-before 的偏序：

```text
A → B  表示 B 因果上依赖 A
A || B 表示当前证据不能确定二者顺序
```

可以从以下关系建立偏序：

- 同一 Producer 的单调 Sequence；
- 显式 `causationId`；
- Activity `used` 生成自另一 Activity 的 Entity；
- 父任务创建子任务；
- 发送事件与接收事件之间的 Trace Context；
- 状态版本的条件更新顺序。

Lamport Clock 可以为因果相关事件提供一致排序：

```python
on_local_event:
    clock += 1

on_receive(remote_clock):
    clock = max(clock, remote_clock) + 1
```

但相同或不同 Lamport 值不能完整判断并发。Vector Clock 能表达更多因果信息，却随参与者数量增长。实际系统常结合 Trace Parent、局部 Sequence 和显式数据依赖，而不是给所有事件维护全局 Vector Clock。

## Trace Context 是关联线索，不是授权凭证

跨服务调用可以传播：

```text
trace_id
span_id / parent_span_id
run_id / turn_id
invocation_id / attempt_id
```

它们帮助 Collector 关联事件，但不应该用来证明调用有权限。攻击者可能伪造普通 Header；授权仍需经过身份认证和 Policy。

同样，一个 Span Parent 表示控制流父子关系，不自动等于 `wasDerivedFrom`。后台预取任务可能属于同一 Trace，却从未影响最终结果。

所以 Trace Edge 可以作为 Provenance 候选，只有相应执行组件能声明的事实才升级为 `used`、`generated` 或 `actedOnBehalfOf`。

## 重复、乱序和迟到是正常输入

Event Pipeline 通常只能提供 at-least-once 交付。Producer 重试、Broker Redelivery 和 Consumer 崩溃都会产生重复。

投影器应满足：

```text
apply(event)         幂等
apply(A, B)          在无依赖时尽量顺序无关
rebuild(all_events)  得到相同图
```

基本去重：

```python
def ingest(event):
    if event_store.exists(event.event_id):
        return "duplicate"

    validate_schema(event)
    verify_scope(event)
    event_store.append(event)
    projector.apply(event)
```

但如果 Producer 在重试时错误生成新 `eventId`，Collector 无法仅靠 ID 判断语义重复。需要稳定的业务 Subject ID、Attempt ID 与 Producer Sequence 辅助检测。

乱序处理示例：`completed` 先于 `started` 到达。可以先创建部分 Activity：

```json
{
  "activityId": "activity:tool:…",
  "status": "succeeded",
  "startedAt": null,
  "endedAt": "…",
  "completeness": "partial"
}
```

迟到的 Start Event 补全 `startedAt`，但不回退状态。

## 缺失事件不能被静默补成事实

假设存在 `tool.execution.completed`，却没有对应 `started`：

```text
可能原因：
1. Start Event 丢失
2. Collector 暂未收到
3. Producer 从旧版本升级，未发 Start
4. Completed Event 被伪造
```

图构建器可以创建 Gap：

```json
{
  "gapId": "gap:…",
  "expected": "tool.execution.started",
  "subject": "activity:tool:…",
  "detectedAt": "…",
  "status": "unresolved"
}
```

Gap 是可查询的一等对象。不能为了让图好看而自动推断一个虚假的 Start Event。

对于长时间未结束的 Activity，也需要区分：仍在运行、Producer 失联、Collector 缺事件、结果未知。Timeout 是观察者的状态，不等于 Activity 确定失败。

## Exactly-once Graph 不来自 Exactly-once 消息

“消息只处理一次”在跨 Broker、数据库和外部 Tool 的系统中很难端到端保证。更实用的目标是：

```text
At-least-once Event delivery
+ idempotent Event identity
+ transactional graph projection
+ idempotent external effects
= effectively-once materialized facts
```

如果 Event Store 与 Graph Store 分离，Consumer 在写图后、提交 Offset 前崩溃，会重复投影。可以采用：

- Event Store 作为 Source of Truth，Graph 可完全重建；
- Transactional Outbox 保证业务状态与 Event 原子提交；
- Graph Edge 使用稳定 ID 和唯一约束 Upsert；
- Checkpoint 只在投影事务完成后推进。

这些机制保证图事实不重复，仍不保证远程 Tool 副作用只发生一次。后者需要 Tool 协议的 Idempotency Key、条件写入或状态查询。

## 一套核心 Event 类型

不要一开始为所有日志定义 Event。围绕可验证边界，可以从小集合开始：

```text
RunCreated / TurnCreated
InputEntityRegistered
ContextManifestCreated
ModelInvocationStarted / Completed
CandidateToolCallCreated
PolicyDecisionIssued
ToolAttemptStarted / Completed
StateVersionObserved / Created
DelegationIssued / ChildResultProduced / ResultAdopted
CapabilityResolutionLoaded
RunCompleted / CancelRequested / RunTerminated
PayloadRedacted
```

每类 Event 都要回答：

1. 哪个组件有权声明它？
2. Subject ID 在重试中怎样保持稳定？
3. 它产生哪些 Node/Edge Fact？
4. 哪些字段是敏感 Payload，哪些是长期 Metadata？
5. 缺失、重复、乱序时投影怎样处理？
6. Schema 升级怎样兼容旧 Event？

如果回答不了，不应急着把普通日志包装成 Domain Event。

## Schema 演化不能原地改语义

事件是长期证据，Producer 升级后旧事件仍需重放。

安全演化原则包括：

- Event 带明确 `schema` 版本；
- 新增可选字段时定义缺省语义；
- 不改变旧字段含义；
- 删除字段通过新版本完成；
- Upcaster 从旧格式生成新投影输入，但保留原 Event；
- Graph Fact 记录由哪个 Projector 版本生成。

如果 v1 的 `success=true` 表示“请求已发送”，v2 却表示“外部状态已确认”，不能沿用同一字段。证据语义的漂移比 JSON 解析失败更危险。

## 多租户边界必须从 Event 开始

图构建后再按 Run 过滤不够。Event Envelope 需要受信的 Tenant Scope，并在：

```text
ingestion
storage partition
projection
edge creation
query
payload resolution
```

每一层保持隔离。

尤其要防止跨租户 Edge：如果一个 Event 声称 `used entity:other-tenant`，Projector 必须拒绝或进入隔离队列，不能因为 ID 存在就创建关系。

全局共享 Capability Snapshot 可以存在于公共域，但 Run 到 Snapshot 的边仍属于租户执行记录；访问公共 Manifest 不应间接暴露哪些租户使用了它。

## 一个从事件到图的投影示例

候选调用：

```json
{
  "eventType": "tool.call.proposed",
  "subject": {"invocationId": "inv:42"},
  "payload": {
    "generatedBy": "activity:model:3",
    "toolSchema": "entity:tool-schema:abc",
    "argumentsDigest": "entity:args:def"
  }
}
```

Policy 决策：

```json
{
  "eventType": "policy.decision.issued",
  "subject": {"decisionId": "decision:9"},
  "causationId": "evt:proposal",
  "payload": {
    "invocationId": "inv:42",
    "outcome": "allow",
    "policy": "entity:policy:b519",
    "grant": "entity:grant:781a"
  }
}
```

Tool 完成：

```json
{
  "eventType": "tool.execution.completed",
  "subject": {"activityId": "activity:tool:77"},
  "correlationId": "inv:42",
  "payload": {
    "attemptId": "attempt:1",
    "usedDecision": "decision:9",
    "usedResource": "entity:file:v6",
    "generatedResource": "entity:file:v7",
    "status": "succeeded"
  }
}
```

投影结果：

```text
candidate inv:42 wasGeneratedBy model:3           [observed]
policy-eval:9 used candidate inv:42               [observed]
decision:9 wasGeneratedBy policy-eval:9           [observed]
tool:77 used decision:9                            [observed]
tool:77 used file:v6                               [observed]
file:v7 wasGeneratedBy tool:77                     [observed]
file:v7 wasDerivedFrom file:v6                     [declared/verified by store]
```

最后一条边的证据取决于 State Store：如果它确认 v7 是基于 v6 条件写入，可以标为 Verified；如果只是 Tool 自报，应保留较弱来源。

## 应该测试哪些不变量

1. 同一 `eventId` 重放任意次数不会产生重复 Node/Edge。
2. 无因果依赖的 Event 调换到达顺序后得到相同最终图。
3. `completed` 先到不会因迟到的 `started` 回退 Activity 状态。
4. Invocation 与 Attempt 身份分离，重试不会覆盖首次未知结果。
5. 可变资源每个版本拥有独立 Entity。
6. `used` 边只由实际构造输入或执行的组件产生，不由 Timestamp 推断。
7. 每条 Edge 保存类型、Role、Producer 和 Evidence Level。
8. 缺失必要事件会生成 Gap，而不是伪造事实。
9. 跨租户 Subject/Entity 关系在投影前被拒绝。
10. 旧 Schema Event 经 Upcaster 后仍保持原语义和来源。
11. 从 Event Store 完全重建 Graph 得到相同稳定 ID 与查询结果。
12. Trace Context 被伪造时不会获得身份或授权。

属性测试适合随机打乱事件、插入重复与生成迟到序列；故障注入适合覆盖 Producer 崩溃、Collector 超时和投影事务中断。

## 当前理解 / 结论

1. Event 是运行时观察，Graph Fact 是经验证与关联后的查询表示。
2. 逻辑 Invocation、执行 Attempt、状态版本和 Event 必须使用不同身份。
3. Entity 表示固定状态版本，可变对象名只适合作为逻辑资源索引。
4. Activity 的生命周期由多个 Event 描述，状态投影需要保持单调。
5. Edge 是带 Role、来源和证据等级的一等数据，而不只是两个 ID。
6. 显式输入清单与状态版本建立因果；Timestamp 只提供时序线索。
7. 并行系统需要偏序，Trace Parent 与局部 Sequence 比虚假的全局顺序更可靠。
8. 重复、乱序、迟到和缺失是正常输入，Graph Builder 必须显式处理。
9. Event Store 应是可重建 Source of Truth，Graph 是幂等 Materialized View。
10. Provenance 的可信度取决于谁有权声明哪类 Event，以及其保证边界。

它与 Blog 3 的关系可以概括为：

> Blog 提出 Trajectory 应该是一张 Provenance Graph；Event Envelope、稳定身份与证据边则决定这张图是在记录事实，还是只把日志重新画成了节点和箭头。

## 待补充

- 定义 Agent Provenance Event v0 的 JSON Schema 与 Upcaster。
- 实现支持重复、乱序和迟到事件的内存 Graph Projector。
- 为 Edge Evidence 设计 observed/declared/verified/inferred 查询规则。
- 比较 UUIDv7、ULID 与内容寻址 ID 的隐私和索引权衡。
- 将 OpenTelemetry Trace Context 映射为控制流候选边，而非直接因果边。

## 相关链接 / 来源

- [Agent Trajectories Should Be Provenance Graphs](/blog/agent-trajectories-as-provenance-graphs)
- W3C: [PROV-DM — The PROV Data Model](https://www.w3.org/TR/prov-dm/)
- W3C: [PROV-N](https://www.w3.org/TR/prov-n/)
- OpenTelemetry: [Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- W3C: [Trace Context](https://www.w3.org/TR/trace-context/)
- Lamport, [Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
- Kleppmann et al., [Local-First Software: You Own Your Data, in spite of the Cloud](https://www.inkandswitch.com/local-first/)

