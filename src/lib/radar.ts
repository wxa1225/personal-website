import { concepts } from './agent-curriculum'
export { freshness } from './radar-dates'

export type RadarChannel = 'ai' | 'quant'
export type RadarItem = {
  id: string; channel: RadarChannel; category: string; title: string
  url: string; publisher: string; publishedAt: string | null; checkedAt: string
  facts: string; interpretation: string; limits: string; readFocus: string
  conceptIds: string[]; followUp: string
}
export type RadarIssue = {
  date: string; title: string; summary: string; checkedAt: string
  coverage: { start: string; end: string; note: string; gaps: string[] }
  takeaways: { text: string; itemIds: string[] }[]
  items: RadarItem[]
  corrections?: { date: string; reason: string }[]
}
export type RadarSource = {
  id: string; title: string; url: string; publisher: string
  channel: RadarChannel; type: string; focus: string; readingRule: string
}
export const channels = { ai: 'AI 前沿', quant: '量化与市场' } as const
const modules = import.meta.glob<{ default: RadarIssue }>('../data/briefings/*.json', { eager: true })
export const issues = Object.values(modules).map(entry => entry.default).sort((a, b) => b.date.localeCompare(a.date))
export const allItems = issues.flatMap(issue => issue.items.map(item => ({ ...item, issueDate: issue.date })))
export const quantNodes = [
  { id: 'Q1', slug: 'market-data', title: '市场、数据与信息时点', question: '这份数据在决策时真的已知吗？' },
  { id: 'Q2', slug: 'signals-validation', title: '信号与统计检验', question: '发现的是可重复信号，还是多次试验后的幸运结果？' },
  { id: 'Q3', slug: 'portfolio-risk', title: '组合与风险', question: '多个好信号放在一起，为什么仍可能同时亏损？' },
  { id: 'Q4', slug: 'backtest-execution', title: '回测、成本与执行', question: '纸面收益为什么不能直接兑现？' },
  { id: 'Q5', slug: 'ai-quant', title: 'AI 量化与研究平台', question: 'Agent 提高研究速度后，怎样避免更快地过拟合？' },
  { id: 'Q6', slug: 'macro-evidence', title: '宏观、产业与证据', question: '一条消息怎样影响现金流、折现率和风险偏好？' }
]
export function knowledgeLink(id: string) {
  const node = concepts.find(node => node.id === id)
  if (node) return { title: node.title, url: `/learn/agent/deep/${node.slug}` }
  const quant = quantNodes.find(node => node.id === id)
  return quant ? { title: quant.title, url: `/learn/quant/${quant.slug}` } : undefined
}
