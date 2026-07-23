---
title: 'Capability 评测证据、审核与渐进发布'
description: '把一次测试结果变成可追溯发布证据，并设计差异审核、发布门禁、Shadow、Canary 与自动回滚。'
publishDate: '2026-07-24'
tags:
  - Agent
  - Evaluation
  - Attestation
  - Progressive Delivery
  - Reliability
language: '中文'
status: '已整理'
---

> 核心结论：`passed` 不是 Capability 的永久属性，而是一条有作用域的证据。它必须绑定不可变快照、依赖闭包、模型、Harness、Policy、评测集与统计方法；发布系统只能在证据适用于目标环境时使用它。

## “这个 Skill 测过了”缺少哪些信息

下面两句话看起来都在描述质量：

```text
report-writer 测试通过

snapshot sha256:91ab…
在 resolution sha256:72cd…、model M、harness H、policy P 下，
于 suite Q@sha256:18ef… 运行 200 次，
task success = 91% [95% CI: ...]，policy violation = 0，
由 evaluator E@v3 按 protocol R 计算
```

第一句几乎无法用于发布决策。它没有说明测试对象、运行环境、样本、指标、重复次数和判定方法。第二句才接近一条可以验证作用域的证据。

评测记录至少要绑定：

```text
What        Capability Snapshot + Resolution
Where       Model + Harness + Tool bindings + Policy
Against     Dataset / scenarios + evaluator
How         Sampling config + repetitions + metric protocol
Result      Scores + failures + confidence / uncertainty
Who         Runner / builder identity
When        Timestamp + evidence validity policy
```

任何一个关键维度变化，都不应自动继承旧结论。

## Capability 的“测试对象”是 Resolution，不只是源码

Note 1 区分了 Snapshot 与 Resolution：前者固定单个 Capability 的内容，后者固定完整传递依赖和 Tool 绑定。

如果只对根 Snapshot 签发测试结论，会出现：

```text
root snapshot unchanged
dependency B: 2.1 → 2.2
tool server implementation: image A → image B
model: revision X → revision Y
```

根内容没有变，行为面已经变化。因此一次完整 Evaluation Run 的 Subject 至少包括：

```json
{
  "rootSnapshot": "sha256:91ab…",
  "resolutionId": "sha256:72cd…",
  "model": {
    "provider": "…",
    "id": "…",
    "revision": "…"
  },
  "harness": "sha256:5f20…",
  "policyProfile": "sha256:b519…",
  "toolBindings": "sha256:0c41…"
}
```

无法固定的远程模型或 SaaS 应明确记录可获得的服务版本与测试时间，而不是伪造一个并不存在的不可变身份。

## 评测集本身也属于供应链

如果 Dataset、Judge Prompt 或评分代码可以原地修改，同一个“suite v1”就能产生不同结果。评测对象需要不可变身份，评测工具也需要版本化：

```text
Evaluation Suite
├── case manifest
├── input fixtures
├── initial environment state
├── expected invariants
├── fault injection plan
├── judge prompt / rubric
├── deterministic checkers
└── metric implementation
```

Suite Snapshot 应覆盖以上内容。涉及真实用户数据时，还需要记录数据来源、同意、脱敏方式、访问范围和保留策略，但不能把敏感样本直接复制进公开 Attestation。

测试数据泄漏也会扭曲结论。如果 Capability 作者能够看到全部隐藏测试并针对固定答案优化，得分反映的可能是记忆测试集，而非泛化。可以保留：

- 公开开发集，用于调试；
- 受控验证集，用于发布门禁；
- 定期轮换的挑战集，用于检测过拟合；
- 生产 Shadow 样本，用于检查分布变化。

## 不要让一个总分掩盖失败结构

Agent Capability 的发布指标至少应分层：

