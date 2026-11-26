export interface ReadingResource {
  id: string
  title: string
  url: string
  publisher: string
  kind: string
  publishedAt: string | null
  checkedAt: string
  conceptIds: string[]
  level: string
  why: string
  readFocus: string
  track?: string
}

export const readingGroups = [
  { id: 'recent', title: '近期研究与思考', description: '近 90 天发表的论文、工程复盘与作者观点，按原文日期排序。' },
  { id: 'foundations', title: '基础与经典', description: '理解原理的经典论文与背景材料；发表时间较早不等于失去阅读价值。' },
  { id: 'living', title: '文档与课程', description: '实现细节、接口与系统学习资料。未注明发布日期的文档不冒充新文章。' },
  { id: 'all', title: '全部资料', description: '合并查看所有资料；有明确发布日期的条目优先，未注明日期的排在后面。' }
] as const

export function readingGroup(item: Pick<ReadingResource, 'kind' | 'publishedAt'>, asOf: string) {
  if (['docs', 'course'].includes(item.kind)) return 'living'
  if (item.publishedAt) {
    const days = (Date.parse(asOf) - Date.parse(item.publishedAt)) / 86_400_000
    if (days >= 0 && days <= 90) return 'recent'
  }
  return 'foundations'
}

export function newestReadings<T extends Pick<ReadingResource, 'publishedAt' | 'id'>>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id))
}

export const readingKind: Record<string, string> = {
  paper: '论文', preprint: '预印本', blog: '技术文章', essay: '作者观点', post: '作者原帖',
  report: '研究报告', docs: '文档', course: '课程'
}
