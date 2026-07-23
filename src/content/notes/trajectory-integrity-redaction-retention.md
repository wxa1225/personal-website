---
title: 'Trajectory 完整性、Redaction 与保留策略'
description: '在可追溯与最小化之间设计 Agent 轨迹：威胁模型、Hash/Merkle 证据、加密擦除、Tombstone 和分层保留。'
publishDate: '2026-07-24'
tags:
  - Agent
  - Provenance
  - Integrity
  - Privacy
  - Data Retention
language: '中文'
status: '已整理'
---

> 核心结论：Trajectory 的完整性与隐私不是“全部记录”和“全部删除”的二选一。系统应把图关系、敏感 Payload 与完整性承诺分开管理，并明确每种机制能证明什么、删除后还保留什么。

## 先写威胁模型，再选择 Hash

“给日志加 Hash”很容易，但如果不知道防谁，Hash 只会增加格式复杂度。

至少存在五类不同风险：

```text
Accidental loss       采集、传输或存储故障导致事件缺失
Operator mutation     有权限人员修改或删除不利记录
Producer forgery      组件报告了没有发生的行为
Host bypass           操作绕过受监控执行路径
Privacy overcollection 记录本身成为敏感数据泄露源
```

不同机制覆盖不同风险：

| 机制 | 主要帮助 | 不能单独证明 |
|---|---|---|
| Schema validation | Event 形状与必填字段正确 | 内容真实 |
| Hash chain | 已记录事件未被无痕修改/重排 | Producer 没漏记或伪造 |
| Producer signature | 事件由某个密钥签发 | 密钥持有者诚实、主机未绕过 |
| Merkle checkpoint | 大集合成员与一致性证明 | 所有应记录事件都进入集合 |
| Transactional outbox | 状态变化与 Event 原子出现 | 外部系统真实完成副作用 |
| Tool attestation | Tool 对结果作出独立声明 | Tool 本身未被攻破 |
| Data minimization | 降低记录泄露后果 | 调试与审计仍有足够证据 |

成熟设计不是寻找一个“可信日志”开关，而是组合机制，并把剩余假设写清楚。

## 完整性、真实性与完整性覆盖率不是一回事

中文里“完整性”容易同时指 Integrity 与 Completeness，实际需要拆开：

```text
Integrity     已有记录是否被修改
Authenticity 记录是否来自声称的 Producer
Completeness 应记录的事件是否都存在
Truthfulness Producer 的声明是否符合现实
```

Hash 可以提升 Integrity，签名可以提升 Authenticity。它们对 Completeness 与 Truthfulness 的帮助有限。

例如一个被攻破的 Tool Runtime 可以签名一条“写入成功”，同时不记录真实目标路径。签名只让我们知道谎言来自那个 Runtime 的密钥。

因此 Provenance 查询最好返回 Evidence Source 和 Guarantee：

```json
{
  "claim": "artifact-v7 wasGeneratedBy tool-activity-77",
  "producer": "tool-runtime/worker-7",
  "evidence": "signed-event",
  "guarantee": "producer-asserted",
  "independentConfirmation": "state-store-revision-18"
}
```

有 State Store 的独立 Revision，证据强度才进一步提高。

## 线性 Hash Chain 适合单一有序流

对单 Producer Event Stream，可以定义：

```text
h0 = domain-separated genesis
hi = H(version || stream_id || sequence_i || event_bytes_i || h(i-1))
```

Event 保存：

```json
{
  "streamId": "producer:worker-7/epoch:12",
  "sequence": 184,
  "previousDigest": "sha256:…",
  "eventDigest": "sha256:…",
  "chainDigest": "sha256:…"
}
```

验证器可以发现：

- 中间 Event 内容被修改；
- Event 被插入或重新排序；
- 已知 Checkpoint 之前的 Event 被截断。

但只拿到链尾的一段时，不知道更早的事件是否被整个删除。需要把可信 Chain Head 定期发布到独立位置。

还要处理 Producer 重启：`sequence=1` 重新开始时必须生成新的 Epoch，并用明确事件连接旧 Chain Head，而不能悄悄创建第二条同名链。

