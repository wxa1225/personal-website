---
title: 'Capability Manifest、不可变快照与依赖锁定'
description: '把 Agent Capability 当作可解析依赖：设计 Manifest、内容寻址快照、确定性依赖解析与运行时 Lockfile。'
publishDate: '2026-07-23'
tags:
  - Agent
  - Skill
  - Supply Chain
  - Dependency Resolution
  - Reproducibility
language: '中文'
status: '待补充'
---

> 核心结论：Manifest 表达作者的约束，Snapshot 固定被发布的内容，Lockfile 记录解析器最终选择的完整依赖闭包。三者不能相互替代。

## 先区分四种身份

Capability 管理中经常同时出现名称、版本、Snapshot ID 与安装记录。它们解决的是不同问题：

| 字段 | 示例 | 回答的问题 |
|---|---|---|
| Name | `acme/report-writer` | 人在寻找什么能力？ |
| Version | `1.4.0` | 作者如何描述发布序列与兼容性？ |
| Snapshot ID | `sha256:91ab…` | 具体是哪一组不可变内容？ |
| Resolution ID | `sha256:72cd…` | 最终安装了哪一个完整依赖闭包？ |

名称用于发现，版本用于声明意图；二者都不能证明内容没有变化。只有内容寻址的 Snapshot 才能识别具体发布物，而一次运行要复现的不只是根 Snapshot，还包括全部传递依赖与外部绑定。

可以把关系理解为：

```text
acme/report-writer@^1.4       # 用户请求
        ↓ resolve
acme/report-writer@1.4.2      # 选择的发布版本
snapshot sha256:91ab…         # 选择的不可变内容
        ↓ resolve dependencies
resolution sha256:72cd…       # 完整闭包与绑定
```

如果 Trace 只记录第一行，未来无法知道实际执行了什么。

## Manifest 应该描述什么

下面是一份示意 Manifest。它不是建议直接采用的标准，而是用于暴露设计问题：

```yaml
apiVersion: capability.dev/v1
kind: Capability

metadata:
  name: report-writer
  namespace: acme
  version: 1.4.2
  license: Apache-2.0

entrypoint:
  instructions: instructions.md

contracts:
  input: schemas/input.json
  output: schemas/output.json

requires:
  runtime: ">=2.3 <3"
  models:
    - family: reasoning-model
      features: [tool-calling]
  tools:
    - name: files.read
      protocol: mcp
      version: ">=1 <2"
    - name: artifacts.publish
      protocol: mcp
      version: "~2.1"

dependencies:
  - id: acme/web-research
    version: "^3.2"
  - id: acme/citation-checker
    version: "2.0.1"

permissions:
  - resource: workspace
    operations: [read, create]
  - resource: network:https
    operations: [connect]

evaluation:
  suites:
    - evals/report-quality.yaml

provenance:
  source: https://example.com/acme/report-writer
  revision: 8f3c1d2
```

这些字段可以分成四组：

1. **身份与入口**：名字、版本、指令入口和内容清单。
2. **兼容约束**：Runtime、模型特性、Tool 协议和依赖版本范围。
3. **行为边界**：请求的资源能力、输入输出 Contract。
4. **证据入口**：来源、构建修订和评测套件。

Manifest 中的 `permissions` 是请求，不是授权。安装器可以展示它，Policy 可以把它收窄；Capability 不能通过自我声明给自己授予权限。

同样，`evaluation.suites` 只是测试定义的位置，不代表已经通过测试。真正的评测结果应该作为独立 Attestation 指向 Snapshot 和运行环境。

## Manifest 不应该包含什么

为了得到稳定身份，Manifest 应避免混入安装实例状态：

- 本机绝对路径；
- 用户 Token 和其他 Secret；
- 安装时间、下载次数；
- 当前 `live` / `deprecated` 状态；
- 某个 Agent 被授予的真实权限；
- 可变 URL 返回的未固定内容。

这些信息分别属于安装配置、Registry 元数据或运行时 Policy。把它们放进发布内容，会导致同一 Capability 在不同机器上产生不同哈希，也可能把凭证带入供应链。

一个实用判断是：

> 如果字段随安装者、部署环境或时间变化，它通常不属于内容快照。

## Snapshot 应该对什么求哈希

只对 `manifest.yaml` 求哈希不够，因为入口文件和脚本仍可被替换。Snapshot ID 应覆盖执行可能观察到的完整发布物：

```text
snapshot/
├── manifest.yaml
├── instructions.md
├── schemas/
├── scripts/
├── resources/
└── evals/
```

一种简单方案是为每个文件计算摘要，再对规范化索引求哈希：