| 维度 | 可能指标 | 为什么单独观察 |
|---|---|---|
| Task | success rate、pass@k、pass^k | 能否完成目标、能否稳定完成 |
| State | invariant violation、partial commit | 最终答案正确不代表外部状态正确 |
| Policy | denied attempt、unauthorized success | 安全失败不能被平均分抵消 |
| Reliability | timeout、tool error、orphan task | 区分模型失败与系统失败 |
| Efficiency | tokens、latency、tool calls、cost | 提升质量可能以不可接受成本换取 |
| Quality | rubric dimensions、human preference | 自由文本往往没有单一确定答案 |
| Composition | source-to-sink finding、dependency conflict | 单体通过不代表组合安全 |

例如一个版本把任务成功率从 88% 提升到 91%，同时把未经确认的外部发布从 0 提高到 0.5%。把它们合成一个加权总分可能仍显示“升级”，但对生产发布而言，Policy Violation 应是独立的硬门禁。

因此指标需要区分：

```text
Hard invariants       违反一次即可阻止发布
Quality thresholds   达到下限才可发布
Regression budgets   相对基线不得退化超过预算
Observational metrics 暂不门禁，但持续收集
```

## `pass@k` 与 `pass^k` 回答不同问题

如果单次成功概率为 `p`，在独立近似下：

```text
pass@k = 1 - (1 - p)^k   # k 次里至少一次成功
pass^k = p^k             # k 次全部成功
```

当 `p = 0.8`、`k = 5`：

```text
pass@5 ≈ 0.99968
pass^5 ≈ 0.32768
```

二者会给出完全不同的产品判断。

- `pass@k` 适合允许生成多个候选、再由可靠验证器选择的任务。
- `pass^k` 更接近用户重复使用时的一致可靠性。

真实执行并不独立：相同模型、相同服务故障和相同环境状态会制造相关性。因此不能只用公式从一次成功率推导所有结论，仍需要设计重复运行和不同扰动条件。

还应报告样本量与不确定性。`9/10 = 90%` 和 `900/1000 = 90%` 不是同等强度的证据。对零 Policy Violation 也不能声称风险为零；它只说明在有限测试暴露下没有观察到违规。

## LLM-as-a-Judge 是测量仪器，不是事实来源

开放式输出常用模型评分，但 Judge 也存在：

- 对表达风格、长度或位置的偏好；
- 对自己生成内容的偏好；
- Prompt Injection 与不可信候选内容；
- 不同运行间的不稳定；
- Judge 模型更新造成分数漂移；
- Rubric 含糊导致评分维度混合。

更稳健的顺序是：

1. 能用确定性 Checker 的不变量，先用代码验证。
2. 用结构化 Rubric 拆分事实性、完整性、可读性等维度。
3. 固定 Judge 版本、Prompt、采样参数与输出 Schema。
4. 对顺序敏感的比较随机交换候选位置。
5. 用一部分人工标注集校准 Judge，并监控一致性。
6. 不允许被评内容指示 Judge 修改规则或泄露隐藏答案。

Judge Score 是带误差的测量值。Attestation 应记录 Judge 身份和 Rubric Snapshot，而不是只留下最终数字。

## 一份 Evaluation Attestation

Attestation 是某个身份对“在这些条件下得到这些结果”的签名声明。示意结构：

```json
{
  "predicateType": "https://capability.dev/evaluation/v1",
  "subject": {
    "resolution": "sha256:72cd…"
  },
  "predicate": {
    "suite": "sha256:18ef…",
    "environment": {
      "model": "provider/model@revision",
      "harness": "sha256:5f20…",
      "policy": "sha256:b519…",
      "tools": "sha256:0c41…"
    },
    "protocol": {
      "runsPerCase": 5,
      "temperature": 0,
      "evaluator": "checker@sha256:…"
    },
    "results": {
      "taskSuccess": 0.91,
      "policyViolations": 0,
      "p95LatencyMs": 8300,
      "meanCostUsd": 0.042
    },
    "artifacts": {
      "summary": "sha256:…",
      "failureIndex": "sha256:…"
    },
    "completedAt": "2026-07-24T00:00:00Z"
  }
}
```

完整 Trace 可能包含用户数据，不应直接公开。Attestation 可以公开聚合指标和脱敏失败索引，详细 Artifact 放在受控存储，并使用摘要维持完整性关联。

