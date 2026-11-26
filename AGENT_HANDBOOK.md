# 大模型学习专栏

保留原入口 `/learn/agent`，内容根已扩为大模型技术体系。知识归属、理解依赖和应用联系分开组织；Agent 运行闭环只属于局部视图。

## 维护结构

- `src/data/agent-curriculum.json`：六个知识分支、节点、带原因的依赖、阅读路径、问题链与岗位视角。
- `src/content/agent-handbook/*.md`：总览与主干导读，保留原有章节地址。
- `src/content/agent-handbook/deep/*.md`：原理深读。每个节点有独立页面、公式或时序、具体算例、反例与自测答案。
- `AgentKnowledgeMap.astro`：可搜索、可定位、可按工作方向查看的知识树。
- `KnowledgePosition.astro`、`KnowledgeSidebar.astro`：深读页的位置与上下游导航。

新增节点时同时添加概念数据与 Markdown 文件，指定 `conceptId`、`kind: lesson`、`parent`。知识归属对应 `domain`；关系只能使用 `prerequisite` 或 `application`，必须填写解释原因的 `why`。前置图必须无环，应用反馈可以形成闭环。岗位视角表达一般工作重心，不是具体公司的最新 JD。

## 内容原则

先提出困惑，再补定义，逐步推导机制，用可检查算例或时序解释，最后讨论取舍、失效条件和验证。公式中的对象、维度、条件与单位要写明。假设案例标为教学，不将读过的材料冒充个人实践。公开版不包含内部项目、公司群消息和个人贡献记录。

Markdown 源码是持续维护的正文。不要运行旧版外部 `build_portable.py` 覆盖本目录；旧脚本对应上一版十章笔记。当前公开版导出使用本仓库的脚本。

## 验证与迁移

```sh
python3 scripts/export-agent-handbook.py
node --test scripts/agent-handbook.test.mjs
ASTRO_TELEMETRY_DISABLED=1 npm run build
```

导出包位于 `public/agent-handbook/agent-handbook-markdown.zip`。包含相对链接 Markdown、Obsidian Canvas 与 JSON 知识图谱，可以在 Typora、Obsidian 或支持标准 Markdown 的平台继续编辑。源码或目录变更后须重新导出。

Mermaid 渲染器随仓库保存，出处和许可证见 `public/vendor/agent-handbook/`。正文在服务端构建，公式在构建时渲染；知识树不依赖 Mermaid 绘图完成。关闭 JavaScript 时仍可用每个节点的“读”链接进入正文。

## 发布

沿 `wxa1225/personal-website` 的既有 GitHub / Vercel 部署发布。推送成功与线上部署完成分别确认。发布后检查总图搜索、节点选择、岗位视角、跨层问题链、手机导航、深读页公式和框图、下载包。