## 并行系统不应伪造一条全局链

Agent Run 可能跨多个 Worker 并行：

```text
model gateway stream A
tool runtime stream B
policy engine stream C
state store stream D
```

强行让所有事件争用一个全局 Sequence 会增加延迟和单点故障，也把无因果关系的事件伪装成全序。

更合理的是：

1. 每个可信 Producer Stream 维护自己的 Hash Chain。
2. 跨服务调用在 Event 中引用 causation/correlation 与对方 Event Digest。
3. Collector 定期把各 Stream Head 放入 Merkle Tree。
4. 对 Merkle Root 签名并发布 Checkpoint。

```text
head(A) ─┐
head(B) ─┼→ Merkle root R42 → signed checkpoint
head(C) ─┤
head(D) ─┘
```

这样保留局部顺序与并行结构，同时能证明某个 Stream Head 已包含在 Checkpoint 中。

## Merkle Proof 证明成员关系与历史一致性

如果 Event 或 Stream Head 是叶子，Inclusion Proof 可以用 `O(log n)` 的兄弟摘要证明某叶子属于某个 Root，而不暴露整个集合。

Append-only Transparency Log 还可以提供 Consistency Proof，证明新 Root 是旧 Root 的追加扩展，而不是重写了另一份历史。

这适合：

- 向外部 Auditor 证明某条关键决策在某时点已经被记录；
- 不复制完整敏感 Trajectory，只提交摘要证明；
- 检测不同观察者拿到互相矛盾的 Log View。

但如果 Log Operator 向不同用户展示不同 Fork，需要 Gossip、独立 Witness 或把 Root 锚定到另一个信任域才能发现 Split View。

Agent 系统通常不必一开始就建设公共 Transparency Log。一个实用起点是：租户内 Append-only Event Store + 周期签名 Checkpoint + 独立受控备份。

## Canonicalization 是完整性协议的一部分

对 JSON 字符串直接 Hash 会遇到键顺序、空白、数字和 Unicode 表示差异。完整性协议要固定：

```text
schema version
canonical encoding
field inclusion/exclusion
domain separator
hash algorithm
signature envelope
```

尤其不能把可变字段放进事后重算 Hash：例如 Collector 收到后才补写 `observedAt`，会改变 Producer 原签名内容。

可以分成两层声明：

```text
Producer Statement  Producer 对 occurredAt、subject、payload digest 签名
Collector Receipt   Collector 对 observedAt、stream position、producer digest 签名
```

这既保留 Producer 声明，也不让 Collector 能静默改写它。

## Transactional Outbox 降低状态与记录分裂

假设服务先更新数据库，再异步发 Provenance Event：

```text
DB commit succeeds
process crashes
event publish never happens
```

图里不会出现真实状态变化。反过来先发 Event 再提交数据库，也可能记录一个从未完成的写入。

同一数据库内可用 Transactional Outbox：

```sql
BEGIN;
UPDATE artifacts SET version = 7 WHERE id = 42 AND version = 6;
INSERT INTO outbox(event_id, event_payload) VALUES (...);
COMMIT;
```

Publisher 后续把 Outbox 事件至少一次发送，Consumer 幂等去重。这样 State Transition 与“应发送的 Event”原子存在。

如果外部 SaaS 不参与本地事务，仍可能处于未知状态。此时记录：请求意图、Idempotency Key、远端 Request ID、调用结果与后续状态确认，而不是声称本地 Event 与远端副作用原子。

## 独立 Witness 能减少单点叙事

如果 Agent Host 同时执行、记录、签名和存储全部证据，Host 被攻破后可以构造自洽历史。

高后果边界可以引入其他证据源：

```text
Policy Engine      签发 decision ID 与规则版本
Tool Server        签发 invocation receipt
State Store        返回 before/after revision
Release Registry   证明 Capability Resolution
Checkpoint Service 锚定 Event heads
```

一次状态提交随后由多个互相引用的 Statement 支持。

这不是要求每个 Tool Call 都使用远程证明。可以按后果分级：本地只读搜索用普通 Trace；发布、删除、跨租户访问等操作需要独立 Receipt。

