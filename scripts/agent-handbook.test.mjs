import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import remarkAgentDiagrams from '../src/plugins/remark-agent-diagrams.ts'

const directory = new URL('../src/content/agent-handbook/', import.meta.url)
const files = fs.readdirSync(directory).filter(file => file.endsWith('.md'))
const chapters = files.map(file => ({ file, source: fs.readFileSync(new URL(file, directory), 'utf8') }))
const routes = new Set(chapters.map(({ file }) => file.startsWith('00-') ? '/learn/agent' : '/learn/agent/' + path.basename(file, '.md')))

test('all ten chapters have valid cross references and standard math blocks', () => {
  assert.equal(chapters.length, 10)
  let diagrams = 0, formulas = 0
  for (const { file, source } of chapters) {
    assert.ok(source.startsWith('---\n'), file)
    assert.ok(source.includes('order: '), file)
    assert.ok(!source.includes('```math'), file)
    for (const match of source.matchAll(/\]\((\/learn\/agent[^)]*)\)/g)) {
      assert.ok(routes.has(match[1]), file + ': ' + match[1])
    }
    diagrams += [...source.matchAll(/```mermaid/g)].length
    const delimiters = [...source.matchAll(/^\$\$$/gm)].length
    assert.equal(delimiters % 2, 0, file)
    formulas += delimiters / 2
  }
  assert.equal(diagrams, 23)
  assert.equal(formulas, 15)
})

test('public teaching edition excludes private project records and account-only links', () => {
  const all = chapters.map(x => x.source).join('\n')
  for (const forbidden of ['TaskArena', 'Flywheel', 'Bohrium', '深势', 'dptechnology', 'chatgpt.com/space', '/Users/dp']) {
    assert.ok(!all.includes(forbidden), forbidden)
  }
  const cases = chapters.find(x => x.file.startsWith('09-')).source
  assert.ok(cases.includes('教学案例'))
  assert.ok(cases.includes('不对应某个公司的内部实现或个人履历'))
})

test('Mermaid transform preserves non-diagram code and escapes authored HTML', () => {
  const ordinary = { type: 'code', lang: 'python', value: 'print("test")' }
  const diagram = { type: 'code', lang: 'mermaid', value: 'A["<img src=x onerror=alert(1)>"] --> B' }
  const tree = { type: 'root', children: [{ type: 'blockquote', children: [diagram] }, ordinary] }
  remarkAgentDiagrams()(tree)
  assert.equal(ordinary.type, 'code')
  assert.equal(ordinary.value, 'print("test")')
  assert.equal(diagram.type, 'html')
  assert.ok(!diagram.value.includes('<img'))
  assert.ok(diagram.value.includes('&lt;img'))
  assert.ok(diagram.value.includes('data-expand-diagram'))
})

test('download and local renderer are shipped without a CDN dependency', () => {
  const root = new URL('../', import.meta.url)
  assert.ok(fs.statSync(new URL('public/agent-handbook/agent-handbook-markdown.zip', root)).size > 1000)
  assert.ok(fs.statSync(new URL('public/vendor/agent-handbook/mermaid.min.js', root)).size > 100000)
  const component = fs.readFileSync(new URL('src/components/AgentDiagrams.astro', root), 'utf8')
  assert.ok(component.includes("src='/vendor/agent-handbook/mermaid.min.js'"))
})
