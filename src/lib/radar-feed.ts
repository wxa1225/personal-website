type DatedItem = { publishedAt: string | null; eventAt?: string; id: string }
/** Sort by original publication, never retrieval date. */
export function recentPublication(item: DatedItem, issueDate: string) {
  const date = item.publishedAt ?? item.eventAt
  if (!date) return false
  const days = (Date.parse(issueDate) - Date.parse(date)) / 86400000
  return days >= 0 && days <= 7
}
export function groupByPublication<T extends DatedItem>(items: T[]) {
  const groups = new Map<string, T[]>()
  for (const item of [...items].sort((a,b) => (b.publishedAt ?? b.eventAt ?? '').localeCompare(a.publishedAt ?? a.eventAt ?? ''))) {
    const date = item.publishedAt ?? item.eventAt ?? '日期未注明'
    if (!groups.has(date)) groups.set(date, [])
    groups.get(date)!.push(item)
  }
  return [...groups].map(([date, items]) => ({ date, items }))
}
