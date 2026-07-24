---
title: 'Trajectory Replay、事故分析与供应链影响查询'
description: '把 Provenance Graph 用于可控重放、事故证据收集和供应链影响分析，并明确因果与反事实推断的边界。'
publishDate: '2026-07-24'
tags:
  - Agent
  - Provenance
  - Replay
  - Incident Analysis
  - Supply Chain
language: '中文'
status: '待补充'
---

> 核心结论：Replay 是一项带环境边界的实验，不是“重新播放日志”；图上的祖先是调查候选，不自动等于根因；供应链影响分析必须从被撤销内容一路追到真实执行和仍存在的外部后果。

## 先定义 Replay 想回答什么

“把这次 Agent Run 重放一下”可能代表完全不同的请求：

```text
Review        按原顺序查看当时记录
Reconstruct   重建当时可观察的输入、决策与状态
Regression    用旧输入/Tool Fixture 测试新 Harness 或 Capability
Re-execute    再次调用真实模型与外部工具
Counterfactual 假设换一个模型/Policy/Capability，结果会怎样
```

如果不先选目标，系统很容易把 Transcript UI 叫作 Replay，或把一次真实重执行的不同结果误判为 Provenance 不完整。

可以定义四种模式：

| 模式 | 模型 | Tool | 外部写入 | 主要用途 |
|---|---|---|---|---|
| Transcript | 不调用 | 不调用 | 无 | 审阅事实记录 |
| Fixture | 可调用或固定响应 | 使用记录 Fixture | 禁止 | Harness/Prompt 回归 |
| Sandbox | 真实调用 | 隔离 Tool/状态副本 | 只写 Sandbox | 行为比较与故障复现 |
| Live | 真实调用 | 真实环境 | 按新授权执行 | 人工控制的重新执行 |

Counterfactual 不是第五种执行方式，而是对 Fixture/Sandbox 实验结果的一种解释；它需要更强假设，不能因为“换 Policy 后这次没出错”就证明原事故一定由旧 Policy 单独造成。

## Replay Manifest 固定实验边界

每次 Replay 应生成 Manifest：

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

Manifest 不保证结果相同；它让差异可以归因到显式变更，而不是隐藏环境漂移。

## Transcript Replay 只重放记录，不执行行为

Transcript Replay 应从 Event/Graph 生成只读 View：

```text
00:00 User input entity registered
00:01 Model activity completed
00:01 Candidate tool call proposed
00:01 Policy allowed read
00:02 Tool attempt completed
00:03 Final response generated
```

它必须保留：

- 并行分支，而非强行压成唯一时间线；
- `observed/declared/verified/inferred` 关系区别；
- `outcome-unknown`、Gap、Redaction 和缺失 Payload；
- Candidate、Authorized Invocation 与实际 State Transition 的区别；
- 原始事件时间与 Collector 观察时间。

如果 Payload 已过期，UI 应显示 Tombstone，而不能悄悄用今天重新读取的文件代替。Transcript Replay 的目标是忠实展示证据，不是补全一个更流畅的故事。

## Fixture Replay 固定 Tool Result，但会改变什么

Fixture Replay 将原 Tool Result 作为确定输入：

```python
class FixtureToolRuntime:
    async def execute(self, invocation):
        key = canonical_invocation_key(invocation)
        return fixtures.lookup(key)
```

它适合测试：

- Context Builder 是否选择同样输入；
- Parser 或 Tool Result 规范化是否退化；
- 新 Harness 是否仍满足状态机不变量；
- Capability 指令变化是否改变下一步计划；
- Policy 是否对同一 Candidate 作出预期决策。

但 Matching Policy 很关键。以下调用是否使用同一 Fixture？

```text
search(query="agent safety", limit=5)
search(limit=5, query="agent safety")
search(query="Agent safety", limit=5)
```

可以先按 Tool Schema 规范化参数，再计算 Invocation Key：

```text
tool binding digest
+ canonical arguments
+ caller scope if relevant
+ fixture state version
```

不能只按 Tool 名称依次返回旧结果，否则调用参数已经变化仍得到“成功”响应，Replay 会掩盖行为差异。

## 有状态 Tool Fixture 需要状态机

简单的请求→响应 Map 不能正确重放：

