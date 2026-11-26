import rss from '@astrojs/rss'
import { issues } from '../../lib/radar'
export const prerender = true
export function GET() {
  return rss({ title: "Sia's Space · AI 与量化每日观察", description: '原始来源、分析与知识地图。', site: 'https://siaspace.vercel.app', items: issues.map(issue => ({ title: issue.title, description: issue.summary, pubDate: new Date(issue.checkedAt), link: `/radar/${issue.date}` })) })
}
