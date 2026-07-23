---
title: 'When Agent Capabilities Become a Supply Chain'
description: '当 Skill 从一段 Prompt 变成可安装、可依赖、可执行的资产，Agent 平台需要怎样的能力供应链？'
publishDate: '2026-07-23'
tags:
  - Agent
  - AI Engineering
  - Skill
  - Supply Chain
  - Systems
language: '中文'
comment: true
---

> Agent Capability 一旦能够被发现、安装和组合，就不再只是 Prompt，而是进入执行环境的软件依赖。

最开始理解 Agent Skill 时，我把它看成一种更长、更结构化的 System Prompt：写清楚任务目标，附上几条操作步骤，再让模型按说明调用工具。

在单个项目里，这种理解通常够用。Skill 和代码放在同一个仓库，由同一个人修改；出现问题时，回退一次 Git Commit 就能恢复。

但在接触包含能力管理、版本快照、依赖关系、测试状态和发布审核的 Agent 平台后，我发现问题发生了变化：当一个 Capability 可以由别人制作、被其他 Capability 依赖、安装到多个 Agent，并在更新后影响真实工具调用时，它已经具有软件包的许多性质。

然而它又比普通软件包更模糊。

一段 Python 代码通常有相对明确的入口、依赖和运行时行为；Agent Capability 可能同时包含自然语言指令、Tool Schema、脚本、知识文件、MCP Server 配置与模型约定。它的“执行”既发生在确定性程序里，也发生在概率模型的解释中。

这让我形成了一个新的判断：

> **Agent Capability management is a software supply-chain problem with a probabilistic runtime.**
>
> Agent 能力管理，是一个运行时具有概率性的软件供应链问题。

本文所说的 Capability，是 Agent 为完成某类任务而加载的一组指令、工具、代码与资源；Skill 是它的一种常见封装。重点不在命名，而在于这些资产如何从作者手中进入另一个 Agent 的执行环境。

## 复制一段 Prompt 为什么不再够用

如果一个 Skill 只是一份 Markdown，复制粘贴似乎没有太大风险。但实际能力往往沿着一条更长的链路传播：

```text
Author
  ↓
Capability source
  ↓
Dependencies / tools / resources
  ↓
Test snapshot
  ↓
Review and publication
  ↓
Resolver and installation
  ↓
Agent runtime
  ↓
External side effects
```

链路中任何一环变化，最终行为都可能改变：

- 作者修改了指令，但版本号没有变化；
- 上游依赖更新，间接改变了工具集合；
- MCP Server 保持同名，背后的实现却已替换；
- 测试使用模型 A，生产运行时换成模型 B；
- 安装时看到的是审核版本，执行时解析到的是 `latest`；
- Skill 本身无害，两个 Skill 组合后却获得了过大的权限。

于是“我安装了哪个 Skill”并不足以重建一次执行。还需要知道安装的是哪个不可变快照、解析了哪些传递依赖、绑定了哪些工具实现，以及运行时采用了什么 Policy。

普通包管理器会生成 lockfile，是因为名字和版本范围不能唯一描述真实依赖图。Agent 平台也需要类似的 **Capability Resolution Record**：不是只保存用户选择了什么，而是保存系统最终激活了什么。

Manifest、内容寻址 Snapshot 与 Lockfile 的具体设计，整理在 Note：
[Capability Manifest、不可变快照与依赖锁定](/notes/capability-manifest-snapshot-lockfile)。

## Capability 的最小发布单元应该是什么

一个可发布 Capability 至少可能包含：

```text
Manifest
├── instructions
├── input / output contract
├── required tools
├── dependency constraints
├── requested permissions
├── model / runtime assumptions
├── evaluation cases
└── provenance
```

这里最容易缺失的是后四项。

很多 Skill 会详细描述“怎样完成任务”，却没有声明它需要访问什么资源、依赖什么其他能力、在什么模型或 Harness 下验证过，以及由谁从什么源码构建。

如果缺少这些信息，Capability Registry 只能成为文件分享站：它可以分发内容，却无法让安装者判断兼容性、权限和可信度。