```text
read config v1
write config v2
read config v2
```

Fixture Runtime 应维护隔离状态：

```python
class ReplayState:
    resources: dict[ResourceId, VersionedValue]

    def compare_and_set(self, resource, expected, value):
        current = self.resources[resource]
        if current.version != expected:
            raise VersionConflict()
        self.resources[resource] = value.next_version()
```

源 Run 的 State Version Entity 可以初始化 Replay Snapshot，Tool Activity 按原子状态转换在副本上执行。这样才能检测 Lost Update、重复写入和旧 generation 提交，而不是机械返回录制结果。

Fixture 也要明确是：

- **Recorded response fixture**：返回旧响应，不验证状态语义。
- **Behavioral fake**：独立实现一个简化状态机。
- **Snapshot emulator**：从真实状态快照在隔离环境运行原 Tool。

保证强度逐步增加，构建成本也上升。

## 时间、随机性和环境都是输入

Agent 行为可能依赖：

```text
current time / timezone
random seed
model sampling
environment variables
feature flags
locale
network availability
rate limit state
cache state
tool latency / completion order
```

Fixture/Sandbox Replay 应尽量显式控制它们。尤其是并发顺序：只固定随机 Seed，却让 Tool 完成顺序变化，仍可能改变模型下一轮看到的上下文。

可以用可编程 Scheduler 注入原顺序或故障：

```yaml
schedule:
  - complete: tool-call-B
    atVirtualTime: 120ms
  - timeout: tool-call-A
    atVirtualTime: 500ms
```

这不是为了声称完全复现生产，而是把某个竞争条件转化成稳定测试。

## 模型重放为什么通常不能逐 Token 相等

即使保存：

```text
prompt bytes
model name
temperature = 0
seed
```

托管模型仍可能因后端版本、并行计算、Tokenizer、Safety Layer 或服务配置变化产生不同输出。

所以回归断言应分层：

```text
Exact identity       适合确定性 Parser、Schema、State Transition
Structural equality Tool Call 类型、参数约束、引用集合
Invariant equality  未越权、未重复提交、最终状态正确
Statistical behavior 多次运行的成功率、成本和延迟分布
Semantic quality    通过确定性检查 + 受控 Judge/Human Rubric
```

要求自然语言完全相同会制造脆弱测试；只检查最终答案又会遗漏危险轨迹。

## Sandbox Replay 必须默认切断真实副作用

Sandbox 模式会真实执行更多组件，风险也更高。默认 Policy 应是：

```text
Network           deny or recorded proxy
Filesystem        copy-on-write sandbox
Database          snapshot / isolated schema
Message sending   sink to capture mailbox
Publishing        fake endpoint
Credentials       replay-specific, least authority
Clock             virtualized where possible
```

所有 Tool Binding 都需要 Replay Classification：

```text
safe_fixture
sandbox_available
live_only_requires_confirmation
not_replayable
```

未知第三方 Tool 默认 `not_replayable`，不能因为它的 Schema 看似只读就允许真实调用。

Replay 产生的新 Event/Artifact 必须使用独立 Run ID，并通过 `wasReplayOf` 关系指向源 Run，不能写回原 Trajectory。

## Live Re-execution 是新行动，不是调试操作

Live 模式可能发送消息、修改文件或发布内容。它必须作为新的 Agent Run：

- 重新取得当前用户授权；
- 使用当前 Policy，而非自动继承历史 Allow；
- 对不可逆动作再次确认；
- 使用新的 Idempotency Key / Generation；
- 明确目标资源的当前版本；
- 完整记录新的 Provenance。

历史 Run 的 Policy Decision 已绑定过去主体、资源和时间，不能作为今天执行的 Capability Token。

如果用户只想“看看当时如果再跑一次”，默认应进入 Sandbox，而不是 Live。

## Replay Diff 应比较图，而不只是最终文本

新旧 Run 可以按稳定角色对齐：

```text
Input set
Capability Resolution
Candidate actions
Policy decisions
Tool attempts and resource versions
Adopted sub-agent outputs
External state transitions
Final artifacts
Cost / latency / failures
```

一种 Diff 分类：

