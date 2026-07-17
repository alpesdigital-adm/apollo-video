import { DomainError } from './errors.ts'

export interface SemanticWindow { id: string; startMs: number; endMs: number; conclusionMs: number; obstructedRanges: readonly (readonly [number, number])[] }
export function placeBroll(window: SemanticWindow, input: { desiredStartMs: number; desiredEndMs: number; minDurationMs: number; maxDurationMs: number }) {
  const startMs = Math.max(window.startMs, input.desiredStartMs)
  const endMs = Math.min(window.endMs, window.conclusionMs, input.desiredEndMs)
  const duration = endMs - startMs
  if (duration < input.minDurationMs || duration > input.maxDurationMs) throw new DomainError('INVALID_ARGUMENT', 'B-roll duration is outside treatment bounds')
  if (window.obstructedRanges.some(([from, to]) => startMs < to && endMs > from)) throw new DomainError('INVALID_ARGUMENT', 'B-roll would obstruct a protected visual range')
  return Object.freeze({ kind: 'b-roll' as const, startMs, endMs, entryReason: 'semantic-window', exitReason: endMs === window.conclusionMs ? 'semantic-conclusion' : 'duration-bound' })
}

export interface CameraMotion { kind: 'zoom' | 'pan' | 'tilt'; reason: string; startMs: number; endMs: number; amplitude: number; velocity: number; cooldownMs: number }
export function validateCameraMotions(motions: readonly CameraMotion[]): readonly CameraMotion[] {
  const sorted = [...motions].toSorted((a, b) => a.startMs - b.startMs)
  for (let index = 0; index < sorted.length; index += 1) {
    const motion = sorted[index]; const previous = sorted[index - 1]
    if (!motion.reason || motion.amplitude <= 0 || motion.amplitude > .25 || motion.velocity <= 0 || motion.endMs <= motion.startMs) throw new DomainError('INVALID_ARGUMENT', 'Camera motion requires reason and bounded amplitude, velocity and duration')
    if (previous && motion.startMs - previous.endMs < previous.cooldownMs) throw new DomainError('INVALID_ARGUMENT', 'Camera motion violates cooldown')
  }
  return Object.freeze(sorted)
}

export function energyCurve(input: { acts: readonly { id: string; role: 'hook' | 'body' | 'proof' | 'cta'; startMs: number; endMs: number }[]; objective: 'awareness' | 'conversion' }) {
  const base = input.objective === 'conversion' ? { hook: .9, body: .62, proof: .72, cta: .82 } : { hook: .85, body: .55, proof: .62, cta: .65 }
  return Object.freeze(input.acts.map((act) => ({ ...act, energy: base[act.role], targetBreakDensityPer30s: Math.round(base[act.role] * (input.objective === 'conversion' ? 5 : 4)) })))
}

export interface PatternBreak { id: string; atMs: number; type: 'zoom' | 'insert' | 'cutaway' | 'layout-change'; semanticGroup: string }
export function validatePatternBreakBudget(items: readonly PatternBreak[], policy: { windowMs: number; maxPerWindow: number; maxSameType: number; maxSameGroup: number }) {
  const issues: { code: string; ids: string[] }[] = []
  for (const item of items) {
    const nearby = items.filter((other) => other.atMs >= item.atMs && other.atMs < item.atMs + policy.windowMs)
    if (nearby.length > policy.maxPerWindow) issues.push({ code: 'WINDOW_EXCESS', ids: nearby.map((value) => value.id) })
    if (nearby.filter((value) => value.type === item.type).length > policy.maxSameType) issues.push({ code: 'TYPE_EXCESS', ids: nearby.filter((value) => value.type === item.type).map((value) => value.id) })
    if (nearby.filter((value) => value.semanticGroup === item.semanticGroup).length > policy.maxSameGroup) issues.push({ code: 'GROUP_EXCESS', ids: nearby.filter((value) => value.semanticGroup === item.semanticGroup).map((value) => value.id) })
  }
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) })
}

export interface ContinuityFrame { id: string; eyeLine: string; movement: string; position: string; colorProfile: string; audioBed: string; argumentId: string }
export function validateContinuity(frames: readonly ContinuityFrame[]) {
  const fields = ['eyeLine', 'movement', 'position', 'colorProfile', 'audioBed', 'argumentId'] as const
  return Object.freeze(frames.slice(1).flatMap((frame, index) => fields.filter((field) => frame[field] !== frames[index][field]).map((field) => ({ code: `CONTINUITY_${field.toUpperCase()}`, fromId: frames[index].id, toId: frame.id }))))
}

export const EDITORIAL_TIMELINE_GOLDENS = Object.freeze({
  excessive: [{ id: 'a', atMs: 0, type: 'zoom', semanticGroup: 'g' }, { id: 'b', atMs: 1000, type: 'zoom', semanticGroup: 'g' }, { id: 'c', atMs: 2000, type: 'zoom', semanticGroup: 'g' }],
  scarce: [{ id: 'a', atMs: 0, type: 'insert', semanticGroup: 'g1' }],
  adequate: [{ id: 'a', atMs: 0, type: 'insert', semanticGroup: 'g1' }, { id: 'b', atMs: 12_000, type: 'zoom', semanticGroup: 'g2' }, { id: 'c', atMs: 24_000, type: 'cutaway', semanticGroup: 'g3' }]
} satisfies Record<string, readonly PatternBreak[]>)
