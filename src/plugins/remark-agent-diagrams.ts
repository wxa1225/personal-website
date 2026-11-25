type MarkdownNode = {
  type: string
  lang?: string | null
  value?: string
  children?: MarkdownNode[]
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }
    return entities[char] ?? char
  })

export default function remarkAgentDiagrams() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'code' && node.lang === 'mermaid') {
        const source = escapeHtml(node.value ?? '')
        node.type = 'html'
        node.value = `<figure class="agent-diagram"><div class="agent-diagram-actions"><button type="button" data-expand-diagram disabled>放大框图</button></div><pre class="mermaid">${source}</pre><details><summary>查看图形源码</summary><pre><code>${source}</code></pre></details></figure>`
        delete node.lang
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