```text
Expected change      Manifest 中主动替换的模型/Policy/Capability
Behavioral change    相同输入下计划或 Tool Call 不同
Environmental change 外部 Fixture/状态/时间不同
Evidence gap         Payload redacted、Event missing、身份无法固定
Invariant regression 新执行违反原先满足的不变量
```

图结构不同并不自动等于退化。新版本可以少调用两个 Tool 仍产生正确结果。真正重要的是变化是否解释得通、是否跨过新的权限/状态边界、是否违反发布门禁。

## 事故分析从确定事件开始

不要从模糊问题“Agent 为什么做错了”直接搜索所有日志。先定义 Incident Anchor：

```text
unauthorized external artifact
incorrect resource version
policy violation event
late child result adopted
unexpected cost spike
user-visible wrong answer
```

Anchor 应是稳定 Entity、Activity、Decision 或 Invariant Finding ID。

随后构造调查范围：

```text
Backward causal cone  Anchor 的输入、决策、能力、委托祖先
Forward impact cone   Anchor 产生或影响的 Artifact、Run 和外部状态后代
Temporal neighborhood 同时段共享基础设施故障候选
Control baseline      相同版本/任务类别但未失败的 Runs
```

Backward Cone 用于寻找贡献因素，Forward Cone 用于控制损害。Temporal Neighborhood 只能提供相关候选，不能自动建立因果边。

## 祖先节点不等于 Root Cause

任何最终报告的祖先都可能包括用户请求、模型、Capability、Policy 和 Tool，但不能全部叫根因。

更好的分类：

```text
Necessary input      没有它活动无法按记录发生
Trigger              直接启动失败路径的事件
Contributing factor  增加失败概率或扩大影响
Control failure      本应阻止/检测问题的机制失效
Latent condition     长期存在的系统弱点
Impact amplifier     让后果扩大的权限、发布范围或缺少回滚
```

例如 Prompt Injection 文档是 Trigger，过宽外发权限是 Control Failure，缺少 Canary 是 Impact Amplifier。只把事故归因于“模型被注入”会遗漏系统为什么允许它产生后果。

Provenance Graph 提供候选关系，Root Cause Analysis 仍需要证据验证和工程判断。

## 每条调查结论需要证据级别

事故报告可以引用：

```json
{
  "finding": "external content influenced publish decision",
  "support": [
    {"edge": "edge:context-used-doc-A", "level": "observed"},
    {"edge": "edge:model-cited-doc-A", "level": "declared"},
    {"edge": "edge:output-matches-doc-A", "level": "verified"}
  ],
  "confidence": "high",
  "alternatives": ["cached context C"],
  "gaps": ["model internal attribution unavailable"]
}
```

`confidence` 不是把边分数随意相乘，而是调查者对证据链和替代解释的结构化判断。报告必须保留反证、未知与被 Redact 的证据，避免图越漂亮、结论越武断。

## Policy Decision 查询需要完整上下文

查询“谁允许了这次写入”不应只返回 `allow`：

```text
decision ID
principal / on-behalf-of chain
candidate invocation and normalized resource
policy snapshot/version
matched rules and reason codes
granted scope / expiry / generation
tool attempt that consumed the decision
before/after resource versions
```

示意图查询（伪 Cypher）：

```cypher
MATCH (artifact:Entity {id: $artifact})
      <-[:GENERATED]-(tool:Activity)
      -[:USED {role: 'authorization'}]->(decision:Entity)
      <-[:GENERATED]-(policy:Activity)
      -[:USED]->(policySnapshot:Entity)
RETURN tool, decision, policy, policySnapshot
```

查询结果还要验证 Decision 与 Tool Attempt 的主体、资源、有效期和 generation 是否一致。找到一条 Allow Edge 不代表执行正确消费了它。

## 生命周期事故需要比较取消与提交偏序

要查找“父任务取消后仍提交的子 Agent”：

```text
parent CancelRequested Event
child Tool/Commit Activity
delegation generation
result Adoption Activity
```

不能只比较墙上时钟。更可靠条件是：

```text
cancel event happens-before commit
AND commit used a grant invalidated by cancel/generation change
```

如果时钟显示 Commit 晚于 Cancel，但两者没有因果传播，可能是跨 Worker 时钟漂移；如果 State Store 的条件写明确拒绝旧 generation，则即使 Tool Attempt 晚到，也没有产生外部状态。

