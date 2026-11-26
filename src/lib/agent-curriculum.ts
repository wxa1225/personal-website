import catalog from '../data/agent-curriculum.json' with { type: 'json' }

export const domains = catalog.domains
export const concepts = catalog.concepts
export const relations = catalog.relations
export const learningPaths = catalog.paths
export const roles = catalog.roles
export const problems = catalog.problems
export type Concept = typeof concepts[number]
export const conceptById = (id: string) => concepts.find(node => node.id === id)
export const lessonUrl = (node: Concept) => `/learn/agent/deep/${node.slug}`
export const mapUrl = (id: string) => `/learn/agent?node=${encodeURIComponent(id)}`

export function connections(id: string) {
  return {
    before: relations.filter(edge => edge.to === id && edge.type === 'prerequisite'),
    after: relations.filter(edge => edge.fromId === id && edge.type === 'prerequisite'),
    related: relations.filter(edge => edge.type !== 'prerequisite' && (edge.fromId === id || edge.to === id))
  }
}

export function searchConcepts(query: string): Concept[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return concepts
  return concepts.map(node => {
    const name = `${node.id} ${node.title}`.toLocaleLowerCase()
    const text = `${name} ${node.question} ${node.thesis} ${node.tags.join(' ')}`.toLocaleLowerCase()
    const score = words.every(word => text.includes(word))
      ? words.reduce((sum, word) => sum + (name.includes(word) ? 4 : 1), 0) : 0
    return { node, score }
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score).map(result => result.node)
}