我更倾向于把发布对象设计成**不可变快照**：内容、依赖约束、评测结果与来源共同获得一个版本身份。`draft`、`testing`、`reviewed`、`live` 不是覆盖同一份可变对象的几个标签，而是围绕不可变快照发生的状态转换。

```text
Draft snapshot
    ↓ test
Tested snapshot
    ↓ review
Approved snapshot
    ↓ publish
Live release
    ↓ deprecate / revoke
Historical evidence remains
```

如果发布后仍可原地修改内容，那么审核结论和测试证据会悄悄指向另一份东西。供应链首先需要保证：**被审核的内容就是被安装的内容，被安装的内容就是被执行时解析的内容。**

## 版本不是 UI 上的一个数字

给 Skill 增加 `v1`、`v2` 并不自动得到版本语义。至少需要回答：

1. 什么变化构成新版本？
2. 已安装的 Agent 会自动升级，还是保持固定快照？
3. 依赖 `>=1.0` 时，何时重新解析？
4. 上游版本撤销后，已有运行是否继续？
5. 能否重建三个月前一次执行使用的完整依赖闭包？

对 Capability 来说，“兼容性”也不只是函数签名。

一段指令的措辞变化可能不改变输入输出 Schema，却改变模型选择工具的倾向；新增一个示例可能提高平均成功率，也可能让另一类输入发生退化；相同 Capability 在不同模型版本上可能表现不同。

因此语义化版本仍然有价值，但不能独自承担兼容性判断。Capability 版本还需要关联一个验证矩阵：

```text
capability snapshot
× model family / version
× harness version
× tool implementation
× policy profile
× evaluation suite
```

这并不意味着每个组合都要穷举测试，而是承认“通过测试”从来不是 Capability 自身的永久属性，而是它在某组运行条件下得到的证据。

## 依赖图也是权限图

普通依赖解析主要关心版本兼容与构建是否成功。Agent Capability 的依赖还会带来权限累积。

假设一个报告 Skill 依赖：

```text
report-generator
├── web-research       → network:read
├── document-parser    → files:read
└── publisher          → files:write, external:publish
```

即使主 Skill 的描述只是“生成报告”，它的依赖闭包已经包含向外发布的能力。用户如果只看到顶层名称，很容易把功能意图误当成实际权限。

因此安装前需要同时解析两张图：

```text
Dependency graph       Capability A depends on B and C
Authority graph        A can cause read, write, publish through B and C
```

两张图并不总是同构。Capability B 可能只在测试阶段使用；同一个工具在只读 Policy 下风险很低，在具有写权限的运行环境中后果完全不同；两个单独安全的能力组合后，可能形成“读取敏感数据 + 外发”的新路径。

这也是为什么权限不应成为安装按钮旁边的一串静态标签。平台需要计算**有效权限闭包**，并在运行时由 Execution Harness 再次强制执行。

> 依赖解析决定 Agent 具有什么能力，Policy 决定这些能力在当前任务中能产生什么后果。

依赖闭包、权限衰减与组合风险的具体分析，整理在 Note：
[Capability 权限闭包与组合风险](/notes/capability-authority-closure-composition-risk)。

## 测试一个 Capability 到底在测试什么

传统单元测试可以固定输入并断言输出。Agent Capability 面临三个额外变量：

- 模型输出具有随机性；
- 工具和环境存在状态；
- 成功通常不是一个字符串完全匹配，而是一组业务不变量。

因此“跑通一次”更像 Demo，不是发布证据。

Capability Evaluation 至少应该分成几层：

| 层 | 关注点 | 示例 |
|---|---|---|
| Contract | 输入、输出和 Tool 参数是否合法 | 缺失字段能否被拒绝 |
| Task success | 是否完成目标 | 报告是否包含要求的信息 |
| State invariants | 外部状态是否正确 | 未覆盖已有文件、未重复发布 |
| Policy | 是否遵守权限 | 不读取工作区之外的资源 |
| Robustness | 扰动下是否稳定 | 多次运行、工具失败、信息不足 |
| Composition | 与依赖组合是否产生新风险 | 读取能力与外发能力的联合测试 |

