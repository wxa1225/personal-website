---
title: 'Agent 日志该留多少，又该怎样删？'
description: '把执行关系和敏感内容分开，讨论日志校验、脱敏与删除后的追溯。'
publishDate: '2026-07-24'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Provenance
  - Integrity
  - Privacy
  - Data Retention
language: '中文'
status: '待补充'
---

排查 Agent 问题时，总希望记录再详细一点。真正开始保存，又会发现输入和工具响应里可能混着用户文件、内部地址，甚至不该出现的凭证。

于是问题从“怎么多记一点”变成了：哪些值得记，怎样证明没被改过，过期以后又怎样删除？这篇把这几件事放在一起看，避免先把所有数据存下来，再回头补规则。

## 加 Hash 之前，先问要防什么

传输丢失、有人修改日志、组件从一开始就报告了假结果，是不同的问题。Hash 能帮助校验拿到的内容，却不会告诉我们世界上是否还有一条从没被记录的操作。

原文里容易混用的几个词，可以这样分开：

```text
Integrity     已有记录是否被修改
Authenticity 记录是否来自声称的 Producer
Completeness 应记录的事件是否都存在
Truthfulness Producer 的声明是否符合现实
```

签名也有类似边界。它可以帮助确认某份声明与某个密钥的关系，但持有密钥的组件仍可能说错，密钥也可能被泄露。

所以，一份完整性方案应该写清楚它假设谁可信、主要防哪类修改，以及哪些行为仍然看不到。否则校验结果变成一个绿色勾号以后，很容易被理解成“里面说的都是真的”。

## 单条事件流，可以先接成一条链

对于单个生产方的有序事件流，可以让每条记录包含前一条的摘要：

```text
h0 = domain-separated genesis
hi = H(version || stream_id || sequence_i || event_bytes_i || h(i-1))
```

流身份、序号和编码方式都要固定。生产方重启后，也要明确新旧流怎样关联，避免序号从头开始却被误当成同一段连续历史。

链本身还需要可信的检查点。否则拿到一段自洽的记录，并不能自动知道尾部是不是被截掉了。把链头或根摘要保存到独立、受保护的位置，可以帮助检测这种变化，但依然不能证明记录器没有绕过采集。

## 多个 Worker 不必排成一条假想的总时间线

模型网关、工具运行时、权限服务和状态存储，可能各自产生事件。可以保留各自的有序流，再定期汇总检查点：

```text
head(A) ─┐
head(B) ─┼→ Merkle root R42 → signed checkpoint
head(C) ─┤
head(D) ─┘
```

Merkle 结构方便证明某项记录包含在某个根下；需要验证历史扩展一致性时，还要采用支持相应证明的结构和协议。它不会顺便证明某条记录为什么发生。

签名之前的编码规则也要统一。键顺序、空白、数字和字段排除规则不同，可能让语义相同的数据得到不同摘要。生产方声明和采集方后来补充的观察信息，最好分清各自签名覆盖的范围。

## 状态写成功，事件却没发出去

如果先更新数据库，再发日志，进程恰好在中间退出，就可能留下已经发生的状态变化，却没有相应事件。

对于同一数据库内的操作，可以考虑把状态更新和 Outbox 记录放进同一个事务。下面只表示这个结构，省略了具体参数和行数检查：

```sql
BEGIN;
UPDATE artifacts SET version = 7 WHERE id = 42 AND version = 6;
INSERT INTO outbox(event_id, event_payload) VALUES (...);
COMMIT;
```

后台再从 Outbox 投递事件，并让消费端处理重复。这样能缩小状态与记录分离的窗口，但不等于把远程 API 的副作用也纳入了同一个事务。远端部分仍然需要回执、幂等或后续核对。

关键操作还可以结合独立来源，例如权限服务的决定 ID、存储系统返回的版本。比起让同一个 Host 执行、记录并证明全部事情，多一个可以交叉核对的来源往往更有用。

## 正文和关系，分开保管

图里需要知道“这份报告依赖过一个输入”，不一定意味着每个能看图的人都应读取输入全文。

