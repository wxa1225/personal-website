/** Publication dates are evidence, never inferred from retrieval timestamps. */
export function freshness(publishedAt: string | null, issueDate: string) {
  if (!publishedAt) return '原文日期未明确'
  const age = (Date.parse(issueDate + 'T23:59:59+08:00') - Date.parse(publishedAt + 'T00:00:00+08:00')) / 86400000
  return age < 2 ? '近两日发布' : age < 8 ? '近一周发布' : '背景与补读'
}
