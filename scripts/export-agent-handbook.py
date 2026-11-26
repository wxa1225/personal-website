"""Export the public curriculum as a portable Markdown/Obsidian vault."""
from pathlib import Path
import json, os, re, zipfile
from datetime import date

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src/content/agent-handbook'
QUANT_SOURCE = ROOT / 'src/content/quant-handbook'
DEST = ROOT / 'public/agent-handbook/agent-handbook-markdown.zip'
CATALOG = json.loads((ROOT/'src/data/agent-curriculum.json').read_text())
RESOURCES = json.loads((ROOT/'src/data/learning-resources.json').read_text())
AS_OF = max(item['checkedAt'] for item in RESOURCES)
def reading_group(item):
    if item['kind'] in ('docs', 'course'):
        return '文档与课程'
    if item['publishedAt'] and 0 <= (date.fromisoformat(AS_OF) - date.fromisoformat(item['publishedAt'])).days <= 90:
        return '近期研究与思考'
    return '基础与经典'
RESOURCES.sort(key=lambda item: item['publishedAt'] or '', reverse=True)
quant_files = sorted(QUANT_SOURCE.glob('*.md'), key=lambda path: int(re.search(r'^order:\s*(\d+)', path.read_text(), re.M).group(1)))
files = sorted(SOURCE.rglob('*.md')) + quant_files
titles = {}
def archive_name(path):
    return 'quant/' + path.name if path.parent == QUANT_SOURCE else path.relative_to(SOURCE).as_posix()
routes = {}
for path in files:
    route = '/learn/quant/' + path.stem if path.parent == QUANT_SOURCE else ('/learn/agent' if path.stem == '00-overview' else '/learn/agent/' + path.relative_to(SOURCE).with_suffix('').as_posix())
    routes[route] = archive_name(path)
routes['/learn/quant'] = 'quant/index.md'
DEST.parent.mkdir(parents=True, exist_ok=True)
contents = {}
for path in files:
    source = path.read_text()
    front, body = source.split('---', 2)[1:]
    title = json.loads(next(line[7:] for line in front.splitlines() if line.startswith('title: ')))
    titles[path] = title
    node_id = re.search(r'^conceptId:\s*"?([^"\n]+)"?$', front, re.M)
    selected = [item for item in RESOURCES if node_id and node_id.group(1) in item['conceptIds']]
    if selected:
        body += '\n\n## 拓展：原始资料阅读卡\n\n'
        for item in selected:
            body += '### [' + item['title'] + '](' + item['url'] + ')\n\n'
            body += reading_group(item) + ' · ' + item['level'] + ' · ' + item['publisher'] + ' · 原文 ' + (item['publishedAt'] or '日期未注明') + ' · 核验 ' + item['checkedAt'] + '\n\n'
            body += '**为什么读：**' + item['why'] + '\n\n**重点位置与问题：**' + item['readFocus'] + '\n\n'
    body += '\n\n[每日前沿与量化观察](https://siaspace.vercel.app/radar) · [完整资料目录](https://siaspace.vercel.app/learn/resources)\n'
    def local_link(match):
        raw = match.group(1)
        route, _, fragment = raw.partition('#')
        route = route.split('?')[0].rstrip('/')
        if route not in routes:
            raise ValueError(f'Broken route in {path.name}: {raw}')
        target = os.path.relpath(routes[route], Path(archive_name(path)).parent).replace(os.sep, '/')
        return '](' + target + ('#' + fragment if fragment else '') + ')'
    body = re.sub(r'\]\((/learn/(?:agent|quant)[^)]*)\)', local_link, body)
    if path.stem == '00-overview':
        body += '\n\n## 深读节点索引\n\n'
        for domain in CATALOG['domains']:
            body += '\n### ' + domain['title'] + '\n\n'
            for node in CATALOG['concepts']:
                if node['domain'] == domain['id']:
                    body += '- [' + node['id'] + ' · ' + node['title'] + '](deep/' + node['slug'] + '.md)：' + node['question'] + '\n'
    contents[archive_name(path)] = '# ' + title + '\n\n' + body.strip() + '\n'

contents['quant/index.md'] = '# 量化研究学习地图\n\n先从数据可知时间开始，走到信号检验、组合风险、回测执行、AI研究平台与宏观证据。\n\n' + '\n'.join('- [' + titles[path] + '](' + path.name + ')' for path in quant_files) + '\n\n[大模型知识总图](../00-overview.md)\n'
contents['原始资料阅读库.json'] = json.dumps(RESOURCES, ensure_ascii=False, indent=2)
contents['原始资料阅读库.md'] = '# 原始资料阅读库\n\n核验至 ' + AS_OF + '。近期按原文日期计算，未注明日期的资料不冒充最新内容。\n'
for group in ('近期研究与思考', '基础与经典', '文档与课程'):
    contents['原始资料阅读库.md'] += '\n## ' + group + '\n\n'
    for item in RESOURCES:
        if reading_group(item) == group:
            contents['原始资料阅读库.md'] += '### [' + item['title'] + '](' + item['url'] + ')\n\n' + item['publisher'] + ' · ' + (item['publishedAt'] or '日期未注明') + '\n\n' + item['why'] + '\n\n**阅读重点：**' + item['readFocus'] + '\n\n'

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

新增 [量化研究学习地图](quant/index.md)，连接市场数据、统计检验、组合风险、回测执行、AI研究平台和宏观证据。每篇深读末尾都有原始资料阅读卡；完整结构化目录保存在“原始资料阅读库.json”。[每日观察](https://siaspace.vercel.app/radar) 保留在网站，离线笔记不冒充实时资讯。

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