```json
{
  "algorithm": "sha256",
  "files": [
    {"path": "instructions.md", "digest": "sha256:…", "size": 4182},
    {"path": "manifest.yaml", "digest": "sha256:…", "size": 1360},
    {"path": "schemas/input.json", "digest": "sha256:…", "size": 520}
  ]
}
```

索引按规范化路径排序，Snapshot ID 为规范化索引字节的摘要：

```python
index_bytes = canonical_json(index)
snapshot_id = "sha256:" + sha256(index_bytes).hexdigest()
```

这样不必把大文件全部拼接后再求哈希，也能逐个验证下载内容。

## “规范化”比哈希算法更容易出错

相同逻辑内容如果被序列化成不同字节，会得到不同哈希：

```json
{"name":"a","version":"1"}
{"version":"1", "name":"a"}
```

YAML 还存在注释、锚点、不同标量写法和解析类型等差异。因此必须先决定 Snapshot 身份针对：

- **原始字节**：任何格式变化都会产生新身份，简单且忠实于发布物；
- **语义对象**：忽略无关格式，但需要一个严格、跨语言一致的规范化协议。

对一个初始实现，我倾向于：文件内容按原始字节求哈希，只把自动生成的文件索引编码成规范 JSON。这样格式变化会产生新 Snapshot，但规则更容易正确实现和审计。

还需要固定：

- 路径统一使用 `/`，禁止绝对路径、`.`、`..` 与重复项；
- 文件名是否采用 Unicode Normalization；
- 是否允许符号链接；若允许，哈希链接文本还是目标内容；
- 可执行位等元数据是否属于身份；
- 大小写敏感性如何跨平台处理；
- 压缩包时间戳是否排除在身份之外。

如果发布物会在 Windows 与 Linux 间流动，最好禁止仅大小写不同的两个路径，并在解包前验证目标路径，避免 archive traversal。

## Snapshot ID、签名与版本分别证明什么

三者容易被混淆：

```text
Version       作者声称这是发布序列中的 1.4.2
Snapshot ID   内容与某个摘要相同
Signature     某个密钥认可了这份带身份的声明
```

内容哈希不能证明作者是谁，签名不能证明内容安全，版本号也不能证明内容未被替换。

一个签名 Envelope 可以覆盖：

```json
{
  "capability": "acme/report-writer",
  "version": "1.4.2",
  "snapshot": "sha256:91ab…",
  "issuedAt": "2026-07-23T12:00:00Z",
  "issuer": "keyid:…"
}
```

验证器还需要信任根、密钥轮换、过期和撤销规则。不要把作者签名直接等同于 Registry 审核；它们是由不同主体提供的两条证据。

## 依赖约束属于 Manifest，解析结果属于 Lockfile

作者通常需要表达兼容范围：

```yaml
dependencies:
  - id: acme/web-research
    version: "^3.2"
```

这让解析器可以选择未来兼容版本，但也意味着相同 Manifest 在不同日期可能得到不同结果。Lockfile 的作用就是固定某次解析：

```yaml
lockVersion: 1
root:
  id: acme/report-writer
  version: 1.4.2
  snapshot: sha256:91ab...

packages:
  acme/report-writer:
    version: 1.4.2
    snapshot: sha256:91ab...
    dependencies:
      acme/web-research: sha256:24fe...
      acme/citation-checker: sha256:981c...

  acme/web-research:
    version: 3.4.1
    snapshot: sha256:24fe...
    dependencies:
      acme/http-reader: sha256:771e...

  acme/citation-checker:
    version: 2.0.1
    snapshot: sha256:981c...
    dependencies: {}

  acme/http-reader:
    version: 1.6.0
    snapshot: sha256:771e...
    dependencies: {}
```

真实 Lockfile 还应记录：

- Registry 或命名空间来源；
- Tool/MCP Server 的不可变实现身份；
- Runtime 与模型的兼容选择；
- 解析器版本和规则版本；
- 解析时采用的平台条件；
- 有效权限闭包的摘要；
- Lockfile 自身的 Resolution ID。

但 Secret、用户本地路径和临时授权 Token 不应进入可分享的 Lockfile。

## 一个确定性的解析流程

依赖解析的输入不只是根版本范围：

```text
ResolveRequest
├── root constraint
├── registry snapshot / index version
├── platform
├── runtime version
├── model features
├── policy ceiling
└── resolver version
```

解析器需要：