调查需要区分：

- Late computation：取消后仍在计算；
- Late attempt：取消后仍尝试 Tool；
- Late commit：旧任务真正改变状态；
- Late adoption：过期结果进入新上下文。

后两者通常比仅多消耗一些计算资源更严重。

## 供应链影响分析从被撤销身份开始

假设 `snapshot sha256:bad…` 被撤销。影响链不是“谁安装了同名 Skill”，而是：

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

需要区分至少四个集合：

```text
Installed     Resolution 包含 Snapshot
Loaded        Run 实际加载了 Resolution
Exercised     执行活动真正使用相关 Capability/Tool
Impacted      产物或状态存在可验证/合理的派生路径
```

如果直接把 Installed 数量当影响数量，会产生大量误报；如果只看 Tool Name，又会漏掉指令对模型计划的影响。

对于自然语言 Capability，`Exercised` 很难精确证明。Context Builder 可以证明 instructions 进入了模型上下文（observed used），模型实际是否受某句影响通常只能进一步通过引用、行为差异或人工分析判断。

## 一个影响查询的分阶段流程

### Phase 1：确定撤销对象

```text
Snapshot ID / package digest / tool binding digest
affected version range
revocation reason and severity
known malicious files/effects
```

### Phase 2：展开供应链闭包

查找包含它的 Resolution、间接依赖路径、激活环境和时间窗口。

### Phase 3：连接执行 Provenance

查找加载 Resolution 的 Runs，并根据 Context Manifest、Tool Binding 与 Activity Edge 判断 Loaded/Exercised。

### Phase 4：计算 Forward Impact Cone

追踪生成的 Artifact、状态版本、外部发布与下游派生。

### Phase 5：按风险分级

```text
P0 confirmed harmful effect
P1 exercised with sensitive authority
P2 loaded but no observed exercise
P3 installed but never loaded
```

### Phase 6：处置并记录

停止新激活、撤销 Grant、隔离 Artifact、路由回滚、通知 Owner、补充评测，并把处置活动写入新 Provenance。

## Forward Cone 必须尊重边语义

不是所有后代都同等受影响：

```text
verified derivation   确定性转换或 Store 版本链
observed use          输入被提供给活动
declared derivation   组件自报
inferred similarity   分析器推断
control-flow only     同一 Trace，但无数据依赖
```

Impact Query 应允许选择 Edge Policy：

```yaml
traverse:
  includeEvidence: [verified, observed]
  includeRelations: [used, generated, derived, adopted]
  excludeRoles: [telemetry-only]
  maxDepth: 12
  stopAt:
    - declassification-approved
    - independently-recomputed
```

“独立重新计算”是否真的切断影响链也需要证据：如果它仍读取受污染缓存，就不能作为 Stop Boundary。

## 供应链修复不止是升级版本

找到受影响 Run 后，处置可能包括：

- 禁止撤销 Snapshot 的新解析和激活；
- 将已有 Resolution 标记为受影响；
- 中止仍在运行的任务并使旧 Grant 失效；
- 重新生成或人工审核派生 Artifact；
- 删除/撤回公开发布内容；
- 轮换接触过的凭证；
- 检查被修改的共享 Skill、Memory 或配置；
- 用修复 Resolution 做 Sandbox Replay；
- 为事故路径新增 Evaluation Case 与 Release Gate。

简单把 Registry 指针改到新版本，只保护未来的新解析，不能修复已有状态。

## Counterfactual Replay 的边界

事故后常问：

```text
如果当时用了新 Policy，会不会阻止？
如果换模型，会不会仍然发生？
如果不加载 Capability X，结果会怎样？
```

可以通过 Sandbox Replay 改变单一变量：

```text
baseline manifest
candidate manifest differs only in policy P1 → P2
```

如果新 Policy 在固定 Fixture 下拒绝危险调用，可以得到：

> 在记录的候选调用与状态 Fixture 下，P2 会阻止该提交。

不能直接得到：

> 如果当时部署 P2，事故一定不会发生。

因为模型可能在收到拒绝后选择另一条路径，真实 Tool 和环境也会变化。更可靠的方法是多次运行、注入拒绝后的后续交互，并把结论限定在实验范围内。