## 记录之前先做确定性 Secret Filtering

Prompt、Tool 参数和 HTTP Header 中可能出现 Token、Cookie、Password、Private Key。它们不应该“先进入日志，再等后台脱敏”。一旦进入消息队列、错误监控或备份，删除范围迅速扩大。

记录器应在边界上：

```text
1. 按 Schema 标记 secret 字段并默认排除
2. 对 Header 使用 allowlist，而非 denylist
3. 对自由文本运行模式检测作为补充
4. 超出大小上限的 Payload 存受控 Blob，不内联 Event
5. 无法分类时只记录摘要、长度和受限引用
```

正则脱敏不是完整方案：Secret 格式多样，也可能被编码、分片或出现在模型自由文本中。最有效的方法是从结构设计上不让凭证进入模型上下文和普通 Event Pipeline。

## Graph Metadata 与 Payload 必须分离

一种分层存储：

```text
Event / Graph Store
  id, type, relation, time, classification,
  payload_ref, payload_digest, retention_class

Payload Store
  encrypted prompt / response / tool result / document

Key Store
  tenant / purpose / payload data keys
```

Graph 可以长期保留结构，Payload 按敏感级别短期过期。查询者先获得 Graph 节点，再单独通过 Payload Policy 解引用。

这避免：

- 有权查看 Run 拓扑的人自动看到文件正文；
- Graph 备份复制大量敏感数据；
- 删除 Payload 时必须重写所有 Edge；
- 分析查询把 Prompt 全文加载进内存。

但 Payload Digest 仍可能敏感，不能默认当作无害 Metadata。

## 裸 Hash 可能泄露低熵内容

假设 Entity Payload 只有：

```text
diagnosis = positive | negative
```

即使只保存 `sha256(payload)`，攻击者也可以对两个候选值求 Hash 并反推原文。这是字典攻击，不需要破解 SHA-256。

可选设计：

### 随机 ID，不保留内容摘要

隐私最好，但失去跨记录完整性/去重能力。

### 加随机 Salt

防止预计算表，但若 Salt 与 Hash 一起公开，低熵字典仍可逐条尝试。

### Keyed Digest

```text
digest = HMAC(tenant_key, domain || payload)
```

没有 Key 的查询者无法离线猜测；按租户和用途做 Domain Separation，避免跨域关联。

### 承诺服务

由受控服务保存 Key 并只提供 Verify API，不向普通图查询暴露摘要。

选择取决于是否真的需要内容等价查询。不要为了“以后可能有用”给所有敏感 Payload 建可枚举指纹。

## Envelope Encryption 支持有界的加密擦除

Payload 可以使用随机 Data Encryption Key（DEK）加密，再由 Tenant/Purpose Key Encryption Key（KEK）包装：

```text
payload ciphertext ← encrypt(DEK, payload)
wrapped DEK        ← wrap(KEK_tenant_purpose, DEK)
```

删除 Payload 时：

- 删除 Ciphertext，直接移除数据；
- 或删除对应 DEK/包装材料，使 Ciphertext 不再可解密；
- 轮换 KEK 时重新包装 DEK，无需重加密全部 Payload。

Crypto-shredding 不是万能删除：

- 明文可能存在于缓存、Crash Dump、下游索引和人工导出；
- 备份中的 Key 或已解密副本仍可恢复；
- Graph Metadata 本身可能泄露关系；
- 密钥删除过程需要审计和多副本一致性。

它适合降低大型不可变备份中的删除成本，但必须配合数据流清单与副本治理。

## Redaction 不应修改原始 Event 声明

如果直接从历史 Event JSON 删除字段，原 Hash/签名全部失效。更好的方式是保留不可变 Event Metadata，让 Payload Reference 进入 Redacted 状态：

```json
{
  "entityId": "entity:input:42",
  "payload": {
    "state": "redacted",
    "ref": null,
    "digest": null
  },
  "tombstone": {
    "reason": "retention_expired",
    "policy": "retention-policy:v4",
    "redactionEvent": "evt:redact:91",
    "redactedAt": "2026-08-24T00:00:00Z"
  }
}
```

