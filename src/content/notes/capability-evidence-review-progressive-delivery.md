---
title: '一句“测试通过”，够让 Skill 上线吗？'
description: '测试结论要带上版本、环境和样本，才能判断它是否适用于下一次发布。'
publishDate: '2026-07-24'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Evaluation
  - Attestation
  - Progressive Delivery
  - Reliability
language: '中文'
status: '待补充'
---

看到一个 Skill 标着“测试通过”，我会想再点开看看：测试用的哪份内容、什么模型，失败样本在哪里？如果上线时换了工具或依赖，这个结果还适用吗？

这篇笔记想把测试结果和发布决定接起来。配置和数字都只是说明设计的例子，不对应真实产品的上线成绩。

## 先把“测过了”写成一条完整记录

下面两种写法，信息量差得很远：

```text
report-writer 测试通过

snapshot sha256:91ab…
在 resolution sha256:72cd…、model M、harness H、policy P 下，
于 suite Q@sha256:18ef… 运行 200 次，
task success = 91% [95% CI: ...]，policy violation = 0，
由 evaluator E@v3 按 protocol R 计算
```

后一种至少告诉我们测试对象、环境、样本和计算方法。要判断结果能不能支持发布，还需要知道这些条件与目标环境是否一致。

测试对象也不该只绑定最外层的 Skill 源码。在[依赖锁定笔记](/notes/capability-manifest-snapshot-lockfile)里，Snapshot 固定单份内容，Resolution 记录整组实际依赖。上游包或工具绑定变了，根文件没改，行为仍然可能变化。

远程模型如果没有可固定的版本，就记录能够获得的标识和测试时间。留出这个限制，比填一个看起来很精确但实际不存在的版本号更有用。

## 测试集和评分方法也会变

同一份输入，如果换了评分代码或 Judge Prompt，结果就不能直接当成同一种测量。样本、初始环境、评分规则和评测器版本都需要一起记录。

如果用了真实任务数据，还要处理来源、访问范围和脱敏，不能为了让评测“可追溯”，把用户正文直接复制进公开报告。发布报告可以引用受控样本的身份，而不暴露完整内容。

公开开发集方便调试，受控验证集和定期补充的挑战样本则有助于观察泛化。否则一直围着同一批题优化，分数涨了，也不一定说明遇到新任务会更稳。

## 一个总分，容易把不同问题混起来

我会分别看任务是否完成、外部状态是否正确、是否违反权限，以及耗时和成本。报告写得漂亮，不能抵消一次未经允许的发布。

这也是硬约束和质量阈值需要分开的原因。哪些违规会直接阻止发布，哪些退化允许在一定范围内观察，应该在正式运行前说清楚，而不是看完分数再挑选解释。

重复运行的指标也要分清。假设每次成功概率都是 p，并且暂时采用独立近似：

```text
pass@k = 1 - (1 - p)^k   # k 次里至少一次成功
pass^k = p^k             # k 次全部成功
```

一个问多试几次能不能至少成功一次，一个问能不能次次成功。两者都可能有用，但不能换着说。真实运行往往共享失败原因，独立假设不一定成立；报告里需要说明采样方式、重复次数和不确定性。

## 用模型评分，也要检查模型怎么评分

开放式回答很难只靠字符串匹配，模型评分能提供帮助。但评分模型也可能受措辞、长度、位置和输出中的指令影响。

能做确定性检查的部分，可以先用程序核对，比如文件是否生成、状态是否改变、引用是否存在。需要主观评价时，再结合清楚的评分标准、人工抽查和分歧样本看结果。

我不太希望最后只留下一个“Judge 认为不错”。评分过程本身也需要留下版本和方法，之后才知道分数变化来自输出，还是来自测量工具。

## 把证据交给发布系统

可以用一份 Attestation 记录“谁在什么条件下测了什么，得到了什么结果”。下面是示意结构：

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

签名能够帮助核对这份声明的来源和内容，不能保证评测设计本身合理。发布系统还要检查对象、环境、有效期和各项门槛，不能只验证签名就放行。

人工审核时，我会优先看相对上次批准版本的变化：新增依赖、工具端点、权限、脚本和失败类型。高后果场景还可以把作者、审核者和发布者的职责分开，审批应绑定具体版本，避免批准之后内容又被替换。

## 小范围上线，观察什么

离线测试通过以后，可以先做隔离重放或内部试用，再按适当范围逐步放量。Shadow 也需要隔离副作用，不能只是复制一份真实请求，让新旧版本各发一次消息。

比较新旧版本时，还得看流量是否相近。新版本接到的任务更简单，成功率自然可能更高；至少要结合任务类别、权限范围和样本量分析，而不只盯着总体平均值。

我会提前定义什么情况停止放量、什么情况回滚，以及最低需要多少观察。否则很容易在结果不明确时凭感觉继续。

## 回滚以后，已经写出的东西还在

把新请求切回旧版本，只改变之后的路由。新版本已经生成的文件、发布的内容和修改过的状态，不会自动复原。

```text
Routing rollback     新请求回到旧 Resolution
State compatibility 旧版本能否读取新版本产生的状态
Effect compensation 已产生的副作用如何处理
Forensic retention  保留失败版本的 Trace 与证据
```

因此，旧版本的依赖要保留，状态格式要能兼容，已经发生的外部操作也要有查询和补偿方式。否则界面上显示“回滚成功”，实际问题仍然留在外部系统里。

上线后的失败样本，可以在确认数据权限、完成必要处理后加入回归集。这样，生产观察才真正回到了下一次测试，而不只是积累在另一个监控面板里。

我接下来想把评测记录、差异审核和小范围发布串成一个本地演示。先验证一次环境变化能否使旧证据失效，以及一次失败能否一路追到样本和版本，再继续讨论更复杂的自动发布。

## 继续读

- [装进 Agent 的 Skill，后来变成了什么？](/blog/agent-capability-software-supply-chain)
- [同名 Skill 还是昨天那一份吗？](/notes/capability-manifest-snapshot-lockfile)
- [能读文件，也能联网，组合起来意味着什么？](/notes/capability-authority-closure-composition-risk)
- Sierra Research, [τ-bench](https://arxiv.org/abs/2406.12045)
- Apple, [ToolSandbox](https://arxiv.org/abs/2408.04682)
- Princeton et al., [AI Agents That Matter](https://arxiv.org/abs/2407.01502)
- in-toto: [Attestation Framework](https://github.com/in-toto/attestation)
- SLSA: [Provenance](https://slsa.dev/provenance/)
- Google SRE Workbook: [Canarying Releases](https://sre.google/workbook/canarying-releases/)
- Argo Rollouts: [Progressive Delivery](https://argo-rollouts.readthedocs.io/)