Attestation 的签名证明是谁签发、内容是否被修改；它不自动证明 Runner 没有作弊。更强的证据需要受信 CI、隔离执行环境、可验证构建或独立复核。

## Release Policy 如何消费证据

发布门禁不应只写成 `score > 0.8`。它需要验证证据是否适用于目标：

```python
def eligible_for_release(candidate, target, attestations):
    evidence = select_attestation(
        attestations,
        resolution=candidate.resolution_id,
        suite=target.required_suite,
        model=target.model,
        harness=target.harness,
        policy=target.policy,
    )

    verify_signature(evidence)
    verify_freshness(evidence, target.max_evidence_age)

    assert evidence.policy_violations == 0
    assert evidence.task_success >= target.min_success
    assert evidence.p95_latency_ms <= target.max_p95_latency
    assert regression(candidate, target.baseline) <= target.budget

    return True
```

证据选择应避免“挑最好的一次”。如果同一 Snapshot 跑了十次，只发布最高分，是一种选择偏差。平台应保留全部正式 Run，预先定义聚合方法，并区分 exploratory 与 release-qualifying Evaluation。

## Review 应该比较什么变化

审核新版本时，从头阅读所有文件既低效又容易漏掉依赖行为变化。Review Bundle 应围绕前一个已批准 Resolution 生成语义 Diff：

```text
Content diff
  instructions / scripts / resources / schemas

Dependency diff
  added / removed / upgraded snapshots

Authority diff
  requested permissions / effective closure / source-to-sink paths

Runtime diff
  model assumptions / tool bindings / harness requirements

Evidence diff
  metric regressions / new failures / suite coverage

Provenance diff
  author / source revision / builder / signatures
```

不同变化需要不同 Review 强度：

| 变化 | 建议处理 |
|---|---|
| 文案与非执行元数据 | 自动检查后轻量 Review |
| Prompt / instructions | 行为评测 + 人工 Diff |
| 新增 Tool 或权限 | 安全 Review + 新组合测试 |
| 依赖 Snapshot 更新 | 重新计算闭包与受影响评测 |
| 可执行脚本或外部端点 | 代码 / 供应链 Review |
| Policy 硬门禁退化 | 阻止发布 |

“版本只改了一行”不代表风险小。那一行如果把只读 Tool 换成发布 Tool，后果大于重排一千行文档。

## 谁审核，谁不能同时发布

对高后果 Capability，可采用职责分离：

```text
Author creates snapshot
CI signs evaluation attestation
Reviewer approves exact snapshot/resolution
Release service verifies gates and activates
```

Approval 必须绑定不可变 Snapshot 或 Resolution。若 Review 后内容变化，旧 Approval 自动失效。

审核者本人也不应通过普通评论文本决定发布。Approval 应是结构化、签名或由受控系统记录的事件，包含审核范围、Policy 版本、过期时间和 Reviewer 身份。

对于个人项目，不必模拟大型企业审批，但仍可保留关键原则：评测对象不可变；发布动作明确；失败时能回到前一 Resolution。

## 渐进发布不是把随机用户当测试集

Capability 通过离线评测后，仍可能遇到训练/测试之外的输入、真实延迟、权限配置和 Tool 状态。渐进发布用于限制未知风险，而不是替代发布前测试。

可以按风险逐级推进：

```text
Offline evaluation
        ↓
Sandbox replay
        ↓
Shadow
        ↓
Internal / allowlist
        ↓
Canary 1%
        ↓
10% → 25% → 50% → 100%
```

### Sandbox Replay

用脱敏或合成 Trace 重放旧任务，外部写操作指向隔离环境。它适合比较新旧 Resolution 的工具计划和状态结果。

### Shadow

新版本接收真实输入副本，但结果不返回用户，也不能产生真实外部副作用。它能观察分布适配，却不能完整评估需要真实交互或写入的任务。

### Internal / Allowlist

由知情用户使用，允许收集定性反馈和未覆盖失败。不能因为用户是内部人员就放松数据与权限边界。

