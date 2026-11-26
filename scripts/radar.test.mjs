import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import katex from 'katex'
import { freshness } from '../src/lib/radar-dates.ts'
import { recentPublication, groupByPublication } from '../src/lib/radar-feed.ts'
import { readingGroup, newestReadings } from '../src/lib/learning-reading.ts'

const root = new URL('../', import.meta.url)
const read = file => fs.readFileSync(new URL(file, root), 'utf8')
const json = file => JSON.parse(read(file))
const concepts = json('src/data/agent-curriculum.json').concepts
const quant = ['market-data', 'signals-validation', 'portfolio-risk', 'backtest-execution', 'ai-quant', 'macro-evidence']
const ids = new Set([...concepts.map(node => node.id), ...quant.map((_, i) => `Q${i + 1}`)])
const resources = json('src/data/learning-resources.json')
const sources = json('src/data/radar-sources.json')
const issueFiles = fs.readdirSync(new URL('src/data/briefings/', root)).filter(name => name.endsWith('.json'))
const issues = issueFiles.map(file => ({ file, issue: json('src/data/briefings/' + file) }))
function date(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(new Date(value).toISOString().slice(0, 10), value)
}
function publicUrl(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'https:')
  assert.ok(!url.username && !url.password)
  assert.ok(!/localhost|127\.0\.0\.1|feishu|git\.dp\./.test(url.hostname))
}

test('all knowledge nodes have actionable reading cards with public primary-source links', () => {
  assert.equal(new Set(resources.map(item => item.id)).size, resources.length)
  assert.equal(new Set(resources.map(item => item.url)).size, resources.length)
  for (const id of ids) assert.ok(resources.some(item => item.conceptIds.includes(id)), 'missing reading: ' + id)
  for (const item of resources) {
    publicUrl(item.url); date(item.checkedAt)
    if (item.publishedAt) { date(item.publishedAt); assert.ok(item.publishedAt <= item.checkedAt) }
    assert.ok(item.readFocus.length >= 15 && item.why.length >= 10, item.id)
    assert.ok(['入门','深入','拓展'].includes(item.level))
    for (const id of item.conceptIds) assert.ok(ids.has(id), item.id + ' -> ' + id)
  }
})

test('news editions preserve source dates and facts without requiring teaching commentary', () => {
  assert.ok(issues.length > 0)
  for (const { file, issue } of issues) {
    date(issue.date); date(issue.checkedAt); date(issue.coverage.start); date(issue.coverage.end)
    assert.equal(file, issue.date + '.json')
    assert.ok(issue.coverage.start <= issue.coverage.end && issue.coverage.end <= issue.checkedAt)
    assert.ok(issue.checkedAt >= issue.date)
    assert.ok(issue.coverage.note.length > 10)
    assert.ok(Array.isArray(issue.coverage.gaps))
    const itemIds = new Set(issue.items.map(item => item.id))
    assert.equal(itemIds.size, issue.items.length)
    const urls = new Set()
    for (const item of issue.items) {
      assert.match(item.id, /^[a-z0-9-]+$/)
      assert.ok(['ai','quant'].includes(item.channel))
      publicUrl(item.url); date(item.checkedAt)
      assert.ok(!urls.has(item.url), 'duplicate source in issue: ' + item.url); urls.add(item.url)
      if (item.publishedAt !== null) { date(item.publishedAt); assert.ok(item.publishedAt <= item.checkedAt) }
      assert.ok(item.checkedAt <= issue.checkedAt)
      assert.ok(typeof item.facts === 'string' && item.facts.length >= 12, item.id)
      if (item.eventAt) { date(item.eventAt); assert.ok(item.eventAt <= issue.checkedAt) }
      for (const id of item.conceptIds || []) assert.ok(ids.has(id), item.id + ' -> ' + id)
    }
    for (const takeaway of issue.takeaways || []) {
      assert.ok(takeaway.text.length > 10 && takeaway.itemIds.length > 0)
      for (const id of takeaway.itemIds) assert.ok(itemIds.has(id), 'ungrounded takeaway: ' + id)
    }
    for (const correction of issue.corrections || []) { date(correction.date); assert.ok(correction.reason.length > 10) }
  }
})