[τ-bench](https://arxiv.org/abs/2406.12045) 使用 `pass^k` 衡量 Agent 多次运行的一致成功，[ToolSandbox](https://arxiv.org/abs/2408.04682) 则把中间状态和有状态工具纳入评测。它们给 Capability 发布带来的启发是：只评最终自然语言答案，会遗漏工具顺序、状态变化和策略违规。

更重要的是，测试结果应该附着在快照上，而不是附着在名字上。`research-skill passed` 没有足够信息；`snapshot sha256:… 在 model X、harness Y、policy Z 下通过 suite Q` 才是一条可以追溯的证据。

评测 Attestation、行为面 Review 与渐进发布的完整设计，整理在 Note：
[Capability 评测证据、审核与渐进发布](/notes/capability-evidence-review-progressive-delivery)。

## Review 不能只是阅读 Prompt

对 Capability 做人工审核时，最直观的动作是打开 Markdown 看一遍。但真正的行为面可能分散在：

- 指令引用的脚本；
- 脚本调用的 MCP Tool；
- Tool 背后的远程服务；
- 传递依赖加载的资源；
- 安装和初始化阶段执行的 Hook；
- 运行时注入的环境变量与凭证。

所以 Review 应该围绕一个已解析快照，而非孤立源文件。审核者至少要看到：

```text
Source provenance
Resolved dependency tree
Requested and effective permissions
Executable files and external endpoints
Evaluation evidence
Changes since previous release
```

这里与软件供应链中的 SBOM 很相似，但 Agent Capability 还需要记录自然语言指令和模型假设。传统 SBOM 告诉我们包含了哪些组件，却不能说明一段指令如何影响 Tool 选择；纯 Prompt Review 又看不到底层代码和权限。

因此更合适的产物可能是 **Capability Bill of Materials**：同时描述内容组件、依赖、工具、权限、构建来源和评测证据。

## `latest` 是最方便也最昂贵的默认值

开发阶段使用 `latest` 很自然：作者更新 Skill，所有 Agent 立即获得改进。但生产环境中，它让三件事情同时失效：

1. **可复现性**：无法知道一次失败实际使用了哪份内容。
2. **渐进发布**：更新立刻影响全部调用者。
3. **撤销边界**：回滚时不知道哪些依赖已被间接升级。

我更认可的方式是把“发现更新”和“激活更新”分开：

```text
Registry publishes v1.4
        ↓
Consumer detects compatible candidate
        ↓
Resolve dependency and authority changes
        ↓
Run evaluation / canary
        ↓
Explicitly activate immutable snapshot
```

个人项目可以把这条流程缩短，但不应丢失快照身份。即使没有完整审批系统，至少也可以保存内容哈希和解析后的依赖版本。

## 撤销不是删除

如果一个 Capability 被发现存在恶意指令、依赖投毒或严重缺陷，平台需要撤销它。但直接从 Registry 删除会破坏审计：历史执行仍然引用它，用户也需要知道自己是否受影响。

更合理的撤销语义是：

- 阻止新的安装和激活；
- 标记受影响的版本范围和原因；
- 查找哪些 Agent 的 resolution record 包含该快照；
- 根据风险决定停止、降级或隔离已有运行；
- 保留内容身份和最小审计证据；
- 发布替代版本或迁移建议。

这与包仓库中的 yanking、证书吊销和漏洞通告都有相似之处，但 Capability 还可能已经把行为写进长期会话或生成工件。撤销未来执行并不能自动撤销过去产生的外部状态。

## Control Plane 与 Execution Harness 不应该混为一谈

Blog 1 中我把 Tool 调度、权限、状态、生命周期和执行记录称为 Execution Harness。能力供应链与它相邻，却不是同一件事。

```text
Capability Control Plane
  author → test → review → publish → resolve → revoke
                           ↓
                    immutable snapshot
                           ↓
Execution Harness
  load → plan → authorize → execute → commit → trace
```

Control Plane 回答：**哪些能力版本可以进入哪些 Agent？**

Execution Harness 回答：**一次具体运行中，这些能力可以对当前资源做什么？**

如果没有 Control Plane，Harness 得到的可能是来源不明、依赖漂移的输入；如果没有 Harness，一个经过严格审核的 Capability 仍可能在错误上下文里获得过大权限。

二者之间应该通过不可变身份连接：Harness 的 Trace 不只记录 `skill_name`，还记录 Capability snapshot、依赖解析结果、Policy profile 与 Tool 实现版本。这样一次执行才有可能被解释和复现。

## Capability 的信任从哪里来

签名、审核徽章和下载量都可以提供信号，但没有任何一个等于“安全”。

- **签名**证明内容来自某个密钥，不证明作者判断正确。
- **审核**证明某个快照按某套规则被检查过，不覆盖未来版本。
- **测试**提供特定环境下的行为证据，不保证所有输入。
- **流行度**说明很多人安装过，也可能放大供应链攻击。
- **Sandbox**限制部分后果，但无法自动解决数据泄露与授权错误。

我更倾向于把信任理解成一组可以组合、也会过期的证据：来源、可复现构建、依赖透明度、权限最小化、评测记录、人工审核与运行时隔离共同降低风险。

这是一种比“trusted / untrusted”二元标签更诚实的模型。

## 我认为值得保留的设计原则

如果要设计一个 Capability Registry 或 Skill Hub，我目前会优先保留以下原则：

### 1. 发布不可变快照，而不是可变名称

名称用于发现，快照身份用于安装、审核和执行。

### 2. 依赖解析同时计算权限闭包

安装者应该看到传递依赖带来的有效能力，而非只看顶层描述。

### 3. 测试证据绑定运行条件

模型、Harness、Tool 和 Policy 都是评测上下文的一部分。

### 4. Review 对象是解析后的行为面

不仅审 Prompt，也审脚本、工具、端点、依赖变化和权限变化。

### 5. 更新需要激活步骤

发现新版本不等于让全部 Agent 立即使用它。

### 6. 撤销保留历史身份

停止未来使用，同时仍能回答过去哪些执行受到影响。

### 7. Control Plane 与 Harness 共享 provenance

发布证据必须能一路关联到真实 Tool Call 和外部状态变化。

## 结语

Agent Skill 最吸引人的地方是降低能力复用成本：一个人整理出的工作方法，可以很快进入另一个 Agent。但复用越容易，传播错误和权限的速度也越快。

“把 Prompt 写得更清楚”无法独自解决这个问题。只要 Capability 能够加载代码、组合工具、访问资源并影响外部状态，它就需要像软件依赖一样被版本化、解析、测试、审核和撤销。

同时，它又不能被简单等同于普通软件包。模型会解释自然语言，会随运行环境变化，也可能被不受信任的 Tool Result 影响。因此 Capability 的可靠性不是一个静态认证，而是一条从发布证据延伸到执行后果的链。

我现在更愿意用这句话概括它：

> **A reusable capability is not merely something an Agent can load; it is something a system must be able to trace, constrain, and revoke.**
>
> 可复用能力不只是 Agent 能够加载的东西，也必须是系统能够追踪、约束和撤销的东西。

下一步值得继续拆开的，是两个更具体的问题：如何为 Capability 生成可验证的物料清单，以及如何把一次 Agent 执行表示成从能力快照到外部状态变化的 Provenance Graph。

## 参考资料

- Mavroudis et al., [Skills Are Not Islands: A Systems Approach to Agentic Skill Security](https://arxiv.org/abs/2607.01136)
- Sierra Research, [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045)
- Apple, [ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities](https://arxiv.org/abs/2408.04682)
- OpenSSF, [SLSA — Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- CISA, [Software Bill of Materials](https://www.cisa.gov/sbom)
- The Update Framework, [TUF Specification](https://theupdateframework.github.io/specification/latest/)
- NIST, [Secure Software Development Framework](https://csrc.nist.gov/Projects/ssdf)
