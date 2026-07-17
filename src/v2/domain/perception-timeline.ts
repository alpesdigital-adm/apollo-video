import { DomainError } from './errors.ts'

export type PerceptionKind = 'transcript-word' | 'speaker' | 'silence' | 'face' | 'object' | 'shot' | 'motion' | 'ocr' | 'image-insert'
export interface PerceptionObservation<T = unknown> {
  id: string; kind: PerceptionKind; startMs: number; endMs: number; value: T
  provenance: { source: string; model: string; version: string; confidence: number }
}
export interface PerceptionTimeline { schemaVersion: 1; durationMs: number; observations: readonly PerceptionObservation[]; coverage: readonly { kind: PerceptionKind; ranges: readonly (readonly [number, number])[] }[] }

export function createPerceptionTimeline(input: { durationMs: number; observations: readonly PerceptionObservation[] }): Readonly<PerceptionTimeline> {
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) throw new DomainError('INVALID_ARGUMENT', 'Timeline duration must be a positive integer')
  for (const observation of input.observations) {
    if (observation.startMs < 0 || observation.endMs > input.durationMs || observation.endMs < observation.startMs || observation.provenance.confidence < 0 || observation.provenance.confidence > 1) throw new DomainError('INVALID_ARGUMENT', `Invalid perception observation ${observation.id}`)
  }
  const sorted = [...input.observations].toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
  const kinds = [...new Set(sorted.map((item) => item.kind))]
  const coverage = kinds.map((kind) => ({ kind, ranges: Object.freeze(sorted.filter((item) => item.kind === kind).map((item) => Object.freeze([item.startMs, item.endMs] as const))) }))
  return Object.freeze({ schemaVersion: 1 as const, durationMs: input.durationMs, observations: Object.freeze(sorted), coverage: Object.freeze(coverage) })
}

export function queryPerceptionRange(timeline: PerceptionTimeline, input: { startMs: number; endMs: number; kinds?: readonly PerceptionKind[] }) {
  if (input.startMs < 0 || input.endMs > timeline.durationMs || input.endMs <= input.startMs) throw new DomainError('INVALID_ARGUMENT', 'Requested range is outside timeline')
  const requested = input.kinds ?? timeline.coverage.map((entry) => entry.kind)
  const observations = timeline.observations.filter((item) => requested.includes(item.kind) && item.endMs >= input.startMs && item.startMs <= input.endMs)
  const coverage = requested.map((kind) => {
    const overlap = observations.filter((item) => item.kind === kind).reduce((sum, item) => sum + Math.max(0, Math.min(item.endMs, input.endMs) - Math.max(item.startMs, input.startMs)), 0)
    return { kind, state: overlap === 0 ? 'absent' : overlap >= input.endMs - input.startMs ? 'complete' : 'partial', observedMs: Math.min(overlap, input.endMs - input.startMs) }
  })
  return Object.freeze({ range: Object.freeze({ ...input, kinds: undefined }), observations: Object.freeze(observations), coverage: Object.freeze(coverage), inventedValues: 0 })
}

const source = (id: string, kind: PerceptionKind, startMs: number, endMs: number, value: unknown): PerceptionObservation => ({ id, kind, startMs, endMs, value, provenance: { source: 'fixture', model: 'golden', version: '1', confidence: 1 } })
export const PERCEPTION_GOLDEN_FIXTURES = Object.freeze({
  talkingHead: createPerceptionTimeline({ durationMs: 3000, observations: [source('w1', 'transcript-word', 0, 500, 'Olá'), source('f1', 'face', 0, 3000, { person: 'speaker' }), source('s1', 'silence', 800, 1100, true)] }),
  audioOnly: createPerceptionTimeline({ durationMs: 2000, observations: [source('w2', 'transcript-word', 0, 700, 'Ouça'), source('sp1', 'speaker', 0, 2000, 'A')] }),
  insertedImage: createPerceptionTimeline({ durationMs: 1500, observations: [source('i1', 'image-insert', 0, 1500, 'asset_image'), source('o1', 'ocr', 200, 1200, 'Prova')] })
})
