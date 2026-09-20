---
title: '参数都对，文件工具为什么还要检查权限？'
description: '从一个合法的路径参数出发，区分格式校验、资源解析和真正的文件授权。'
publishDate: '2026-07-23'
updatedDate: '2026-09-20'
tags:
  - Agent
  - Harness
  - MCP
  - Authorization
  - Security
language: '中文'
status: '待补充'
---

一个文件工具的参数通过了 Schema 校验，说明它能被正确解析。至于它能不能读写目标文件，还需要另一套判断。

这个区别听起来很基础，但把工具接给 Agent 以后，很容易混在一起。模型填出了一个真实存在的路径，工具也能打开它，于是操作就继续了。缺少的恰好是中间那句：当前任务被允许这样做吗？

## 从一个格式正确的请求开始

假设工具接收 `path` 和 `content` 两个字符串。下面这组参数没有类型错误：

```json
{
  "path": "/workspace/project/../shared/policy.md",
  "content": "replacement"
}
```

但 `..` 让它指向了项目目录之外的共享文件。工具需要先解析实际目标，再根据当前用户、任务和操作判断权限，不能把 Schema 通过当成授权通过。

我会把整个过程分成四步理解：Schema 读懂参数，Resolver 找到资源，Policy 判断是否允许，Executor 对检查过的资源执行操作。分开以后，也比较容易定位究竟是哪一步出了问题。

## 路径前缀为什么不可靠

这段代码看起来像一个很直接的目录限制：

```python
if path.startswith(workspace):
    return open(path)
```

问题是，字符串前缀和目录关系不是一回事：

```text
/workspace/project-secret   # 字符串前缀相同，却不是 project 的子目录
/workspace/project/../shared
/workspace/project/link     # link 指向 /etc 或其他项目
```

比较路径组件之前，至少需要做规范化和解析。比如下面的函数能检查解析后的目标是否仍然位于指定根目录下：

```python
from pathlib import Path


def resolve_under(root: Path, requested: str) -> Path:
    root = root.resolve(strict=True)
    target = (root / requested).resolve(strict=False)

    if not target.is_relative_to(root):
        raise PermissionError("path escapes authorized root")

    return target
```

不过，这只是第一步，不能拿它当成完整的安全文件访问实现。解析结束以后，真正打开文件之前，路径里的某一级目录仍可能被替换。新建文件时，目标本身还不存在，也需要处理已有父目录的情况。

这种检查与使用之间的竞态，通常叫 TOCTOU。更严格的实现会结合目录句柄、限制符号链接跟随、操作系统提供的安全打开方式，或把文件访问放进合适的 Sandbox。不同平台的具体接口不同，关键是让检查对象与实际操作对象保持一致。

## 授权里需要有谁、做什么、对哪个资源

“这个目录可以访问”还不够细。读取、创建、覆盖和删除，产生的后果不同；当前任务可写的工作区，也不应该和共享 Skill 目录共用一份不加区分的写权限。

授权上下文至少需要绑定调用主体、任务或会话、资源范围和允许的操作。需要跨进程传递时，还要验证凭证的来源、受众和有效期，不能只接受调用参数里自报的用户 ID。

MCP 解决了工具发现和调用的互通问题，但具体资源的授权仍然需要服务端执行。一个受信任的 Host 发来的请求，也可能代表权限不同的用户或任务。

服务端自身有能力读取文件，不等于它应该代表每个调用者读取。这里需要同时满足服务端的能力范围和当前调用者获得的授权。

## 检查通过之后，权限还可能变化

规划时判断某项能力可以使用，有助于减少无效调用。但工具真正执行前，目标参数才完整，任务也可能已经被取消，授权可能已经被撤回。

对于写入，可以让授权决定绑定资源身份、策略版本和任务 generation，再由执行器在提交前核对：

```python
decision = policy.authorize(
    principal=ctx.principal,
    operation="overwrite",
    resource=resolved.resource_id,
    policy_version=ctx.policy_version,
    generation=ctx.generation,
)

executor.write_if_current(
    handle=resolved.handle,
    content=content,
    decision=decision,
)
```

这里是接口示意。`write_if_current` 需要真正保证条件检查和提交之间的约束，不能只是把“检查一次，然后按原字符串打开文件”包进了一个新函数。

资源版本、租约失效和安全文件句柄分别解决不同问题，需要结合实际存储来设计。任务取消时如何让旧结果失去提交资格，可以接着看[子 Agent 取消笔记](/notes/sub-agent-cancellation-resource-ownership)。

## 文件内容不能给自己增加权限

就算一次读取已经被正确授权，读回来的正文也不一定可信。网页、邮件和共享文档里的指令，应该仍被当作外部数据处理。

比如正文要求读取凭证、扩大目录权限，它不能因为被模型看到，就成为下一次调用的授权依据。执行层仍要按原来可信的用户请求和权限上下文检查。

共享 Skill 也值得单独保护。一个任务如果可以随意修改下一次运行会加载的公共指令，影响就可能超出当前工作区。只读资源和任务可写资源应该分开管理。

## 留下能够解释决定的记录

只记一句 `write_file succeeded`，以后很难查清当时为什么允许写入。我更希望能找到主体、目标资源、操作、策略版本、匹配到的规则，以及实际写入结果。

这些记录也不能顺手把密钥或文件全文全写进去。执行证据和敏感正文可以分开保存，只留下核对决定所需的信息。

完整流程可以按下面的顺序检查：

```text
1. Parse       按 Schema 解析参数
2. Identify    绑定 principal / agent / turn
3. Resolve     在授权根内解析资源，拒绝路径逃逸
4. Classify    推导 read / create / overwrite / delete effect
5. Authorize   按主体、操作、资源和上下文决策
6. Open        以安全句柄打开检查过的对象
7. Revalidate  检查租约、generation 与必要的资源版本
8. Execute     原子执行或进入明确的补偿协议
9. Audit       记录决策、结果和关联 ID
10. Return     把结果作为带来源的不受信任数据返回
```

这不是说每个工具都必须有十个独立模块，而是实现时别漏掉相应职责。

## 下一步准备验证什么

我想先补一个很小的文件工具示例，把正常路径、`..`、相似前缀、符号链接替换，以及授权过期放在一起测试。然后再比较不同平台上怎样把解析后的资源与实际操作绑定。

目前最想守住的一点，是请求从参数到执行始终指向同一个被授权对象。Schema 可以帮忙把入口做清楚，真正的权限边界要一直跟到文件被打开和修改的地方。

## 继续读

- [Agent 可以自己做主到哪一步？](/blog/autonomy-is-a-budget)
- [AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://arxiv.org/abs/2406.13352)
- [Model Context Protocol: Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- OWASP: [Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)
- MITRE CWE-367: [Time-of-check Time-of-use Race Condition](https://cwe.mitre.org/data/definitions/367.html)
- Linux manual: [`openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html)
