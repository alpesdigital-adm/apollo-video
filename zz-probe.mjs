const f = await import('./tests/v2/wave20-fixtures.mjs')
const lossy = (v) => typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) && Number(v.toPrecision(16)) !== v
const found = []
const walk = (node, path) => {
  if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`))
  if (node && typeof node === 'object') return Object.entries(node).forEach(([key, value]) => walk(value, `${path}.${key}`))
  if (lossy(node)) found.push(`${path} = ${node}`)
}
const W = 'w20-workspace-a'
const direction = f.buildDirectionWorld ? f.buildDirectionWorld({ workspaceId: W, sessionId: 'w20-session', projectId: 'w20-project' }) : null
console.log('exports:', Object.keys(f).join(', '))
const match = f.buildMatchWorld({ workspaceId: W, projectId: 'w20-project', sessionId: 'w20-session' })
walk(match, 'match')
const critic = f.buildCriticReport({ workspaceId: W, projectId: 'w20-project', projectVersionId: 'w20-version', reportId: 'w20-report', matchPlan: match.plan })
walk(critic, 'critic')
const play = f.buildPlaybackWorld({ workspaceId: W, sessionId: 'w20-session', projectId: 'w20-project' })
walk(play.map, 'playback')
if (direction) walk(direction, 'direction')
console.log('lossy doubles:', found.length)
for (const entry of found.slice(0, 20)) console.log('  ', entry)