```text
Event / Graph Store
  id, type, relation, time, classification,
  payload_ref, payload_digest, retention_class

Payload Store
  encrypted prompt / response / tool result / document

Key Store
  tenant / purpose / payload data keys
```

我会把正文存取与图查询分开授权，并设置不同的保留规则。Token、Cookie、私钥等信息尽量在进入事件管道之前排除，而不是先送进队列和备份，之后再想办法清理。

正则检测可以补充，但不能包办所有秘密识别。已知敏感字段默认不记录、HTTP Header 使用允许列表、超大正文放进受控存储，这些通常更容易检查。

图关系本身也可能泄露信息。一个节点名称、一条项目关联，甚至隐藏结果的数量，都可能暴露调用者原本无权知道的内容。授权不能只放在下载正文的接口上。

## 只留下摘要，也未必匿名

如果原文只有两个可能值，直接保存它的 Hash，别人完全可以把两个值都算一遍再对照。短编号、固定选项等低熵内容也有类似问题。

带密钥的摘要、随机身份或者不保留内容承诺，是不同场景下可以考虑的选择，但都需要明确访问和密钥管理方式。不能简单把原文换成 SHA-256，就宣布隐私问题解决了。

这还会影响删除设计。希望保留多少验证能力，与希望移除多少关联信息之间，可能需要取舍。若彻底移除了某项摘要，就应说明哪些旧的验证保证不再成立。

## 删除内容，别悄悄改写历史声明

直接从已经签名的事件里删字段，会破坏原来的校验。更容易管理的一种设计，是让事件引用独立正文，删除时改变正文的可用状态，并追加相应的治理记录。

正文不可用以后，可以保留最小的占位信息，让关系仍然有处可连：

```text
stable entity ID
coarse type
classification
relation edges
payload unavailable reason
redaction policy/time
```

但这个标记只说明曾有一个输入，不再证明输入的具体内容。对有权限的查询者，要区分删除、到期和暂不可访问；对没有权限的人，也不能用这些状态暴露原本隐藏的对象。

如果采用加密正文和独立数据密钥，销毁密钥可以支持一定范围内的加密擦除。不过它只覆盖相应密文，已经解密、导出或复制出去的内容仍需要另外处理。

## 主库之外，还有多少副本

一次输入可能进入缓存摘要、搜索索引、评测样本和导出的报告。删除主库记录以后，这些副本不会自动消失。

因此，保留策略需要跟着数据流走，也要纳入消息队列、对象版本、备份和下载产物。哪些派生内容仍包含原始敏感信息，需要按实际数据和适用策略判断，不能只看它是不是“处理过”。

保留期限也不适合从一个示例里直接照抄。调试、审计和业务用途不同，期限和例外条件应由实际要求决定；执行结果则要留下可核对的删除或保留记录。

## 我想先验证的两条路径

一条是校验路径：修改、重排或截断记录时，验证器究竟能发现什么，依赖的是哪个可信检查点。

另一条是删除路径：正文到期后，图还能解释什么，备份恢复会不会让内容重新出现，查询是否会误报成“从未存在”。

这两条都跑通，才能比较具体地讨论日志该留多少。我的目标是让排查有据可查，同时让保存下来的每一类数据都有明确用途和退出方式。

## 继续读

- [Agent 出了错，为什么翻聊天记录还不够？](/blog/agent-trajectories-as-provenance-graphs)
- [给 Agent 的执行记录连上线：事件、身份和因果](/notes/agent-provenance-event-model-identity-causality)
- RFC 6962: [Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962)
- in-toto: [Attestation Framework](https://github.com/in-toto/attestation)
- SLSA: [Verifying artifacts](https://slsa.dev/spec/v1.0/verifying-artifacts)
- NIST SP 800-92: [Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final)
- OWASP: [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- Google Cloud: [Envelope Encryption](https://cloud.google.com/kms/docs/envelope-encryption)
- W3C: [PROV-DM — The PROV Data Model](https://www.w3.org/TR/prov-dm/)
