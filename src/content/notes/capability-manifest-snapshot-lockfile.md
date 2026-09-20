---
title: '同名 Skill 还是昨天那一份吗？'
description: '把名称、版本、内容快照和依赖锁定分开，记录一次运行真正加载的内容。'
publishDate: '2026-07-23'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Skill
  - Supply Chain
  - Dependency Resolution
  - Reproducibility
language: '中文'
status: '待补充'
---

昨天还能正常运行的 Skill，今天表现变了。顶层文件没改过，版本号也一样，接下来该查哪里？

很可能要继续往下看：它依赖了什么，工具背后的服务有没有变化，这次运行到底加载了哪组内容。只保留一个名称，会让这些问题很难回答。

这篇整理一套可能的记录方式。文中的 Manifest 和 Lockfile 都是设计示例，字段还可以调整；更想先弄清楚的是，它们各自负责什么。

## 名称、版本和内容，先分开记

名称方便发现，版本表达作者的发布顺序与兼容约定，内容快照则用来识别具体文件。一次安装还会解析依赖，所以需要再记录最终选中的完整组合。

可以把过程看成这样：

```text
acme/report-writer@^1.4       # 用户请求
        ↓ resolve
acme/report-writer@1.4.2      # 选择的发布版本
snapshot sha256:91ab…         # 选择的不可变内容
        ↓ resolve dependencies
resolution sha256:72cd…       # 完整闭包与绑定
```

用户请求的是一个范围，解析器最终选择的是一份具体内容。把后者记下来，之后才知道两次运行是否真的使用了相同输入。

内容摘要也有自己的边界。它可以帮助核对字节是否一致，不能证明内容安全；签名关联的是某个密钥对内容的声明，也不能代替质量评估。

## Manifest 写要求，别混入安装时的秘密

作者需要说明入口文件、输入输出约定、依赖范围、需要的工具，以及请求的资源权限。下面的示例把这些内容放在同一份描述里：

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

这些是作者提出的要求，不是运行时已经授予的权限。是否允许访问某个工作区，还要根据安装者和任务上下文决定。

用户的 Token、本机路径、租户凭证和“最近一次运行结果”不适合塞进这份发布描述。它们属于具体安装或执行实例，既会破坏稳定的内容身份，也可能随着文件分享被带出去。

## 快照要覆盖真正会被加载的内容

如果只对 `manifest.yaml` 求哈希，旁边的脚本和指令仍然可能变化。快照应该覆盖这次发布包含、运行时可能加载的文件，并有明确的文件清单：

```text
snapshot/
├── manifest.yaml
├── instructions.md
├── schemas/
├── scripts/
├── resources/
└── evals/
```

构建清单时，要决定路径怎样表示、文件顺序怎样固定、符号链接是否允许，以及哪些生成文件应排除。压缩包的时间戳和机器上的绝对路径，也不应该意外改变同一份内容的身份。

对于第一版实现，我会优先固定原始文件字节，再规范化清单本身。若要把 JSON 的不同写法视为相同内容，就需要额外约定键顺序、数字和 Unicode 等细节。不能在构建端和验证端各自“顺手整理一下”。

内容范围确定以后，哈希算法反而只是其中一个环节。真正容易遗漏的，是某个会影响执行的文件没有进入清单。

## Lockfile 记下解析器做出的选择

Manifest 可以写“依赖 3.x”，Lockfile 则应该写明最后选中了哪个版本、哪份快照，以及它继续引用了哪些依赖。

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

这份记录应包含传递依赖和工具绑定，而不只是一层顶级包名。解析时使用的仓库索引、平台条件和策略也会影响选择，必要时需要一起留下。

如果 A 要求 C 的 1.x，B 要求 C 的 2.x，解析器不能默默让最后加载的那个覆盖前一个。可以明确报冲突，也可以在确实支持隔离时保留两份；但自然语言指令和同名工具是否能隔离，不能直接照搬普通代码包的假设。

同样的输入能得到相同的解析结果，是这里值得验证的目标。依赖版本没固定、仓库索引也没固定，却声称能够复现，通常会留下缺口。

## 工具名字固定了，实现未必固定

`files.read@1` 只固定了一个名字和版本标签，背后的 MCP 服务、配置、远程 API 都可能继续变化。

能锁定的部分，可以记录服务包摘要、配置摘要和 Schema 身份；不能锁定的远程实现，则记录可观察到的版本、端点和时间，并承认它不是一份完全冻结的环境。

尤其不要只因为 Tool Schema 没改，就认定工具行为也没改。参数格式相同，服务逻辑仍然可能不同。

## 发布、安装和启用，可以是三个时刻

把新快照放进仓库，解析并下载依赖，让某个 Agent 开始使用它，这三步分开以后，中间就能安排测试、审核和小范围验证。

```text
Publish   Registry 接受并暴露一个不可变 Snapshot
Install   Resolver 生成并获取一个完整 Resolution
Activate  某个 Agent/环境开始使用这个 Resolution
```

运行时加载 Lockfile，也还需要验证内容摘要、工具绑定和授权是否有效。缓存目录可以被修改，之前可用的版本也可能已经被撤销。

撤销时，完整依赖记录能帮助反向查找：哪些安装包含它，哪些任务加载过它，哪些结果可能受影响。停止未来加载与处理已有产物是两件事，都需要有去处。

## 先做一个能核对的小版本

我准备先把范围收在本地目录：生成文件清单、构建快照、解析一个很小的依赖图，再用加载器验证。先不追求做成完整 Registry。

最想看的几种情况是：文件改了一个字节能否被发现，依赖冲突是否明确失败，清单遍历顺序是否稳定，以及撤销后旧的解析记录还能不能被查到。

这些跑顺以后，再考虑 OCI、TUF 等已有分发和验证机制怎样接进来。至少到那时，“同名 Skill 还是不是昨天那一份”已经是一个可以具体核对的问题。

## 继续读

- [装进 Agent 的 Skill，后来变成了什么？](/blog/agent-capability-software-supply-chain)
- OpenSSF: [SLSA — Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- CISA: [Software Bill of Materials](https://www.cisa.gov/sbom)
- The Update Framework: [TUF Specification](https://theupdateframework.github.io/specification/latest/)
- IETF RFC 8785: [JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- OCI: [Image Manifest Specification](https://github.com/opencontainers/image-spec/blob/main/manifest.md)
- Python Packaging User Guide: [Reproducible Environments](https://packaging.python.org/en/latest/guides/index-mirrors-and-caches/)