这与因果推断中的可识别性问题一致：单条观察轨迹通常不能提供完整反事实世界。

## 从事故生成回归测试

事故闭环可以是：

```text
Incident anchor
  ↓ minimize causal subgraph
Replay bundle
  ↓ sanitize / synthesize payloads
Regression scenario
  ↓ define invariants
Evaluation suite update
  ↓ issue new evidence
Release gate
```

Minimize 的目标不是只保留“最短 Prompt”，而是保留触发路径所需的：

- 输入分类与攻击结构；
- Capability/Policy/Tool Contract；
- 必要状态版本；
- 并发/取消调度；
- 预期拒绝或状态不变量。

真实用户 Payload 应尽可能替换为保持结构的合成数据。若无法脱敏而不丢失问题，测试资产需要单独权限和保留策略。

## 查询性能需要单独的投影

Event Store 适合取证重建，不一定适合在线多跳查询。可以维护：

```text
Event Store          不可变事实源
Graph Projection     Node/Edge 查询
Run Timeline Index   UI 和时序过滤
Resolution Index     Snapshot → Resolution → Activation
Artifact Lineage     Entity ancestor/descendant 加速
Decision Index       Resource/Principal/Policy 查询
```

物化 Reachability Index 可以加速影响分析，但必须随 Redaction、Edge Evidence 升级和权限变化失效或重建。

不要为了查询性能把跨租户完整图复制到无权限 Analytics Store。离线索引也必须继承 Tenant、Classification 和 Retention Policy。

## 图查询需要预算和安全边界

一个无界 `all descendants` 查询可能遍历数百万节点，也可能成为数据外泄通道。API 需要：

- Tenant/Classification 过滤进入查询计划；
- 最大深度、节点数和执行时间；
- Edge Type/Evidence allowlist；
- Pagination 与稳定 Continuation Token；
- 查询 Purpose 和调用者审计；
- 对隐藏节点不泄露 Count/路径长度；
- 大规模事故使用受控离线 Job。

Continuation Token 应绑定 Query、Principal、Policy Version 和过期时间，防止换参数或换用户继续遍历旧授权结果。

## 一份 Incident Bundle

调查产物不应只是 Markdown 结论。可以生成不可变 Bundle：

```yaml
incident: incident:2026-071
anchor: entity:artifact:bad-v7
graphCheckpoint: sha256:...
queryPolicy: incident-query-v2

scope:
  backwardCone: artifact:sha256:...
  forwardCone: artifact:sha256:...
  evidenceGaps: artifact:sha256:...

findings:
  - id: finding:1
    classification: control-failure
    statement: old generation was accepted at commit
    evidence: [edge:..., event:..., state-revision:...]
    confidence: high

actions:
  - revoke: resolution:...
  - quarantine: entity:...
  - addRegression: suite-case:...

approvedBy: reviewer:...
createdAt: ...
```

Bundle 中只存引用和必要摘要，敏感 Payload 继续受原 Policy 控制。结论更新应生成新版本，不能悄悄覆盖旧调查报告。

## 常见失败模式

### 1. 把 Transcript UI 称为确定性 Replay

它只展示记录，没有重新执行，也不能验证当前代码。

### 2. Fixture 只按 Tool 名称匹配

参数变化仍返回旧响应，掩盖新版本的行为偏移。

### 3. 有状态 Tool 被录制响应替代

无法检测 Lost Update、版本冲突和重复提交。

### 4. Sandbox 默认允许未知网络 Tool

调试重放产生真实副作用或泄露历史 Payload。

### 5. 历史 Policy Allow 被 Live Replay 复用

过去授权被当成今天仍有效的凭证。

### 6. 只比较最终文本

中间出现越权、更多成本或错误状态，最终答案碰巧相同。

### 7. 把所有祖先称为 Root Cause

图结构替代工程判断，控制失效和影响放大因素被遗漏。

### 8. 按安装量报告供应链影响

混淆 Installed、Loaded、Exercised 与真正 Impacted。

### 9. Counterfactual 跑通一次就声称事故必然被阻止

忽略拒绝后的新计划、模型随机性和环境差异。

### 10. 修复只更新 Registry 指针