原 Event 仍声明“当时存在一个 Payload Ref/Digest”，当前 Materialized View 声明 Payload 已不可用。若原 Event 中包含敏感 Digest，就需要从一开始把它放在可擦除的加密区，而非永久签名明文中。

这意味着完整性 Envelope 的设计必须在上线前考虑未来删除：永久承诺什么，不永久承诺什么。

## Tombstone 保留结构，但不能冒充内容证明

删除节点会让下游关系断裂：无法解释报告曾依赖一个现已删除的输入。Tombstone 可以保留：

```text
stable entity ID
coarse type
classification
relation edges
payload unavailable reason
redaction policy/time
```

根据风险，可能还保留尺寸区间、来源类别或受控 Commitment。

但 Tombstone 只能证明系统记录过一个 Entity 位置，不能再验证具体内容。如果内容证明是法律审计要求，可能需要在隔离 Legal Hold Store 中保留，而不是给普通查询者继续访问。

## 删除需要沿数据流做影响分析

一个用户输入可能派生：

```text
prompt
├── model response
├── tool query
├── cached summary
├── final report
├── evaluation case
└── analytics aggregate
```

删除请求不能只删除 Prompt Blob。Provenance Graph 的价值之一是查找 Descendants，并按类别决定：

```text
Direct copy          删除或加密擦除
Reversible transform 删除，因可恢复原文
Derived content      评估是否仍包含个人/敏感信息
Aggregate            根据重识别风险和政策处理
External artifact    删除、撤回或记录无法控制
Audit record         按法律依据保留最小证据
```

“派生自”不自动意味着法律上必须删除，也不自动意味着可以保留；系统需要把影响集合交给明确 Policy，而不是让图数据库自行作合规结论。

删除工作流本身应该产生 Provenance：请求主体、验证方式、Policy Decision、目标集合、每项执行结果和无法删除的外部依赖。

## Legal Hold 与普通保留期需要正交

保留决策可能来自：

```text
Operational TTL      调试用途保存 7 天
Security TTL         安全事件保存 90 天
Contractual policy   客户配置的保留期
Legal hold           特定案件暂停删除
User deletion        合法请求触发删除
```

不要简单取“最长保留”。Legal Hold 应是对特定 Subject/Data Scope 的受控覆盖，并记录授权依据和复核时间；解除 Hold 后，数据应立即重新进入原保留流程，而不是永久遗忘。

一份 Retention Decision 可以表示：

```json
{
  "dataObject": "payload:…",
  "classification": "confidential-user-content",
  "basePolicy": "ttl:30d",
  "createdAt": "…",
  "expiresAt": "…",
  "holds": [],
  "deletionState": "scheduled"
}
```

Policy 版本变化也应触发重新计算，避免历史对象继续使用过期默认值。

## 一份分层保留矩阵

示意策略：

| 数据层 | 内容 | 默认保留 | 访问 |
|---|---|---:|---|
| L0 Secret | Token、Cookie、Private Key | 0，不记录 | 无 |
| L1 Sensitive Payload | Prompt、文件、Tool Result | 7–30 天 | Run Owner + 特权调试 |
| L2 Operational Metadata | Tool、耗时、状态、错误码 | 30–90 天 | 工程与安全角色 |
| L3 Provenance Skeleton | ID、类型、边、版本、Tombstone | 较长 | 租户内审计角色 |
| L4 Signed Checkpoint | Merkle Root、签名、时间 | 最长 | 审计服务 |

这些期限不是通用答案，实际需要按业务、合同和地区调整。关键设计是不同层可独立过期，且 L3/L4 不携带可轻易反推 L1 的裸摘要。

## 图查询授权必须防止关系泄漏

即使 Payload 已保护，Graph 关系也可能泄露：

```text
某用户调用了“医疗诊断”Capability
某工作区与并购项目 Artifact 有连接
某员工的 Run 被 Security Review 节点关联
```

授权不能只在 Payload Download 时检查。Graph Query 需要：