1. 获取根 Capability 的候选版本。
2. 过滤已撤销、不兼容或超出 Policy Ceiling 的候选。
3. 验证每个候选的 Snapshot 与签名/来源要求。
4. 展开直接与传递依赖。
5. 求解版本、Runtime、Tool 与平台约束。
6. 检测循环依赖与命名空间冲突。
7. 计算依赖闭包和请求权限闭包。
8. 生成规范化 Lockfile 与 Resolution ID。

同样输入应产生同样输出。为此不能让“Registry 当前返回顺序”决定选择结果；候选排序、冲突优先级和预发布版本规则都必须固定。

伪代码可以写成：

```python
def resolve(request, registry_index):
    state = SolverState()
    state.require(request.root)

    while requirement := state.next_requirement():
        candidates = registry_index.match(requirement)
        candidates = filter_compatible(candidates, request)
        candidates = deterministic_sort(candidates)

        selected = state.choose(candidates)
        state.add(selected.snapshot, selected.dependencies)

    lock = build_lockfile(state, request)
    lock.resolution_id = digest(canonical_json(lock.without_id()))
    return lock
```

真正的版本求解可能需要回溯或 SAT/约束求解；这段代码只强调解析输入与输出必须显式且可审计。

## 版本冲突不应该被静默覆盖

假设：

```text
A → C ^1
B → C ^2
```

平台可以选择：

- 允许 C 的多个版本在隔离作用域共存；
- 如果 Capability 是全局注入的指令，只允许一个版本并报告冲突；
- 由作者提供显式 Adapter；
- 拒绝解析并要求调整依赖。

普通语言包可以通过模块作用域同时加载多个版本，但两份自然语言指令或同名 Tool Schema 未必能安全共存。Capability 依赖的合并语义需要比普通包管理器更保守。

尤其不能采用“后加载覆盖前加载”。它会让依赖顺序隐式决定 Prompt、工具定义或 Policy，Lockfile 即使固定了版本，也无法直观看出最终行为。

## Tool 依赖为什么难以锁定

Manifest 中写着 `files.read@1`，并不代表背后的执行实现固定：

```text
Tool name / Schema
        ↓
MCP Server package
        ↓
Server configuration
        ↓
Remote API
```

其中任何一层变化都可能改变语义。Lockfile 至少应锁定能控制的部分：Server 包或镜像摘要、协议版本、Tool Schema 摘要和配置模板版本。

远程 SaaS 通常无法做到完全内容寻址。这时应诚实记录外部依赖的服务身份、API 版本和观测时间，而不是声称执行可以完全复现。

“可复现”也应区分：

- **Artifact reproducibility**：能取回同一组 Capability 与 Tool 实现。
- **Behavioral reproducibility**：模型和外部服务仍产生同样行为。

前者可以通过供应链机制显著改善，后者在概率模型和可变环境中通常只能追求统计一致与证据充分。

## 发布、安装和激活应该分开

这三个动作解决不同问题：

```text
Publish   Registry 接受并暴露一个不可变 Snapshot
Install   Resolver 生成并获取一个完整 Resolution
Activate  某个 Agent/环境开始使用这个 Resolution
```

把三者合成“安装最新版”会让更新立刻进入运行时，也无法插入评测、人工确认或 Canary。

更稳健的流程是：

```text
1. 作者上传 Snapshot 与来源声明
2. Registry 验证内容索引和身份
3. 测试 / 审核 Attestation 绑定 Snapshot
4. Release 元数据把版本指向 Snapshot
5. Consumer 解析并生成 Lockfile
6. 下载后逐文件验证摘要
7. 在目标 Policy 下执行兼容性评测
8. 显式把 Resolution 激活给 Agent
```

Registry 的 `live` 状态不应改变 Snapshot 内容，只改变它是否是新的解析候选。

## 运行时仍要验证什么

有了 Lockfile，Runtime 不能直接相信本地缓存：

```python
def load_resolution(lock):
    verify_resolution_id(lock)

    for package in lock.packages.values():
        artifact = cache.fetch(package.snapshot)
        verify_snapshot(artifact, package.snapshot)
        mount_readonly(artifact)

    verify_runtime_compatibility(lock)
    return build_execution_context(lock)
```

关键不变量包括：

- 每个 Artifact 的内容与 Snapshot ID 一致；
- 实际加载集合与 Lockfile 一致，没有未声明文件；
- Capability 内容以只读方式挂载，运行时状态写入独立目录；
- Trace 记录 Resolution ID；
- 当前 Policy 只会收窄 Manifest 请求的能力；
- 已撤销 Snapshot 按本次执行策略被拒绝、隔离或告警。

内容验证解决完整性，Execution Harness 仍负责具体 Tool Call 的授权。一个经过签名和锁定的恶意 Skill，依然应该被最小权限限制。

## 撤销后怎样定位影响范围

