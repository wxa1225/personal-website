---
title: 'Capability 权限闭包与组合风险'
description: '依赖权限不能只做集合并集：分析可达后果、组合风险、委托衰减、Confused Deputy 与运行时授权。'
publishDate: '2026-07-23'
tags:
  - Agent
  - Capability Security
  - Authorization
  - Composition
  - Least Privilege
language: '中文'
status: '待补充'
---

> 核心结论：权限闭包不是依赖声明权限的简单并集。系统真正需要判断的是，在当前数据流、调用关系和 Policy 下，一个 Capability 组合能够到达哪些外部后果。

## 三个集合经常被误认为一个

假设 Capability Manifest 声明：

```yaml
permissions:
  - resource: workspace
    operations: [read]
  - resource: network:https
    operations: [connect]
```

至少需要区分：

```text
Requested Authority   Capability 声明希望获得什么
Granted Authority     当前安装/任务实际授予什么
Exercised Authority   某次执行真正使用了什么
```

它们应满足：

```text
Exercised ⊆ Granted ⊆ PolicyCeiling
Requested 不一定等于 Granted
```

Manifest 只提供 Requested Authority。它可以帮助安装器解释需求，却不能自我授权。Granted Authority 由用户、组织 Policy、任务上下文和父 Agent 的权限共同决定；Exercised Authority 则来自真实 Trace。

还有第四个更重要的概念：**Reachable Consequences**。即使一次运行尚未实际外发数据，只要一个组合同时具备读取敏感数据与向外发送的路径，就已经形成潜在后果。

```text
Requested → 申请了什么
Granted   → 可以调用什么
Reachable → 组合后可能造成什么
Exercised → 这一次实际做了什么
```

供应链审核关注 Requested 与 Reachable，Execution Harness 强制 Granted，审计记录 Exercised。

## 为什么权限并集仍然不够

最直接的闭包计算是遍历依赖图并取并集：

```python
def declared_authority_closure(root, graph):
    permissions = set(root.permissions)
    for dependency in transitive_dependencies(root, graph):
        permissions |= set(dependency.permissions)
    return permissions
```

它能回答“依赖树中出现过哪些权限声明”，却不能回答这些权限能否在同一条执行路径上组合。

考虑三个单独看似合理的 Capability：

```text
document-reader   → secret:read
summarizer        → no external authority
web-publisher     → network:write
```

单独审核 `document-reader` 时，它不能外发；单独审核 `web-publisher` 时，它没有敏感数据。但同一个 Agent 可以把前者输出传给后者：

```text
secret:read
    ↓ content
summarizer
    ↓ summary
network:write
```

集合并集会显示 `{secret:read, network:write}`，但真正的风险不是同时出现两个标签，而是存在一条从敏感 Source 到外部 Sink 的可达路径。

因此至少要同时构建：

1. **Dependency Graph**：谁依赖谁。
2. **Invocation Graph**：谁可以调用哪个 Tool/Capability。
3. **Authority Graph**：每个节点能对哪些资源执行什么操作。
4. **Information-flow Graph**：哪些数据可能从 Source 到达 Sink。

权限闭包提供预筛选，组合风险需要图上的路径分析。

## 一个最小的效果模型

为了分析组合，需要比 `read/write` 更具体的声明：

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

发布工具可能声明：

```yaml
effects:
  inputs:
    - channel: content
      accepts: [public-data]
  externalSideEffects:
    - operation: publish
      destination: https:{approved_domain}
```

系统随后可以发现：Reader 输出的是 `derived-workspace-data`，Publisher 只接受 `public-data`。二者不是因为参数 Schema 兼容就可以安全连接，中间还需要显式的 declassification：例如用户确认某份内容可以公开。

这类声明不可能完美描述模型行为，但仍有价值：它把高后果组合从隐含 Prompt 约定变成可检查的系统约束。

## 权限要带资源范围，而不只是动作名

下面两个权限不能被视为同一个 `files:read`：

```text
read /workspace/current/**/*.md
read /workspace/**
```

同样，两个网络权限风险也不同：

```text
POST https://api.company.example/report
POST https://*
```

可以把授权表示为：

```python
@dataclass(frozen=True)
class Grant:
    principal: str
    operation: str
    resource_pattern: str
    constraints: tuple["Constraint", ...]
    expires_at: datetime
    delegation_depth: int
```

