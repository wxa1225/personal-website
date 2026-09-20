---
title: '装进 Agent 的 Skill，后来变成了什么？'
description: '一份 Skill 开始被分享、更新和组合之后，怎样知道 Agent 实际用的是哪份内容？'
publishDate: '2026-07-23'
updatedDate: '2026-09-20'
tags:
  - Agent
  - AI Engineering
  - Skill
  - Supply Chain
  - Systems
language: '中文'
comment: true
---

如果 Skill 只是一份自己维护的 Markdown，管理起来很直观：改完试一下，不合适就用 Git 回退。

但把它分享出去以后，情况会慢慢变复杂。别人可能给它接了一个工具，又引用另一个 Skill；上游更新时，依赖也跟着变了。文件名还叫原来的名字，Agent 拿到的内容却未必是昨天那一份。

我觉得，从这一步开始，就可以借用软件包管理的思路了。版本、依赖锁定、测试记录，这些看起来有点繁琐的东西，都是为了以后能回答一个简单的问题：这次究竟跑了什么？

下面用 **Capability** 表示一组可供 Agent 使用的指令、工具和资源，Skill 是它的一种封装。这里讨论的是设计思路，不是某个已经完整实现的平台。

## 安装按钮背后，还有哪些东西

一个“生成报告”的 Skill，可能会调用搜索工具、解析文件，再把结果发布出去：

```text
report-generator
├── web-research       → network:read
├── document-parser    → files:read
└── publisher          → files:write, external:publish
```

用户看到的是一个功能名称，真正进入运行环境的却是一组依赖。只记下“安装了 report-generator”，排查问题时就会缺少很多信息：搜索工具是什么版本？发布服务有没有换过？这次使用的指令，和审核时看到的是否相同？

普通包管理器会留下 lockfile，原因也类似。版本范围表达的是“可以选哪些”，锁定记录表达的是“这一次选中了谁”。放到 Agent 里，还需要记住工具实现、权限配置，以及能够观察到的模型版本。

不一定一开始就做很重的管理系统。哪怕只是个人项目，把实际加载的内容和解析结果保存下来，也比事后猜测强。

## 先把发布的那份内容固定下来

我会先为一份 Skill 区分三样东西：说明要求的 Manifest、固定内容的 Snapshot，以及记录实际依赖选择的 Lockfile。它们的具体格式可以继续调整，但职责最好别混在一起。

比如 Manifest 可以描述这些内容：

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

这里既有“怎么做”，也有“需要什么”和“在哪些条件下试过”。如果只有操作步骤，安装的人就很难判断它需要访问什么资源，是否适合自己的运行环境。

快照则要把相关文件固定下来。审核通过后继续原地修改脚本，等于把审核过的东西换掉了；顶层版本号没变，也不能让旧结论自动适用于新内容。

所以测试、审核和发布最好都指向同一份明确的内容。评测记录可以单独存放，但需要绑定它测过的快照和运行环境。[同名 Skill 还是昨天那一份吗？](/notes/capability-manifest-snapshot-lockfile)里整理了一个可能的实现方式。

## 依赖多了，权限也会跟着变化

前面那个报告 Skill，如果同时能读工作区和向外发布，那么它就可能把读到的内容发送出去。两个工具分别看都正常，组合起来却多了一条数据流。

因此我会同时看两件事：加载了哪些依赖，以及这些依赖在当前授权下能够访问什么、修改什么。两者相关，但不能直接画等号。一个依赖可能只在测试时使用，同一个工具也可能在不同任务里拿到不同范围的权限。

子能力通常只需要完成当前调用所需的那部分授权。把父任务的整个上下文和凭证一股脑传下去，写起来省事，之后就很难判断权限到底扩到了哪里。

安装时可以分析潜在组合，执行时仍要按真实参数检查资源。文件路径和发布目标经常要到调用时才知道，不能只靠安装页面上的几枚权限标签。[权限组合笔记](/notes/capability-authority-closure-composition-risk)主要讨论的就是这个问题。

## “测试通过”还需要补上后半句话

一个 Skill 跑通了一次，可以说明这次任务完成了。要据此决定是否发布，还得知道用的什么模型、工具和初始状态，以及换一组输入以后会怎样。

我希望测试记录能补完整这句话：哪份内容，在什么环境里，对哪些样本，按什么方法，得到了什么结果。

测试也不能只看最终答案写得好不好。报告内容可能正确，中间却覆盖了别人的文件；任务可能完成了，但重试导致同一条消息发了两遍。任务质量、状态变化和权限行为需要分别检查，不能让一个总分把问题平均掉。

τ-bench 和 ToolSandbox 都是这方面可以继续读的材料。我把评测对象、重复运行和发布证据的关系放在了[另一篇笔记](/notes/capability-evidence-review-progressive-delivery)。其中一个对我很有用的提醒是：测试结论也会过期。内容没有变化，远程模型或工具环境仍然可能变。

## 更新先被发现，再决定何时使用

开发时让所有地方都跟随 `latest` 很方便，上游一改，马上就能试到。但如果每次运行都重新解析最新依赖，一次失败就很难回到当时的环境，小范围验证更新也无从谈起。

我更倾向于把发现更新和启用更新分开：

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

个人项目可以简化审核环节，但仍然值得保留旧的解析记录。出问题时，至少知道要退回哪一组内容，而不是只把最外层的版本号改回去。

审核时也不必从头读完所有文件。先看相对上次批准版本新增了什么依赖、工具、外部地址和权限，通常更容易找到值得仔细检查的地方。提示词只改了两行，背后新增了一个可执行脚本，影响可能比大段措辞调整更大。

## 撤销以后，旧任务怎么办

如果某个版本有问题，阻止新的安装只是第一步。还需要查出哪些运行加载了它、是否实际调用过相关能力，以及已经生成了哪些文件或外部产物。

直接把仓库里的那份内容删掉，会让历史记录失去参照。我会保留必要的版本身份和撤销原因，再按影响范围决定停止、隔离还是迁移已有任务。至于它已经发出去的消息、写入的文件，要另行处理，不会随着版本回滚自动消失。

这也是管理发布和管理执行需要互相配合的地方：发布系统告诉运行时哪些版本可以用，运行时记录它们实际做了什么。两边用快照和解析记录关联起来，撤销才不只是修改一个状态字段。

## 一个徽章能说明多少

签名、测试和审核都很有用，但各自能说明的事情有限。签名可以帮助确认内容来自哪个密钥，不能保证作者没有犯错；一次审核对应的是当时那份内容，也不覆盖未来版本。下载量多更不能直接当成安全结论。

所以我不太想把所有判断压成一个“可信”标签。把来源、版本、测试条件和权限范围摊开，安装的人反而更容易决定：这份 Skill 能放到什么任务里使用，哪些地方还需要隔离和观察。

Skill 的吸引力，是让一个人的工作方法更容易被别人复用。我希望这种方便能保留下来，同时在更新或失败时，还能沿着记录找到具体发生了什么。对我来说，这就是把它当作软件依赖管理的理由。

## 参考资料

- Mavroudis et al., [Skills Are Not Islands: A Systems Approach to Agentic Skill Security](https://arxiv.org/abs/2607.01136)
- Sierra Research, [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045)
- Apple, [ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities](https://arxiv.org/abs/2408.04682)
- OpenSSF, [SLSA — Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- CISA, [Software Bill of Materials](https://www.cisa.gov/sbom)
- The Update Framework, [TUF Specification](https://theupdateframework.github.io/specification/latest/)
- NIST, [Secure Software Development Framework](https://csrc.nist.gov/Projects/ssdf)
