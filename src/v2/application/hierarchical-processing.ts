import { createHash } from 'node:crypto'
import { DomainError } from '../domain/errors.ts'

export type ProcessingTier = 'cheap-signals' | 'vision' | 'language' | 'aggregation'
export interface HierarchicalChunk { id: string; artifactId: string; sourceRangeMs: readonly [number, number]; overlapBeforeMs: number; overlapAfterMs: number; sequence: number; evidenceSpanIds: readonly string[] }
export function chunkLongForm(input: { artifactId: string; durationMs: number; chunkMs?: number; overlapMs?: number }): readonly HierarchicalChunk[] {
  const chunkMs = input.chunkMs ?? 300_000; const overlapMs = input.overlapMs ?? 15_000
  if (input.durationMs <= 0 || chunkMs <= overlapMs * 2 || overlapMs < 0) throw new DomainError('INVALID_ARGUMENT', 'Hierarchical chunk configuration is invalid')
  const chunks: HierarchicalChunk[] = []; let logicalStart = 0; let sequence = 0
  while (logicalStart < input.durationMs) { const logicalEnd = Math.min(input.durationMs, logicalStart + chunkMs); const start = Math.max(0, logicalStart - overlapMs); const end = Math.min(input.durationMs, logicalEnd + overlapMs); chunks.push(Object.freeze({ id: `chunk_${input.artifactId}_${sequence}`, artifactId: input.artifactId, sourceRangeMs: Object.freeze([start, end]) as readonly [number, number], overlapBeforeMs: logicalStart - start, overlapAfterMs: end - logicalEnd, sequence, evidenceSpanIds: Object.freeze([]) })); logicalStart = logicalEnd; sequence++ }
  return Object.freeze(chunks)
}
export function planHierarchicalProcessing(input: { chunks: readonly HierarchicalChunk[]; availableSignals: readonly string[]; tierModelVersions: Readonly<Record<ProcessingTier, string>>; previousVersions?: Partial<Record<ProcessingTier, string>> }) {
  const order: readonly ProcessingTier[] = ['cheap-signals', 'vision', 'language', 'aggregation']
  const invalidated = order.filter((tier) => input.previousVersions?.[tier] !== undefined && input.previousVersions[tier] !== input.tierModelVersions[tier])
  const firstInvalid = invalidated.length ? order.indexOf(invalidated[0]) : -1
  const tiers = order.map((tier, index) => Object.freeze({ tier, modelVersion: input.tierModelVersions[tier], status: firstInvalid < 0 ? 'reusable' as const : index >= firstInvalid ? 'invalidated' as const : 'reusable' as const, prerequisites: Object.freeze(index ? [order[index - 1]] : []), expensive: tier !== 'cheap-signals' }))
  return Object.freeze({ tiers: Object.freeze(tiers), executionOrder: order, cheapSignalsFirst: true, inputSignalCount: input.availableSignals.length, fingerprint: createHash('sha256').update(JSON.stringify({ chunks: input.chunks, versions: input.tierModelVersions })).digest('hex') })
}
export function aggregateHierarchicalMoments(input: { chunks: readonly HierarchicalChunk[]; candidates: readonly { chunkId: string; topic: string; rangeMs: readonly [number, number]; evidenceSpanIds: readonly string[]; salience: number }[] }) {
  const byTopic = new Map<string, typeof input.candidates>(); for (const item of input.candidates) byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item])
  const moments = [...byTopic.entries()].map(([topic, items], index) => Object.freeze({ id: `moment_${index}`, topic, rangesMs: Object.freeze(items.map((item) => item.rangeMs)), evidenceSpanIds: Object.freeze([...new Set(items.flatMap((item) => item.evidenceSpanIds))]), salience: Math.max(...items.map((item) => item.salience)), sourceChunkIds: Object.freeze([...new Set(items.map((item) => item.chunkId))]) }))
  return Object.freeze({ moments: Object.freeze(moments), chapters: Object.freeze(moments.map((moment, index) => Object.freeze({ id: `chapter_${index}`, title: moment.topic, momentIds: Object.freeze([moment.id]), rangeMs: Object.freeze([Math.min(...moment.rangesMs.map(([start]) => start)), Math.max(...moment.rangesMs.map(([, end]) => end))]) }))), evidencePreserved: input.candidates.every((candidate) => candidate.evidenceSpanIds.every((id) => moments.some((moment) => moment.evidenceSpanIds.includes(id)))) })
}
export function estimateHierarchicalFixture(input: { durationMs: number; chunkCount: number; cheapSignalBytesPerMinute: number; visionCostPerChunk: number; languageCostPerChunk: number; millisecondsPerChunk: number }) {
  const minutes = input.durationMs / 60_000
  return Object.freeze({ durationMs: input.durationMs, memoryBytes: Math.round(minutes * input.cheapSignalBytesPerMinute), estimatedCost: Number((input.chunkCount * (input.visionCostPerChunk + input.languageCostPerChunk)).toFixed(4)), estimatedTimeMs: input.chunkCount * input.millisecondsPerChunk, bounded: input.durationMs <= 7_200_000 })
}