`constraints` 可能限制：

- 允许的 HTTP Method 与域名；
- 文件根、扩展名和最大字节数；
- 只允许创建，不允许覆盖；
- 只能处理当前 Turn 产生的 Artifact；
- 操作次数、成本或时间预算；
- 是否要求用户确认；
- 数据分类上限。

最小权限的核心不是让权限标签更少，而是让**主体、动作、资源与时间范围更窄**。

## 依赖不应该默认继承调用者全部权限

一种危险实现是把 Agent 的完整 Context 传给每个 Skill：

```python
await dependency.run(agent_context)
```

即使依赖只需要读取一个临时文件，它也可能拿到工作区写权限、凭证与外发工具。这违反了权限衰减原则：子 Capability 获得的权限不应超过调用者，也不应超过本次调用所需范围。

理想关系是：

```text
Grant(child)
  ⊆ Grant(parent)
  ∩ Request(child)
  ∩ Need(this invocation)
  ∩ OrganizationPolicy
```

示意实现：

```python
def attenuate(parent_grants, child_request, invocation_scope, policy):
    grants = intersect(parent_grants, child_request)
    grants = intersect(grants, invocation_scope)
    grants = intersect(grants, policy.ceiling)
    return bind_to_subject_and_expiry(grants)
```

这里的交集不是简单字符串比较。资源 Pattern 需要做包含关系判断，约束需要取更严格值：最大文件大小取较小值、过期时间取较早值、允许域名取交集。

如果某类约束无法可靠比较，默认拒绝比默认放宽更安全。

## Capability Token 应该携带什么

运行时可以把衰减后的授权封装为短期 Capability Token 或不可伪造句柄：

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

重要性质包括：

- **Least authority**：只包含本次调用需要的操作和资源。
- **Audience restriction**：只能交给指定 Server 使用。
- **Temporal bound**：生命周期短于任务或 Turn。
- **Context binding**：绑定 Turn/generation，旧任务不能重放。
- **Delegation control**：明确是否还能继续下放。
- **Integrity**：由可信授权服务签名，或作为服务端不可伪造句柄保存。

Token 不是把 Policy 逻辑搬进一段 JSON。Server 仍需验证签名、audience、有效期、资源匹配与撤销状态，并避免把 Token 写入模型上下文、普通日志或 Tool Result。

## Confused Deputy：权限属于谁

Confused Deputy 指一个拥有权限的服务被低权限调用者诱导，使用自己的权限替调用者完成未获准操作。

在 Agent 系统里，一个文件 MCP Server 可能以服务账户运行，可以读取多个工作区。如果它只验证路径存在，而不验证调用者对目标工作区的授权，就会成为 Deputy：

```text
Low-privilege Agent
    ↓ asks for workspace B
Privileged File Server
    ↓ uses server credential
Workspace B data
```

避免这一问题需要 **on-behalf-of** 语义：Server 的基础凭证证明“它有技术能力访问存储”，调用上下文证明“它代表哪个主体、为了哪个 Turn、可以访问哪个资源”。最终权限是二者交集，而不是 Server 自身权限。

```text
Effective request authority
  = Server technical authority
  ∩ Caller delegated authority
  ∩ Current policy
```

Tool Schema 中传入 `user_id` 不能建立这一关系，因为模型可以修改普通参数。主体身份必须来自受信任调用通道或经过验证的 Token。

## 组合风险不满足“分别安全，所以一起安全”

安全属性通常不是可加的。下面几类组合值得单独识别。

### 1. Read + Egress

一个读取敏感数据，一个向外部发送。组合后形成泄露路径。

### 2. Write + Execute

一个只能写配置或脚本，另一个能执行。组合后产生代码执行能力。

### 3. Discover + Invoke

一个枚举其他租户或资源标识，另一个按 ID 操作。组合后可能绕过不可猜测性假设。

### 4. Create + Publish

一个生成内容，另一个公开发布。单独的草稿操作变成不可逆外部状态。

### 5. Read Instruction + Modify Instruction Source

Agent 可以修改未来会再次加载的 Skill 或记忆，形成持久化 Prompt Injection。

### 6. Approve + Execute

同一主体既生成审批结论又执行高风险操作，自我批准破坏职责分离。

因此可以维护一组禁止或需要升级确认的组合规则：