### Canary

把少量合格流量路由到新 Resolution，同时保留稳定版本。分配单位最好是用户、会话或工作区，而不是每个 Turn 随机切换，否则同一状态流程可能跨版本。

每一阶段都需要预先定义：持续时间、最小样本、晋级条件、停止条件和负责主体。

## Canary 要比较同类流量

如果新版本只接到更简单的请求，它的成功率自然更高。发布分析需要考虑：

- 任务类型与难度；
- 用户或租户分布；
- Tool 可用性与区域；
- 输入长度与数据分类；
- 时间段和外部服务状态；
- 新旧版本是否共享缓存与状态。

可以采用稳定哈希分桶，并在桶内按任务类别分层。对低频高风险事件，仅靠 Canary 的统计检测会太慢，因此 Policy Violation、越权成功、不可逆错误等应设置为单事件触发的紧急停止条件。

## 自动回滚需要稳定旧世界

“指标下降就回滚”听起来简单，但 Capability 可能已经：

- 写入新格式的状态；
- 发布外部内容；
- 创建旧版本无法理解的 Artifact；
- 改变长期会话或 Memory；
- 触发依赖服务中的异步任务。

所以回滚至少分为：

```text
Routing rollback     新请求回到旧 Resolution
State compatibility 旧版本能否读取新版本产生的状态
Effect compensation 已产生的副作用如何处理
Forensic retention  保留失败版本的 Trace 与证据
```

不可变 Resolution 让路由回滚变得可靠，但不能撤销现实世界。发布前需要定义状态兼容策略，外部副作用则依赖幂等、补偿或人工处置。

自动回滚门槛可以包含：

- Task Success 相对基线显著下降；
- p95/p99 延迟或成本超预算；
- Tool Error、Timeout、Orphan Task 激增；
- 任何严重 Policy Violation；
- 用户撤销/纠正率明显上升；
- 新增的未知失败簇超过阈值。

## “无变化”也可能需要重新评测

Capability Snapshot 未变，并不意味着证据永远新鲜：

- 模型提供方更新了别名指向；
- 远程 Tool 行为或数据分布改变；
- Policy 版本收紧；
- Evaluation Suite 增加了新攻击样本；
- 依赖漏洞或撤销信息出现；
- 用户任务分布漂移。

因此可以设置重新认证触发器：

```text
Artifact change       必须重新评测
Resolution change     必须重新评测
Target environment change 按影响矩阵选择评测
Evidence age exceeded 定期重新评测
Incident / revocation 紧急重新评估
Distribution drift   触发挑战集与 Shadow
```

Evidence Freshness 不是简单固定 30 天。高风险外发 Capability 与本地只读格式化 Skill 可以采用不同有效期。

## 生产观测怎样回到发布系统

离线 Evaluation 与在线 Observability 不应是两套互不相干的数据。一次生产 Run 至少要关联：

```text
Resolution ID
Activation / rollout cohort
Model / Harness / Policy identity
Tool binding versions
Task class
Outcome and invariant checks
Cost / latency
Failure taxonomy
```

生产失败可以经过脱敏和人工确认后沉淀为新的 Evaluation Case：

```text
Incident
  → minimize / sanitize
  → reproduce in sandbox
  → add regression case
  → evaluate candidate fix
  → issue new attestation
```

但直接把用户 Trace 自动加入训练或公开测试集可能违反隐私和数据使用约束。Provenance 必须记录样本如何从生产事件转化为评测资产。

## 常见失败模式

### 1. Attestation 只绑定 Capability 名称

名称下内容或依赖变化后，旧测试结论仍被复用。

### 2. 只报告平均总分

严重 Policy Violation 被其他质量指标平均掉，尾部延迟与失败簇不可见。

### 3. 重复运行后挑最好成绩

发布门禁受到选择偏差影响，无法代表未来流量。

### 4. Judge 与 Rubric 没有版本身份

分数变化无法区分 Capability 变化还是测量仪器变化。

### 5. Review 只看根 Prompt Diff

