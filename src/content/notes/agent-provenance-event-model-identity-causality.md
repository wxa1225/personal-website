---
title: '给 Agent 的执行记录连上线：事件、身份和因果'
description: '怎样把零散事件变成可查询的关系，同时处理重复、乱序和迟到的数据。'
publishDate: '2026-07-24'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Provenance
  - Event Model
  - Distributed Systems
  - Observability
language: '中文'
status: '待补充'
---

一份日志按时间排好以后，看起来就像一个完整故事：先收到资料，再调用模型，最后生成报告。但真要问“报告用了哪份资料”，时间顺序还不够。

这篇想把[来源追溯那篇文章](/blog/agent-trajectories-as-provenance-graphs)里的想法往实现上推一步。先约定事件和身份，再考虑怎样把记录连成图。下面的字段是设计草案，重点在它们需要表达的关系。

## 事件发生过，关系还需要整理

运行时比较容易记录的是这些事件：

```text
model.request.started
tool.call.proposed
policy.decision.completed
tool.execution.completed
artifact.version.created
```

图里则会表达：某次模型调用收到了某份输入，某个候选调用来自这次响应，某个文件版本由一次写入产生。

两者不是逐行对应的。一次完成事件可能同时更新活动状态、登记产物、补上生成关系；有些关系还要等多个事件到齐才能确认。

所以，我会把原始事件当作可回看的记录，再用投影逻辑构造查询用的图。以后投影规则有问题，可以从事件重新构建，而不用把图里已经混在一起的数据当成唯一来源。

## 先给事件一个共同的外壳

不同组件发来的记录，至少要知道是谁发的、属于哪次运行、正在描述什么对象，以及有没有重复收到。

```json
{
  "schema": "agent.event/v1",
  "eventId": "evt_01J…",
  "eventType": "tool.execution.completed",
  "occurredAt": "2026-07-24T00:00:03.420Z",
  "observedAt": "2026-07-24T00:00:03.487Z",
  "producer": {
    "service": "tool-runtime",
    "instance": "worker-7",
    "version": "sha256:…"
  },
  "scope": {
    "tenantId": "tenant:…",
    "runId": "run:…",
    "turnId": "turn:…",
    "traceId": "trace:…"
  },
  "subject": {
    "activityId": "activity:tool:…"
  },
  "causationId": "evt_…",
  "correlationId": "call:…",
  "sequence": 14,
  "payload": {},
  "integrity": {
    "previousDigest": "sha256:…",
    "digest": "sha256:…"
  }
}
```

`occurredAt` 是生产方记录的发生时间，`observedAt` 是采集方收到的时间。两者有差异很正常，网络延迟和时钟偏差都会影响它们。

`correlationId` 可以把同一次交互串起来，`causationId` 则用于记录直接触发关系。它们不能随手互换：属于同一个任务，不代表某次搜索导致了另一份文件被写入。

租户和主体范围需要从可信上下文得到并验证，不能让任意生产方靠填一个字段就把事件挂到别人的任务下。

## 一次请求，可能有不止一次尝试

假设工具调用超时后重试。如果两次尝试共用一个执行 ID，前一次的状态就容易被后一次覆盖；如果每次重试又都被记作全新的业务请求，也会丢掉它们之间的关系。

我会把逻辑调用和实际尝试分开：

```text
candidate invocation inv_42
  ├── attempt_1  timed out, outcome unknown
  └── attempt_2  succeeded
```

第一轮超时，可能只是客户端没收到结果，远端究竟有没有写入仍然未知。第二轮成功以后，也不能把第一轮直接改成“什么都没发生”。是否重复产生结果，需要结合幂等键和外部状态核对。

事件本身还需要独立 ID，用于重复投递时去重。文件版本则由存储系统的版本或内容身份标识，不与调用 ID 混用。

## 图里的文件应该是哪一版

一个逻辑资源可以有多个状态版本。`config.json` 被修改以后，图中最好增加一个新版本，记录写入活动使用了旧版本、生成了新版本，而不是直接覆盖原来的节点内容。

```text
write activity
  used file-v6
  generated file-v7

file-v7 wasDerivedFrom file-v6
```

如果外部系统没有稳定版本，可以保存一次观测的身份和能获取到的证据，但要标明无法固定的部分。不能用一个临时拼出来的 ID，让读者误以为内容已经可以重建。

活动也是类似的道理。开始和完成事件描述的通常是同一个 Activity；完成先到、开始后到时，不应该把它的状态从 succeeded 改回 running。投影规则需要处理这种顺序。

## 每条连线也要说清依据