- Tenant Scope 强制过滤；
- 节点与边的 Classification；
- 查询者 Purpose/Role；
- 对邻居扩展、祖先/后代遍历的每跳授权；
- 查询结果大小与速率限制；
- 敏感模式的聚合阈值与审计；
- 防止通过 Count、Timing 和错误信息推断隐藏节点。

例如查询 `ancestors(report)` 时，系统不能先取全部跨租户节点再在应用层过滤。权限约束应进入图遍历本身，否则中间结果、缓存和查询计划都可能泄露。

## Redaction 后的查询语义要明确

当 Payload 被删除，Graph API 应区分：

```text
not_found       ID 从未存在或调用者无权知道
redacted        节点存在，Payload 按 Policy 删除（仅授权者可见）
expired         正常保留期结束
legal_hold      内容存在但当前不可访问
corrupted       应存在但完整性验证失败
unavailable     外部依赖暂不可用
```

对普通用户，某些状态可能统一映射为 `not_available`，避免泄露隐藏对象存在性；审计角色则需要更精确原因。

图算法也要适应 Tombstone：路径查询可以穿过结构节点，但全文验证、Replay 与语义搜索必须返回 Evidence Gap，而不能把缺失 Payload 当空字符串。

## 备份与导出是最容易被遗忘的副本

主库删除不等于数据消失。需要把以下位置纳入 Data Inventory：

```text
message broker retention
dead-letter queue
search index
analytics warehouse
object-store versioning
database replica
backup / snapshot
developer export
support ticket attachment
model evaluation fixture
```

备份通常不可逐条重写，可以采用短备份 TTL、Envelope Encryption/Crypto-shredding，以及恢复后立即重放 Deletion Ledger。

Deletion Ledger 不能包含被删除的敏感正文；它保存稳定对象 ID、删除范围、Policy 与处理状态。恢复流程在服务开放前应用 Ledger，避免旧数据短暂复活。

## 完整性验证与 Redaction 如何同时成立

看似矛盾：Hash Chain 依赖历史字节不变，Redaction 又要求删除内容。

一种结构是：

```text
Immutable Event Core
  event identity, type, subject, payload commitment/ref,
  producer statement, chain links

Mutable Availability State
  payload present / expired / redacted / held,
  storage location, access policy

Append-only Governance Events
  retention assigned, access granted, payload redacted,
  hold applied/released, verification failed
```

敏感正文从不进入 Immutable Core；Core 只包含经过威胁评估的引用或 Commitment。Redaction 不改 Core，而是销毁 Payload/Key，并追加 Governance Event。

如果连 Commitment 都必须删除，则 Core 可以只承诺一个随机 Entity ID，内容完整性验证能力随之降低。隐私要求高于取证便利时，这是合理权衡。

## 访问本身也应进入审计，但避免递归爆炸

谁查看过敏感 Trajectory 是重要证据。可以记录：

```text
principal
purpose
query class
scope / result count
payload objects accessed
policy decision
timestamp
```

不要把完整查询结果再次复制进 Access Log，否则审计日志成为第二份 Payload Store。

也不需要为“读取 Access Log 的 Access Log”无限递归。可以设置独立 Audit Domain：访问审计数据由更严格系统记录摘要与 Reviewer 操作，并有明确边界。

## 常见失败模式

### 1. 对可变 JSON 直接求 Hash

Collector 补字段或序列化差异导致验证失败，团队最终关闭校验。

### 2. 所有 Worker 共用一个全局 Hash Chain

制造吞吐瓶颈，并把并发事件错误全序化。

### 3. 签名后声称事件一定真实

忽略 Producer 被攻破、漏记和 Host 绕过执行路径。

### 4. Prompt 全文先落日志再异步脱敏

Secret 已复制到 Broker、备份和监控系统，删除范围失控。

### 5. 把 SHA-256 当成匿名化

低熵个人数据可被字典攻击反推，跨租户相同 Hash 还会形成关联标识。

### 6. Redaction 直接改历史 Event

破坏签名与 Chain，无法区分合法删除和恶意篡改。

### 7. 只删除根输入，不检查 Descendants

缓存、报告、评测样本和外部 Artifact 继续保存派生数据。

### 8. 只保护 Payload，不保护图关系