```yaml
compositionPolicies:
  - when:
      source: data:secret
      sink: network:external
    require: explicit_declassification

  - when:
      capabilities: [instruction:write, instruction:load]
    denyWithinSamePrincipal: true

  - when:
      capabilities: [approval:issue, action:commit]
    requireDistinctPrincipals: true
```

规则不应只匹配 Capability 名称，而应匹配解析后的效果和资源范围。

## 静态闭包与动态授权需要同时存在

安装时分析有两个优势：可以向用户解释风险，也可以在 Capability 进入生产前阻止明显危险组合。但它无法知道运行时参数：

```text
read_file(path=?)
publish(destination=?)
```

同一个 Tool Call 对公开 README 与私有密钥的风险不同，发布到内部草稿库与公开互联网也不同。

因此需要两阶段模型：

```text
Install / Activation time
  → 计算声明权限闭包
  → 分析潜在 Source-to-Sink 路径
  → 确认 Policy Ceiling

Execution / Commit time
  → 根据真实参数解析资源
  → 生成最小调用授权
  → 检查当前数据标签与目标 Sink
  → 执行或要求确认
```

静态分析控制最大攻击面，动态 Policy 控制这一次真实后果。二者不是替代关系。

## 数据标签如何穿过模型

传统 Information Flow Control 可以给值附加标签并跟踪转换。Agent 系统中，模型会读取多份内容再生成新文本，很难精确证明输出只来自哪一部分。

一种保守规则是标签并集：

```text
model_output.labels = union(all_visible_input.labels)
```

如果模型同时看到 `public` 与 `secret`，输出继承 `secret`。这能避免漏标，却会快速造成 label creep：长会话读取过一次敏感数据后，所有后续内容都无法外发。

可行的改进包括：

- 缩小每个子 Agent 的可见上下文；
- 把敏感处理放进隔离的子任务，输出结构化、可验证结果；
- 只给发布 Agent 公开数据，而不是给它整段历史会话；
- 使用确定性转换器完成脱敏，而非让同一模型自我声明“已脱敏”；
- 对 declassification 要求用户或独立 Policy 决策。

最有效的控制往往不是更聪明的标签算法，而是减少不必要的数据与能力共处在同一执行主体中。

## 权限闭包也有时间维度

一次安装计算出的权限闭包可能因以下变化失效：

- 依赖 Resolution 更新；
- Tool Server 改变效果或资源范围；
- Organization Policy 收紧；
- 用户权限被撤销；
- Turn 已结束或被新 generation 替换；
- Capability Snapshot 被紧急撤销。

所以闭包应该绑定：

```text
Resolution ID
Policy version
Tool binding digest
Principal
Activation ID
Validity interval
```

它是一份有上下文和有效期的决策材料，不是 Capability 的永久属性。排队很久的 Tool Call 在 Commit 前需要重新验证，而不能使用安装时生成的无限期 allow。

## 一份 Authority Closure Record

在 Note 1 的 Lockfile 之外，可以生成一份权限闭包记录：

```json
{
  "resolution": "sha256:72cd…",
  "policyVersion": "sha256:b519…",
  "principal": "agent-profile:researcher",
  "declared": [
    {"operation": "read", "resource": "workspace:**"},
    {"operation": "connect", "resource": "https:**"}
  ],
  "ceiling": [
    {"operation": "read", "resource": "workspace:current/**"},
    {"operation": "connect", "resource": "https:approved-domains/**"}
  ],
  "compositionFindings": [
    {
      "source": "workspace:confidential",
      "sink": "network:external",
      "disposition": "requires_declassification"
    }
  ],
  "recordId": "sha256:4af1…"
}
```

这份记录适合安装与审核阶段展示，不应直接作为永久执行 Token。运行时仍根据真实主体、资源参数与时效签发更窄的 Grant。

## Policy 决策需要可解释但不能泄密

授权拒绝如果只返回 `permission denied`，模型可能不断重试；如果返回完整内部 Policy，又可能泄露资源结构和安全规则。

可以把解释分层：

```text
Model-visible:
  当前 Capability 未获得向外部域名发送 workspace 数据的权限。

User-visible:
  发布内容可能包含当前工作区数据，需要确认目标域名和公开范围。

Audit-only:
  policy rule R-184, source label confidential,
  sink https://example.net, resolution sha256:…
```

