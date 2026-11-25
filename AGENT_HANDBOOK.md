# Agent 学习专栏

专栏入口为 `/learn/agent`，正文放在 `src/content/agent-handbook`。导航栏和 Notes 页面均有入口。该目录只有公开教学内容，不包含私人项目复盘。

## 编辑与迁移

直接编辑 Markdown 文件，保持 `order`、`prerequisites` 和章节链接一致。数学公式使用 `$$`，框图使用 Mermaid 代码围栏。构建时生成可索引正文与公式，浏览器使用随仓库保存的 Mermaid 渲染器绘制框图，可放大和查看源码。

更新后运行 `python3 scripts/export-agent-handbook.py`，刷新供读者下载的 Markdown 笔记库。解压即可在 Typora 阅读或作为 Obsidian 仓库打开。

## 验证

```sh
python3 scripts/export-agent-handbook.py
node --test scripts/agent-handbook.test.mjs
ASTRO_TELEMETRY_DISABLED=1 npm run build
```

渲染器来源与摘要记录在 `public/vendor/agent-handbook/README.md`，许可证随资源保存。以后更新渲染器时，应重新核对 23 幅图的语法与显示。

## 发布

本仓库原有 Astro 与 Vercel 部署结构保留。将已验证的分支推送到 `wxa1225/personal-website` 后，可以沿现有 Vercel 项目预览、合并和发布。GitHub 个人资料仓库 `wxa1225/wxa1225` 可以在专栏上线后补一条入口链接；它与本站源码仓库是两个不同目标。
