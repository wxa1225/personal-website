---
title: '能读文件，也能联网，组合起来意味着什么？'
description: '逐个看都合理的工具权限，组合后可能让数据走到意料之外的地方。'
publishDate: '2026-07-23'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Capability Security
  - Authorization
  - Composition
  - Least Privilege
language: '中文'
status: '待补充'
---

读工作区和发网络请求，单独看都是常见能力。但把它们交给同一个任务，就可能多出一条路径：工作区里的内容被发送到外部。

这也是我在看 Skill 依赖时比较在意的问题。逐个列出工具权限之后，还需要把它们接起来看，看看数据最后可能走到哪里。

## 申请过，不等于拿到了，也不等于用过

下面几件事值得分开记录：

```text
Requested → 申请了什么
Granted   → 可以调用什么
Reachable → 组合后可能造成什么
Exercised → 这一次实际做了什么
```

一个 Skill 可以申请联网，安装者只允许访问指定域名，而这次运行最后根本没发出请求。这三种记录都叫“权限”，排查时就很容易说不清。

我会把“组合后可能造成什么”再单独拿出来。它描述的是潜在路径，还不是这次运行已经发生的事实。后面的影响分析也需要保留这个区别。

## 为什么把权限合并起来还不够

假设有三个组件：读文档、做摘要、发布网页。摘要组件本身没有网络或文件权限，看起来很简单。但它处理的是读文档组件交来的内容：

```text
secret:read
    ↓ content
summarizer
    ↓ summary
network:write
```

最终发布的是摘要，也仍然可能含有原文中的敏感信息。只检查每个组件自己的权限列表，容易漏掉这条跨组件的数据流。

因此，除了读写动作，我还想知道输入来自哪里、属于什么数据类别、输出会去哪个目标。下面是一个描述效果的示意结构：

```yaml
effects:
  inputs:
    - channel: document
      classification: workspace-data
  reads:
    - resource: workspace:{workspace_id}/**
      classification: workspace-data
  writes:
    - resource: artifact:{turn_id}/**
  emits:
    - channel: result
      classification: derived-workspace-data
  externalSideEffects: []
```

这样的声明能帮助分析，但不能直接当成行为已经得到证明。组件可能写漏，工具实现也可能变化，执行时仍需要检查。

## 资源范围比一个 read 更具体

允许读当前项目的 Markdown，和允许读整个工作区，差别很大；允许发布到一个指定接口，和允许向任意域名发送数据，也不是同一件事。

授权需要同时带上主体、操作和资源范围。有时还要限制文件大小、目标域名、调用次数或有效期。只留下 `read`、`write` 两个词，等工具真正接到参数时就会缺少判断依据。

路径和 URL 的匹配也需要规范化，不能把简单字符串前缀当作所有场景下的资源边界。文件这一侧的细节，可以接着看[文件授权笔记](/notes/tool-schema-policy-mcp-file-authorization)。

## 子任务只拿这次需要的那一部分

调用依赖时，把整个 Agent 上下文传下去很省事，但也可能顺便传下了不需要的凭证和权限。

我更倾向于根据这次调用重新收窄授权：

```text
Grant(child)
  ⊆ Grant(parent)
  ∩ Request(child)
  ∩ Need(this invocation)
  ∩ OrganizationPolicy
```

这里的交集是约束思路，不意味着资源范围都能用简单字符串集合完成计算。比如“只能发布到这个站点的某个栏目”，需要真正理解资源语义。

跨服务传递时，可以用受验证的授权凭证表达范围。下面仍是一份示意：

```json
{
  "subject": "agent:child-17",
  "audience": "mcp:file-server",
  "operations": ["read"],
  "resource": "workspace:42/input/*.md",
  "turn": "turn:9c…",
  "generation": 4,
  "expiresAt": "2026-07-23T15:04:05Z",
  "delegationDepth": 0,
  "policyVersion": "sha256:…",
  "nonce": "…"
}
```

接收方需要验证来源、受众、过期时间和撤销状态，而不能只相信参数里写着某个用户 ID。服务端拥有更大的技术权限，也不应该把它自动借给每个调用者。这正是 Confused Deputy 问题容易出现的地方。

## 安装时看可能性，执行时看实际参数

安装时可以发现“读取私有数据后还能外发”这样的潜在路径，也可以确定授权上限。但实际读取哪个文件、发往哪个地址，经常只有执行时才知道。

所以这两次检查各有作用：前者帮助决定是否接受这组能力，后者判断当前这次调用是否仍在允许范围内。策略改变、工具绑定改变或授权过期以后，旧的分析结果也需要重新评估。

如果模型见过敏感内容，不能仅凭它说“已经脱敏”就允许随意外发。可以采用保守标签传播、独立脱敏检查，或将敏感上下文与可外发任务隔离。选哪种办法，要看具体数据和任务能接受什么限制。

## 拒绝时，也需要让人知道原因

一句“权限不足”很难帮助用户调整任务。比较有用的说明是：当前任务没有向这个外部目标发送工作区数据的授权。

同时，解释本身不能泄露调用者原本无权知道的资源名称和内部规则。给模型的错误、给用户的说明和内部审计记录，可以保留不同粒度的信息。

审计里则应能查到当前主体、策略版本、资源、决定和依据。这样才能区分“没有申请”“没有授予”和“已被撤回”，而不是让它们都变成同一个失败状态。

## 还想继续做的小实验

我想先搭一个“读取—摘要—发布”的最小组合，分别改变数据标签、发布目标和子任务授权，看限制是否真正跟着数据流生效。

尤其想验证两种情况：一个依赖被替换后，旧授权分析会不会继续被复用；父任务权限减少后，已经发出去的子任务凭证能否及时失效。

权限列表是很好的起点，但读完以后，我还会多问一步：把这些动作连在一起，究竟会发生什么？

## 继续读

- [装进 Agent 的 Skill，后来变成了什么？](/blog/agent-capability-software-supply-chain)
- [同名 Skill 还是昨天那一份吗？](/notes/capability-manifest-snapshot-lockfile)
- Miller et al., [Capability Myths Demolished](https://srl.cs.jhu.edu/pubs/SRL2003-02.pdf)
- Hardy, [The Confused Deputy](https://dl.acm.org/doi/10.1145/357172.357176)
- IETF RFC 8693: [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- Birgisson et al., [Macaroons: Cookies with Contextual Caveats for Decentralized Authorization](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/)
- OWASP: [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- NIST: [Attribute Based Access Control](https://csrc.nist.gov/projects/attribute-based-access-control)
