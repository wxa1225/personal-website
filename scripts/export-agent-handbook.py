"""Export the public curriculum as a portable Markdown/Obsidian vault."""
from pathlib import Path
import json, os, re, zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src/content/agent-handbook'
DEST = ROOT / 'public/agent-handbook/agent-handbook-markdown.zip'
CATALOG = json.loads((ROOT/'src/data/agent-curriculum.json').read_text())
files = sorted(SOURCE.rglob('*.md'))
routes = {'/learn/agent' if path.stem == '00-overview' else '/learn/agent/' + path.relative_to(SOURCE).with_suffix('').as_posix(): path for path in files}
DEST.parent.mkdir(parents=True, exist_ok=True)
contents = {}
for path in files:
    source = path.read_text()
    front, body = source.split('---', 2)[1:]
    title = json.loads(next(line[7:] for line in front.splitlines() if line.startswith('title: ')))
    def local_link(match):
        raw = match.group(1)
        route, _, fragment = raw.partition('#')
        route = route.split('?')[0].rstrip('/')
        if route not in routes:
            raise ValueError(f'Broken route in {path.name}: {raw}')
        target = os.path.relpath(routes[route], path.parent).replace(os.sep, '/')
        return '](' + target + ('#' + fragment if fragment else '') + ')'
    body = re.sub(r'\]\((/learn/agent[^)]*)\)', local_link, body)
    if path.stem == '00-overview':
        body += '\n\n## 深读节点索引\n\n'
        for domain in CATALOG['domains']:
            body += '\n### ' + domain['title'] + '\n\n'
            for node in CATALOG['concepts']:
                if node['domain'] == domain['id']:
                    body += '- [' + node['id'] + ' · ' + node['title'] + '](deep/' + node['slug'] + '.md)：' + node['question'] + '\n'
    contents[path.relative_to(SOURCE).as_posix()] = '# ' + title + '\n\n' + body.strip() + '\n'

canvas_nodes=[]
canvas_edges=[]
for col, domain in enumerate(CATALOG['domains']):
    nodes=[n for n in CATALOG['concepts'] if n['domain']==domain['id']]
    canvas_nodes.append(dict(id='group-'+domain['id'],type='group',label=domain['title'],x=col*420,y=0,width=390,height=140+len(nodes)*190))
    for row,n in enumerate(nodes):
        canvas_nodes.append(dict(id=n['id'],type='file',file='deep/'+n['slug']+'.md',x=col*420+20,y=70+row*190,width=350,height=155))
for i,e in enumerate(CATALOG['relations']):
    canvas_edges.append(dict(id='edge-'+str(i),fromNode=e['fromId'],fromSide='right',toNode=e['to'],toSide='left',toEnd='arrow',label=('前置：' if e['type']=='prerequisite' else '应用：')+e['why']))
contents['知识依赖地图.canvas']=json.dumps(dict(nodes=canvas_nodes,edges=canvas_edges),ensure_ascii=False,indent=2)
contents['知识图谱.json']=json.dumps(CATALOG,ensure_ascii=False,indent=2)
contents['开始阅读.md']='''# 大模型技术体系学习笔记

从 [知识总图](00-overview.md) 开始。目录分为数学与学习原理、计算机与软件基础、大模型本体、应用与 Agent、基础设施、评测与改进。

深读页位于 deep/，每篇都有前置依赖、推导、算例或时序、自测答案及后续联系。原有章节与三个扩展导读用于连接主干。

- Typora：直接打开 Markdown 文件；启用 Mermaid 与数学公式显示。
- Obsidian：把整个解压目录作为仓库打开。可打开“知识依赖地图.canvas”拖动节点查看依赖，也可以直接沿章节链接阅读。
- 其他平台：正文是标准 Markdown，图形使用 Mermaid，数学使用 LaTeX。阅读器不支持时仍可读图形源码和文字解释。

Canvas 的箭头以“前置/应用”标注；总图中的分组表示归属。三种关系不要混为一种。

所有算例中的假设均用于教学，不代表作者个人业绩或某家公司的内部项目。高级主题可继续在知识图谱中增加节点与有原因的依赖边。
'''
contents['.obsidian/app.json']=json.dumps({'useMarkdownLinks':True,'newLinkFormat':'relative','attachmentFolderPath':'assets'},ensure_ascii=False)
contents['.obsidian/core-plugins.json']=json.dumps(['file-explorer','global-search','switcher','graph','backlink','outgoing-link','outline','canvas'])
with zipfile.ZipFile(DEST, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name,text in contents.items():
        info=zipfile.ZipInfo(name,date_time=(2026,11,26,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info,text)
print(f'Exported {len(files)} pages, {len(CATALOG["concepts"])} concepts, {len(canvas_edges)} relations to {DEST.relative_to(ROOT)}')
