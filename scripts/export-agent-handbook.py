"""Export the public handbook as a portable Markdown vault. Python standard library only."""
from pathlib import Path
import json, re, zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src/content/agent-handbook'
DEST = ROOT / 'public/agent-handbook/agent-handbook-markdown.zip'
files = sorted(SOURCE.glob('*.md'))
DEST.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(DEST, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        text = path.read_text()
        front, body = text.split('---', 2)[1:]
        title_line = next(line for line in front.splitlines() if line.startswith('title: '))
        title = json.loads(title_line[7:])
        for target in files[1:]:
            body = body.replace('](/learn/agent/' + target.stem + ')', '](' + target.name + ')')
        body = body.replace('](/learn/agent)', '](' + files[0].name + ')')
        archive.writestr(path.name, '# ' + title + '\n\n' + body.strip() + '\n')
    archive.writestr('开始阅读.md', '''# Agent 研发原理与实践

从 [知识总图](00-overview.md) 开始。正文使用标准 Markdown、Mermaid 框图和 LaTeX 数学块。

Typora 可以直接打开章节；Obsidian 可以将解压后的文件夹作为本地仓库。图形和公式需要阅读器支持相应格式。

本文件夹为公开教学版，案例用于解释原理，不代表某家公司的内部实现或作者个人业绩。
''')
print(f'Exported {len(files)} chapters to {DEST.relative_to(ROOT)}')