已有 Resolution、运行任务、派生 Artifact 和外部状态仍受影响。

### 11. 无界图查询直接暴露给在线 API

造成资源耗尽、跨租户遍历与关系泄漏。

### 12. 事故样本原样进入公共评测集

用户数据和内部资源结构发生二次泄露。

## 应该测试哪些不变量

1. Transcript Replay 从不调用模型、Tool 或解析当前外部资源。
2. Fixture Key 包含 Tool Binding、规范化参数与相关状态版本。
3. 有状态 Replay 保持版本条件、幂等和原子状态不变量。
4. Sandbox 对未知网络与写 Tool 默认拒绝，并使用专属凭证。
5. Replay Run 使用新身份，通过 `wasReplayOf` 关联源 Run。
6. Live Re-execution 重新授权，不复用历史 Decision/Token。
7. Diff 同时比较图结构、Policy、状态后果、成本和最终 Artifact。
8. Incident Cone 只沿允许的关系与 Evidence Level 遍历。
9. Root Cause Finding 引用证据、替代解释和已知 Gap。
10. 生命周期调查使用 happens-before/generation，而不只比较墙钟。
11. 供应链查询区分 Installed、Loaded、Exercised、Impacted。
12. 撤销 Snapshot 能追到外部 Artifact 和仍运行的 Grant/Task。
13. Counterfactual 结论明确限定 Manifest、Fixture 和重复实验范围。
14. 事故回归样本在进入 Suite 前完成来源、脱敏与权限检查。
15. 图查询预算、Continuation Token 与每跳授权不能被绕过。
16. Incident Bundle 绑定 Graph Checkpoint，后续修订生成新版本。

## 当前理解 / 结论

1. Transcript、Fixture、Sandbox 与 Live Replay 的执行保证和风险完全不同。
2. Replay Manifest 应固定可控制环境，并显式标记无法固定的依赖。
3. Tool Fixture 必须按规范调用与状态匹配，有状态行为需要状态机或隔离快照。
4. 模型回归优先比较结构与不变量，逐 Token 相等通常不是合理目标。
5. 事故调查从稳定 Anchor 构造 Backward Causal Cone 和 Forward Impact Cone。
6. 图祖先是贡献因素候选，Root Cause 仍需证据验证、对照与工程判断。
7. 供应链影响分析必须区分安装、加载、使用和产生实际影响。
8. Replay 可以验证“在这个实验边界下会怎样”，不能单凭一次运行证明真实反事实。
9. 修复应覆盖未来解析、当前运行、派生 Artifact、外部状态和回归门禁。
10. 图查询本身是受限能力，需要预算、每跳授权与审计。

它与 Blog 3 的关系可以概括为：

> Provenance Graph 的价值不在于画出一张复杂图，而在于让 Replay 有明确实验边界、让事故结论能指向证据、让一个被撤销的依赖可以追到仍然存在的现实后果。

## 待补充

- 实现 Replay Manifest、规范 Tool Fixture Key 与虚拟 Scheduler 示例。
- 构建 Backward/Forward Cone 查询和 Evidence Policy DSL。
- 用 generation 事故演示墙钟排序与 happens-before 的差异。
- 设计 Snapshot → Resolution → Run → Artifact 的影响分析索引。
- 生成带 Graph Checkpoint、Finding 与 Evidence Gap 的 Incident Bundle。

## 相关链接 / 来源

- [Agent Trajectories Should Be Provenance Graphs](/blog/agent-trajectories-as-provenance-graphs)
- [Agent Provenance：事件模型、稳定身份与因果边](/notes/agent-provenance-event-model-identity-causality)
- [Trajectory 完整性、Redaction 与保留策略](/notes/trajectory-integrity-redaction-retention)
- W3C: [PROV-DM — The PROV Data Model](https://www.w3.org/TR/prov-dm/)
- OpenTelemetry: [Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- AgentTrails: [Execution-Trace-Based Evaluation of LLM Agents](https://arxiv.org/abs/2607.18816)
- Google SRE Book: [Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)
- NIST SP 800-61 Rev. 2: [Computer Security Incident Handling Guide](https://csrc.nist.gov/pubs/sp/800/61/r2/final)
- OpenSSF: [SLSA Provenance](https://slsa.dev/provenance/)