test('historical papers cannot be mislabeled as recent just because they were checked today', () => {
  assert.equal(freshness('2026-11-25', '2026-11-26'), '近两日发布')
  assert.equal(freshness('2026-11-24', '2026-11-26'), '近一周发布')
  assert.equal(freshness('2025-05-21', '2026-11-26'), '背景与补读')
  assert.equal(freshness(null, '2026-11-26'), '原文日期未明确')
})

test('reading library separates recent thinking from timeless references using publication dates', () => {
  const asOf = '2026-11-26'
  assert.equal(readingGroup({kind:'paper', publishedAt:'2026-11-22'}, asOf), 'recent')
  assert.equal(readingGroup({kind:'paper', publishedAt:'2017-06-12'}, asOf), 'foundations')
  assert.equal(readingGroup({kind:'blog', publishedAt:null}, asOf), 'foundations')
  assert.equal(readingGroup({kind:'docs', publishedAt:null}, asOf), 'living')
  assert.equal(readingGroup({kind:'docs', publishedAt:'2026-11-25'}, asOf), 'living')
  assert.equal(readingGroup({kind:'blog', publishedAt:'2026-11-27'}, asOf), 'foundations')
  assert.equal(readingGroup({kind:'blog', publishedAt:'2026-08-28'}, asOf), 'recent')
  assert.equal(readingGroup({kind:'blog', publishedAt:'2026-08-27'}, asOf), 'foundations')
  const input = [{id:'undated',publishedAt:null},{id:'old',publishedAt:'2025-01-01'},{id:'new',publishedAt:'2026-11-26'}]
  assert.deepEqual(newestReadings(input).map(x => x.id), ['new','old','undated'])
  assert.equal(input[0].id, 'undated')
})

test('quant lessons have worked explanations, diagrams, answered self-checks and valid formulas', () => {
  for (const [index, slug] of quant.entries()) {
    const text = read('src/content/quant-handbook/' + slug + '.md')
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    assert.ok(match, slug)
    const meta = parseYaml(match[1]), body = match[2]
    assert.equal(meta.conceptId, `Q${index + 1}`)
    assert.ok(meta.title && meta.description)
    assert.ok(body.includes('```mermaid') && body.includes('教学') && body.includes('https://'), slug)
    assert.ok([...body.matchAll(/<details>/g)].length >= 3, slug + ': needs answered self-checks')
    assert.equal([...body.matchAll(/^```/gm)].length % 2, 0)
    for (const [, math] of body.matchAll(/^\$\$\s*\n([\s\S]*?)\n\$\$/gm)) assert.doesNotThrow(() => katex.renderToString(math, { displayMode: true, throwOnError: true }), slug)
  }
})

test('source library and editorial policy preserve access limits and public/private boundaries', () => {
  assert.equal(new Set(sources.map(item => item.id)).size, sources.length)
  for (const source of sources) { publicUrl(source.url); assert.ok(source.focus && source.readingRule) }
  const data = JSON.stringify([resources,sources,issues])
  for (const privateText of ['/Users/dp','TaskArena','Bohrium','飞书群','git.dp.tech','wxid_']) assert.ok(!data.includes(privateText), privateText)
  assert.ok(read('src/pages/radar/method.astro').includes('本地 Codex'))
  assert.ok(read('docs/daily-radar-runbook.md').includes('不 force push'))
})


test('feed separates actual recent events, older material and undated discoveries', () => {
  const items = [
    {id:'old', publishedAt:'2015-02-27'},
    {id:'undated', publishedAt:null},
    {id:'event', publishedAt:null, eventAt:'2026-11-25'},
    {id:'today', publishedAt:'2026-11-26'},
    {id:'future', publishedAt:'2026-11-27'}
  ]
  assert.deepEqual(items.filter(x => recentPublication(x,'2026-11-26')).map(x=>x.id), ['event','today'])
  assert.deepEqual(groupByPublication(items.slice(0,4)).map(g=>g.date), ['2026-11-26','2026-11-25','2015-02-27','日期未注明'])
})