因为每次激活都保存了 Resolution ID 与依赖闭包，Registry 可以反向查询：

```text
revoked snapshot sha256:24fe…
        ↓ reverse dependency index
affected resolutions
        ↓ activation records
affected agents / environments / runs
```

撤销策略可以分级：

- **Deprecated**：不建议新安装，已有 Resolution 继续运行。
- **Yanked**：不参与新的解析，已有锁定安装可按策略继续。
- **Revoked**：默认禁止新的激活，并评估已激活实例。
- **Emergency blocked**：Execution Harness 在运行前强制拒绝。

删除 Snapshot 会破坏影响分析与历史 Trace。即使内容因法律或隐私原因必须移除，也应保留受控的身份、时间和撤销证据。

## 常见失败模式

### 1. 版本号直接指向可变目录

`1.4.2` 的内容可以原地变化，测试与审核结论随之失效。

### 2. Lockfile 只锁直接依赖

传递依赖仍会漂移，无法复现完整行为面。

### 3. Snapshot 只覆盖 Manifest

脚本、指令和资源可以在身份不变时被替换。

### 4. 使用不确定的序列化计算身份

不同语言或平台生成不同摘要，或者同一逻辑对象存在多个身份。

### 5. 把签名当成安全审核

签名验证来源与完整性，不验证 Capability 的行为是否安全。

### 6. 安装时解析，运行时再次解析

审核与测试针对旧闭包，真实执行却获得新依赖。

### 7. Tool Schema 被锁定，实现没有锁定

调用协议看似不变，副作用、权限或远端行为已经改变。

### 8. 撤销时删除历史内容

平台无法定位受影响 Resolution，也无法解释过去执行。

## 应该测试哪些不变量

1. 修改 Snapshot 中任意一个字节都会改变验证结果。
2. 文件遍历顺序、压缩时间戳和宿主平台不会意外改变 Snapshot ID。
3. 同样解析输入与 Registry Index 总是产生相同 Lockfile。
4. 任意传递依赖变化都会改变 Resolution ID。
5. 冲突依赖不会被加载顺序静默覆盖。
6. 已安装内容被篡改时，Runtime 在加载前拒绝。
7. Manifest 请求权限只能被运行时 Policy 收窄，不能自行扩张。
8. 被撤销 Snapshot 能反向定位全部受影响 Resolution。
9. Trace 能用 Resolution ID 重建当时的依赖和 Tool 绑定。

属性测试适合验证路径规范化、序列化和顺序独立性；故障注入适合验证下载中断、Registry 索引变化、缓存损坏和撤销竞态。

## 当前理解 / 结论

1. Name、Version、Snapshot ID 与 Resolution ID 是四种不同身份。
2. Manifest 声明作者意图和兼容范围，不记录实例状态，也不授予权限。
3. Snapshot 必须覆盖运行时可观察的全部发布内容，而不只是 Manifest。
4. 初始实现优先对原始文件字节求哈希，以减少跨语言语义规范化风险。
5. Lockfile 固定完整传递依赖、Tool 绑定和解析上下文。
6. Capability 冲突比普通库冲突更复杂，因为自然语言指令与同名工具未必能隔离共存。
7. 发布、安装和激活分离，才能插入评测、审核与渐进更新。
8. Supply Chain 提供内容身份和来源证据，Execution Harness 仍负责限制执行后果。

它与 Blog 2 的关系可以概括为：

> Blog 提出 Capability 是软件供应链问题；Manifest、Snapshot 与 Lockfile 则让“到底把什么能力交给了 Agent”成为一个可以验证的问题。

## 待补充

- 定义一份可由 JSON Schema 验证的 Capability Manifest v0。
- 实现目录索引规范化、Snapshot 构建和验证 CLI。
- 用小型回溯求解器演示传递依赖与版本冲突。
- 比较 OCI Artifact、TUF Targets 与自定义 Registry 的承载方式。
- 为 Resolution Record 增加权限闭包与评测 Attestation 引用。

## 相关链接 / 来源

- [When Agent Capabilities Become a Supply Chain](/blog/agent-capability-software-supply-chain)
- OpenSSF: [SLSA — Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- CISA: [Software Bill of Materials](https://www.cisa.gov/sbom)
- The Update Framework: [TUF Specification](https://theupdateframework.github.io/specification/latest/)
- IETF RFC 8785: [JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- OCI: [Image Manifest Specification](https://github.com/opencontainers/image-spec/blob/main/manifest.md)
- Python Packaging User Guide: [Reproducible Environments](https://packaging.python.org/en/latest/guides/index-mirrors-and-caches/)
