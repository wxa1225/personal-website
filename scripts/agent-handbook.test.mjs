import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import katex from 'katex'
import { parse as parseYaml } from 'yaml'
import remarkAgentDiagrams from '../src/plugins/remark-agent-diagrams.ts'
import { concepts, domains, relations, learningPaths, roles, problems, connections, searchConcepts } from '../src/lib/agent-curriculum.ts'

const root = new URL('../', import.meta.url)
const directory = new URL('../src/content/agent-handbook/', import.meta.url)
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : [])
const chapters = walk(directory.pathname).map(file => {
  const source = fs.readFileSync(file, 'utf8')
  const [, front, body] = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  return { file, id: path.relative(directory.pathname, file).replace(/\.md$/, ''), source, meta: parseYaml(front), body }
})
const routes = new Set(chapters.map(({ id }) => id === '00-overview' ? '/learn/agent' : '/learn/agent/' + id))
const ids = new Set(concepts.map(node => node.id))

test('knowledge tree, prerequisites and role views resolve to complete lessons', () => {
  assert.equal(domains.length, 6)
  assert.equal(concepts.length, 32)
  assert.equal(ids.size, concepts.length)
  assert.equal(chapters.length, 45)
  for (const node of concepts) {
    assert.ok(domains.some(domain => domain.id === node.domain), node.id)
    const lesson = chapters.find(chapter => chapter.id === 'deep/' + node.slug)
    assert.ok(lesson, node.slug)
    assert.equal(lesson.meta.conceptId, node.id)
    assert.ok(chapters.some(chapter => chapter.id === lesson.meta.parent), node.id)
    assert.ok(lesson.body.includes('```mermaid'), 'diagram: ' + node.id)
    assert.ok(lesson.body.includes('<details>'), 'worked self-check: ' + node.id)
    assert.ok(lesson.body.includes('https://'), 'source: ' + node.id)
  }
  for (const item of [...learningPaths, ...roles, ...problems]) for (const id of item.nodes) assert.ok(ids.has(id), id)
  for (const edge of relations) {
    assert.ok(ids.has(edge.fromId) && ids.has(edge.to), JSON.stringify(edge))
    assert.ok(['prerequisite', 'application'].includes(edge.type))
    assert.ok(edge.why.length > 12, 'relation needs an explanation')
  }
})

test('prerequisite graph is acyclic while application links can form feedback loops', () => {
  const active = new Set(), visited = new Set()
  function visit(id) {
    assert.ok(!active.has(id), 'circular prerequisite at ' + id)
    if (visited.has(id)) return
    active.add(id)
    for (const edge of relations.filter(edge => edge.type === 'prerequisite' && edge.fromId === id)) visit(edge.to)
    active.delete(id); visited.add(id)
  }
  for (const id of ids) visit(id)
  assert.ok(relations.some(edge => edge.type === 'application' && edge.fromId === 'L2' && edge.to === 'E3'))
})

test('question lookup and dependency direction support cross-layer explanations', () => {
  assert.equal(searchConcepts('kv')[0].id, 'M3')
  assert.ok(searchConcepts('超时').some(node => node.id === 'R2'))
  assert.ok(searchConcepts('为什么答错').some(node => node.id === 'M1'))
  assert.ok(searchConcepts('  GQA  ').some(node => node.id === 'M3'))
  assert.equal(searchConcepts('nonexistent-concept').length, 0)
  assert.equal(searchConcepts('').length, concepts.length)
  const { before, after } = connections('R2')
  assert.deepEqual(new Set(before.map(edge => edge.fromId)), new Set(['B2', 'B3']))
  assert.ok(after.some(edge => edge.to === 'R3'))
})

test('every internal chapter link and math block is valid', () => {
  let formulas = 0, diagrams = 0
  for (const { file, source } of chapters) {
    for (const match of source.matchAll(/\]\((\/learn\/agent[^)]*)\)/g)) {
      const route = match[1].split(/[?#]/)[0].replace(/\/$/, '')
      assert.ok(routes.has(route), file + ': ' + match[1])
    }
    assert.equal([...source.matchAll(/^```/gm)].length % 2, 0, 'unclosed code fence: ' + file)
    assert.equal([...source.matchAll(/^\$\$$/gm)].length % 2, 0, 'unclosed math: ' + file)
    for (const [, expression] of source.matchAll(/^\$\$\s*\n([\s\S]*?)\n\$\$/gm)) {
      assert.doesNotThrow(() => katex.renderToString(expression, { displayMode: true, throwOnError: true }), file)
      formulas++
    }
    diagrams += [...source.matchAll(/```mermaid/g)].length
  }
  assert.ok(formulas > 35)
  assert.ok(diagrams >= 45)
})

test('public edition has no private project record or account-only dependency', () => {
  const all = chapters.map(x => x.source).join('\n')
  for (const forbidden of ['TaskArena', 'Flywheel', 'Bohrium', '深势', 'dptechnology', 'chatgpt.com/space', '/Users/dp']) assert.ok(!all.includes(forbidden), forbidden)
  const cases = chapters.find(x => x.id.startsWith('09-')).source
  assert.ok(cases.includes('教学案例') && cases.includes('不对应某个公司的内部实现或个人履历'))
})

test('diagram transform escapes HTML and leaves ordinary code intact', () => {
  const ordinary = { type: 'code', lang: 'python', value: 'print("test")' }
  const diagram = { type: 'code', lang: 'mermaid', value: 'A["<img src=x onerror=alert(1)>"] --> B' }
  const tree = { type: 'root', children: [{ type: 'blockquote', children: [diagram] }, ordinary] }
  remarkAgentDiagrams()(tree)
  assert.equal(ordinary.type, 'code')
  assert.equal(diagram.type, 'html')
  assert.ok(!diagram.value.includes('<img'))
  assert.ok(diagram.value.includes('&lt;img'))
})

test('reading and download do not require a renderer CDN', () => {
  assert.ok(fs.statSync(new URL('public/agent-handbook/agent-handbook-markdown.zip', root)).size > 1000)
  assert.ok(fs.statSync(new URL('public/vendor/agent-handbook/mermaid.min.js', root)).size > 100000)
  const component = fs.readFileSync(new URL('src/components/AgentDiagrams.astro', root), 'utf8')
  assert.ok(component.includes("src='/vendor/agent-handbook/mermaid.min.js'"))
  const map = fs.readFileSync(new URL('src/components/AgentKnowledgeMap.astro', root), 'utf8')
  assert.ok(map.includes('aria-pressed') && map.includes('aria-live'))
  assert.ok(map.includes('astro:page-load'))
  assert.ok(map.includes('class=\'node-read\''))
})
