import rss from '@astrojs/rss'
import { issues } from '../../lib/radar'
export const prerender = true
export function GET() {
  return rss({ title: "Sia's Space · 每日前沿", description: '国内外 AI、量化与市场的每日动态。', site: 'https://siaspace.vercel.app', items: issues.map(issue => ({ title: issue.title, description: issue.summary, pubDate: new Date(issue.checkedAt), link: `/radar/${issue.date}` })) })
}