Capability 名称、边和时间仍泄露敏感行为。

### 9. 主库删除后忽略备份与导出

恢复或人工文件让数据再次出现。

### 10. Tombstone 被当成完整内容证明

节点结构仍在，不代表已删除 Payload 可以被复验。

## 应该测试哪些不变量

1. 修改、删除、插入或重排已 Checkpoint 的 Event 会被验证器发现。
2. Producer 重启会创建新 Epoch，并与旧 Chain Head 显式连接。
3. Merkle Inclusion/Consistency Proof 对正确与篡改数据分别通过和失败。
4. 业务状态提交与 Outbox Event 同事务成功或失败。
5. Secret Schema 字段永不进入 Event、Broker、错误日志和 Checkpoint。
6. 低熵 Payload 不产生可公开枚举的裸 Hash。
7. Redaction 不修改 Immutable Event Core，只改变 Availability 并追加 Governance Event。
8. 删除密钥后，主存储、Replica 和恢复流程都无法解密目标 Payload。
9. Descendant Impact Query 覆盖缓存、Artifact、评测样本与外部引用。
10. Legal Hold 阻止删除，解除后对象恢复原 Retention Schedule。
11. Graph 遍历在每一跳执行 Tenant 与 Classification 授权。
12. 未授权查询不能通过 Count、Timing 或错误类型确认隐藏节点存在。
13. 备份恢复后在开放查询前完整应用 Deletion Ledger。
14. Tombstone 路径查询保留结构，Replay 明确报告 Payload Gap。
15. Access Audit 不复制敏感结果正文，也不存在无限递归记录。

## 当前理解 / 结论

1. Integrity、Authenticity、Completeness 与 Truthfulness 是四种不同保证。
2. 单 Producer 用 Hash Chain，跨并行 Stream 用局部链与签名 Merkle Checkpoint 更自然。
3. 完整性证据必须绑定 Canonicalization、Schema、Producer 与 Epoch。
4. Transactional Outbox 能减少数据库状态与 Event 分裂，无法让远程副作用自动原子化。
5. Graph Metadata、Payload 与 Key 应分层管理，并采用不同访问和保留策略。
6. 裸 Hash 不是匿名化；低熵敏感内容需要随机身份、Keyed Digest 或不留 Commitment。
7. Redaction 应销毁 Payload/Key并追加治理事件，而不是重写不可变历史。
8. Tombstone 保留因果结构，却不再证明具体内容。
9. 删除请求需要沿 Provenance 查找派生影响，但最终处理仍由明确 Policy 决定。
10. 图关系本身也会泄露，授权必须进入遍历而不只是 Payload 下载。

它与 Blog 3 的关系可以概括为：

> Provenance 只有在历史难以被无痕改写时才有证据价值；但如果为了证据永久保存所有内容，它又会成为新的风险。设计目标是保留可验证结构，而不是无限保留敏感正文。

## 待补充

- 实现 Producer Hash Chain、Merkle Checkpoint 与 Inclusion Proof 示例。
- 定义 Immutable Event Core、Payload Envelope 与 Governance Event Schema。
- 演示低熵内容对裸 Hash 的字典攻击与 Keyed Digest 防护。
- 构建包含 Tombstone、Legal Hold 和 Deletion Ledger 的保留状态机。
- 测试带节点/边 Classification 的授权图遍历。

## 相关链接 / 来源

- [Agent Trajectories Should Be Provenance Graphs](/blog/agent-trajectories-as-provenance-graphs)
- [Agent Provenance：事件模型、稳定身份与因果边](/notes/agent-provenance-event-model-identity-causality)
- RFC 6962: [Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962)
- in-toto: [Attestation Framework](https://github.com/in-toto/attestation)
- SLSA: [Verifying artifacts](https://slsa.dev/spec/v1.0/verifying-artifacts)
- NIST SP 800-92: [Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final)
- OWASP: [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- Google Cloud: [Envelope Encryption](https://cloud.google.com/kms/docs/envelope-encryption)
- W3C: [PROV-DM — The PROV Data Model](https://www.w3.org/TR/prov-dm/)