图里一条 `used` 边，可能表示系统确认某份数据进入了请求，也可能只是模型自己声称引用了它。两者的证据不能混在一起。

```json
{
  "edgeId": "edge:…",
  "type": "used",
  "from": "activity:model:3",
  "to": "entity:tool-result:B",
  "role": "context.tool_result",
  "evidence": {
    "level": "observed",
    "producer": "context-builder",
    "eventId": "evt:…"
  },
  "validAt": "…"
}
```

除了来源，还可以记录关系的角色：系统指令、用户请求、工具结果、授权依据。这样查一份报告的输入时，才不会把纯追踪信息和实际上下文一股脑当成同一种依赖。

构造模型输入的组件，适合记录哪些 Entity 被加入；状态存储适合声明哪个版本已经提交；模型自述可以作为声明保存。每个组件尽量只说自己能观察到的部分。

这也意味着，缺少证据时不要悄悄补一条边。留一个明确的 gap，比让图看起来很完整更诚实。

## 并行和乱序，是正常情况

两台机器的墙钟可能有偏差，采集方收到事件的先后也不一定等于发生先后。对于并行分支，可以保留能够确认的先后依赖，不必硬排成唯一的全局顺序。

消息管道还会重投，消费者可能处理中断。因此，投影至少要能去重、处理迟到事件，并让相同记录重建出一致结果。

```text
apply(event)         幂等
apply(A, B)          在无依赖时尽量顺序无关
rebuild(all_events)  得到相同图
```

实现时，去重判断和对应的写入需要合适的事务或唯一约束。只先查一句“这个 ID 存在吗”，再分别写节点和边，遇到并发或崩溃仍然可能重复。

同一个事件 ID 如果带来不同内容，也不能当作普通重试静默忽略，应按冲突处理。缺失开始事件但收到完成事件时，可以保存部分状态，不能凭空编出一个开始时间。

## 从提议到写入，连一次看看

下面是一组示意事件，先记录候选调用，再记录授权，最后记录执行结果：

```json
{
  "eventType": "tool.call.proposed",
  "subject": {"invocationId": "inv:42"},
  "payload": {
    "generatedBy": "activity:model:3",
    "toolSchema": "entity:tool-schema:abc",
    "argumentsDigest": "entity:args:def"
  }
}
```

```json
{
  "eventType": "policy.decision.issued",
  "subject": {"decisionId": "decision:9"},
  "causationId": "evt:proposal",
  "payload": {
    "invocationId": "inv:42",
    "outcome": "allow",
    "policy": "entity:policy:b519",
    "grant": "entity:grant:781a"
  }
}
```

```json
{
  "eventType": "tool.execution.completed",
  "subject": {"activityId": "activity:tool:77"},
  "correlationId": "inv:42",
  "payload": {
    "attemptId": "attempt:1",
    "usedDecision": "decision:9",
    "usedResource": "entity:file:v6",
    "generatedResource": "entity:file:v7",
    "status": "succeeded"
  }
}
```

投影时，把候选调用关联到生成它的模型活动，把授权决定关联到候选调用，再把工具执行关联到授权和输入版本。文件的新版本由实际写入活动生成。

还要留意这些声明来自谁。能发送普通工具事件的生产方，不应因此获得伪造权限决定的资格。字段校验、生产方身份和范围验证要一起做。

## 先用几个乱序用例检验它

我准备先做一个内存投影器，反复投递同一事件、交换无依赖事件的顺序，再故意丢掉部分记录。看最终图是否稳定，缺口是否可见，完成状态是否被迟到事件覆盖。

旧版本事件也需要能解释。Schema 升级时，可以明确转换规则，但不要悄悄给同名字段换语义。查询层再加上租户和关系级别的权限限制，避免沿一条边走到原本无权查看的数据。

做到这些以后，再考虑复杂图查询才更踏实。画出节点和箭头很容易，让每条关系都能回答“你凭什么这样连”，才是这份笔记想继续补齐的部分。

## 继续读

- [Agent 出了错，为什么翻聊天记录还不够？](/blog/agent-trajectories-as-provenance-graphs)
- W3C: [PROV-DM — The PROV Data Model](https://www.w3.org/TR/prov-dm/)
- W3C: [PROV-N](https://www.w3.org/TR/prov-n/)
- OpenTelemetry: [Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- W3C: [Trace Context](https://www.w3.org/TR/trace-context/)
- Lamport, [Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
- Kleppmann et al., [Local-First Software: You Own Your Data, in spite of the Cloud](https://www.inkandswitch.com/local-first/)