依赖、Tool 实现、权限闭包或外部端点变化未被审核。

### 6. Approval 不绑定不可变对象

审核后内容可以改变，批准的是名字而非实际发布物。

### 7. Canary 每个 Turn 随机分流

同一会话跨版本，状态与结果相互污染。

### 8. 回滚只修改流量指针

忽略新版本已经写入的状态和不可逆外部副作用。

### 9. 把 Shadow 结果当成完整生产验证

Shadow 无法覆盖真实写入、用户交互和下游反馈。

### 10. Snapshot 不变就永久沿用证据

模型、Tool、Policy 和任务分布漂移后，证据已不适用。

## 应该测试哪些不变量

1. Evaluation Attestation 精确绑定 Resolution、Suite 与目标环境身份。
2. 任一正式 Run 都进入预定义聚合，不能只挑最好结果。
3. Policy Violation 等硬门禁不会被质量总分抵消。
4. Judge、Rubric 或 Checker 变化会生成新的测量身份。
5. Review 后 Snapshot/Resolution 任一变化都会使 Approval 失效。
6. 新增 Tool、权限和依赖会自动升级 Review 要求。
7. Canary 分桶在用户/会话范围稳定，并保留可比基线。
8. 严重安全事件可以单样本停止发布。
9. Routing Rollback 总能指回已验证的旧 Resolution。
10. 回滚测试覆盖状态兼容与已发生副作用，而不只检查路由。
11. 每个线上 Run 能追溯到 Rollout、Resolution 与发布证据。
12. 生产失败进入评测集前经过来源、隐私和脱敏检查。

## 当前理解 / 结论

1. `passed` 是绑定对象、环境、Suite 与协议的一条证据，不是 Capability 标签。
2. Evaluation 的 Subject 应是 Resolution 和真实运行绑定，而不只是根源码。
3. 评测集、Judge 与 Checker 自身也必须版本化和可追溯。
4. Task、State、Policy、Reliability、Efficiency 与 Composition 指标不能被一个总分完全替代。
5. Review 应围绕行为面 Diff，变化的后果比变化的行数更重要。
6. Approval 必须绑定不可变对象，并在职责分离下由发布系统验证。
7. Shadow、Canary 与分阶段激活控制未知风险，但不能替代离线评测。
8. 不可变 Resolution 支持流量回滚，却不能自动撤销状态和外部副作用。
9. 证据会因环境与数据分布变化而过期，生产观测需要反哺评测。

它与 Blog 2 的关系可以概括为：

> Snapshot 让我们知道审核了什么，Attestation 让我们知道依据是什么，Progressive Delivery 则限制判断仍可能错误时的影响范围。

## 待补充

- 定义 Capability Evaluation Attestation v0 与 JSON Schema。
- 实现 `pass@k`、`pass^k`、置信区间和失败簇的示例报告。
- 设计基于 Resolution/Authority Diff 的 Review Risk Score。
- 建立一个可本地演示的 Shadow、Canary 与自动回滚模拟器。
- 研究生产 Trace 脱敏后进入回归集的 Provenance 流程。

## 相关链接 / 来源

- [When Agent Capabilities Become a Supply Chain](/blog/agent-capability-software-supply-chain)
- [Capability Manifest、不可变快照与依赖锁定](/notes/capability-manifest-snapshot-lockfile)
- [Capability 权限闭包与组合风险](/notes/capability-authority-closure-composition-risk)
- Sierra Research, [τ-bench](https://arxiv.org/abs/2406.12045)
- Apple, [ToolSandbox](https://arxiv.org/abs/2408.04682)
- Princeton et al., [AI Agents That Matter](https://arxiv.org/abs/2407.01502)
- in-toto: [Attestation Framework](https://github.com/in-toto/attestation)
- SLSA: [Provenance](https://slsa.dev/provenance/)
- Google SRE Workbook: [Canarying Releases](https://sre.google/workbook/canarying-releases/)
- Argo Rollouts: [Progressive Delivery](https://argo-rollouts.readthedocs.io/)