决策事件至少记录主体、操作、解析后的逻辑资源、Policy 版本、结果与原因码，但不复制 Secret、Token 或敏感正文。

## 常见失败模式

### 1. 把 Manifest 权限当成 Granted 权限

Capability 通过自我声明扩权，Policy 失去意义。

### 2. 只展示顶层 Capability 权限

传递依赖引入外发、执行或修改共享资源的能力，安装者不可见。

### 3. 权限闭包只取字符串并集

忽略资源范围、约束交集和 Source-to-Sink 组合路径。

### 4. 子 Capability 继承完整 Agent Context

依赖获得与其任务无关的凭证、工具和工作区权限。

### 5. 把主体放在普通 Tool 参数中

模型可以伪造 `user_id`、`workspace_id`，造成 Confused Deputy。

### 6. 安装时授权，运行时不复验

依赖、Policy、主体权限或 Turn 状态变化后，旧授权仍可执行。

### 7. 认为数据经过模型总结后就变成公开信息

派生文本仍可能泄露敏感事实，declassification 需要独立依据。

### 8. 用长期 Token 解决所有调用

泄露后的重放范围过大，也无法绑定具体 Agent、Turn 和 Server。

## 应该测试哪些不变量

1. Granted Authority 永不超过父授权、Capability 请求与 Organization Policy 的交集。
2. 每次委托只会保持或收窄权限，不能扩大资源范围或有效期。
3. 传递依赖的权限变化会改变 Authority Closure Record。
4. `secret/read → external/write` 路径在没有 declassification 时被阻止。
5. 同一 Capability 在不同参数下解析到不同资源，并获得对应最小 Grant。
6. MCP Server 不信任模型提供的主体字段，只接受受信通道身份。
7. 过期、错误 audience、旧 generation 和已撤销 Token 均被拒绝。
8. Tool 返回的 Prompt Injection 不能扩大后续 Tool Call 的 Granted Authority。
9. 审批与执行需要职责分离时，同一主体不能完成两步。
10. Policy 拒绝会留下不包含敏感内容的结构化证据。

组合测试应基于效果类别生成 Capability 对与三元组，而不只是逐个测试单一 Skill。风险往往恰好不存在于任何一个单独组件中。

## 当前理解 / 结论

1. Requested、Granted、Exercised Authority 与 Reachable Consequences 必须分开记录。
2. 依赖权限并集是闭包分析的起点，不是最终风险结论。
3. 组合风险来自 Source、变换与 Sink 之间的可达路径。
4. 子 Capability 权限应由父授权、子请求、调用需要和组织 Policy 共同衰减得到。
5. Confused Deputy 的根因是服务只使用自身权限，没有验证代表谁行动。
6. 安装时分析潜在攻击面，执行时根据真实资源参数强制授权。
7. 模型处理过敏感数据后，不能自行宣告输出已经安全；上下文隔离通常比乐观去污更可靠。
8. 权限闭包绑定 Resolution、Policy、主体和有效期，不是静态永久标签。

它与 Blog 2 的关系可以概括为：

> Dependency Graph 告诉我们 Agent 加载了什么；Authority 与 Information-flow Graph 才告诉我们这些组件放在一起后可能做成什么。

## 待补充

- 定义资源 Pattern 的包含、交集和规范化算法。
- 实现一个最小的 Authority Closure 与 Source-to-Sink 分析器。
- 比较 Macaroons、OAuth Token Exchange 与服务端 Capability Handle 的衰减语义。
- 为 MCP Tool 定义 effects、data classification 与 audience 元数据实验。
- 使用组合测试生成器验证 read/egress、write/execute 和 approve/commit 规则。

## 相关链接 / 来源

- [When Agent Capabilities Become a Supply Chain](/blog/agent-capability-software-supply-chain)
- [Capability Manifest、不可变快照与依赖锁定](/notes/capability-manifest-snapshot-lockfile)
- Miller et al., [Capability Myths Demolished](https://srl.cs.jhu.edu/pubs/SRL2003-02.pdf)
- Hardy, [The Confused Deputy](https://dl.acm.org/doi/10.1145/357172.357176)
- IETF RFC 8693: [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- Birgisson et al., [Macaroons: Cookies with Contextual Caveats for Decentralized Authorization](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/)
- OWASP: [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- NIST: [Attribute Based Access Control](https://csrc.nist.gov/projects/attribute-based-access-control)
