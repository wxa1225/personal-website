import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = new URL('../.vercel/output/static/', import.meta.url).pathname
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(directory,item.name)) : [path.join(directory,item.name)])
const files = walk(root).filter(file => file.endsWith('.html') && /\/(learn|radar)\//.test(file))
assert.ok(files.length >= 60, 'missing learning and radar pages')
const routeFiles = new Map()
for (const file of walk(root)) {
  const relative = '/' + path.relative(root, file)
  routeFiles.set(relative, file)
  if (relative.endsWith('/index.html')) routeFiles.set(relative.slice(0, -11) || '/', file)
  if (relative.endsWith('.html')) routeFiles.set(relative.slice(0,-5), file)
}
let links = 0
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8')
  assert.ok(!html.includes('katex-error'), 'math rendering error: ' + file)
  for (const [, link] of html.matchAll(/href="(\/(?:learn|radar|agent-handbook)[^"]*)"/g)) {
    const route = link.replaceAll('&amp;', '&').split(/[?#]/)[0].replace(/\/$/, '')
    assert.ok(routeFiles.has(route), `${file}: missing ${route}`)
    links++
  }
}
console.log(JSON.stringify({ learningAndRadarPages: files.length, validInternalLinks: links, mathRenderingErrors: 0 }))
