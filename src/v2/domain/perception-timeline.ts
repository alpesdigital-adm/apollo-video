import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export const PERCEPTION_KINDS = Object.freeze([
  'transcript-word',
  'speaker',
  'silence',
  'face',
  'object',
  'shot',
  'motion',
  'ocr',
  'image-insert',
] as const)
export type PerceptionKind = (typeof PERCEPTION_KINDS)[number]
export type PerceptionCoverageState = 'absent' | 'partial' | 'complete'
export type PerceptionRange = readonly [number, number]

export interface PerceptionProvenance {
  source: string
  model: string
  version: string
  confidence: number
}
export interface PerceptionObservation<T = unknown> {
  id: string
  kind: PerceptionKind
  startMs: number
  endMs: number
  value: T
  provenance: Readonly<PerceptionProvenance>
}
export interface PerceptionCoverage {
  kind: PerceptionKind
  state: PerceptionCoverageState
  ranges: readonly PerceptionRange[]
  observedMs: number
}
export interface PerceptionTimeline {
  schemaVersion: 1
  durationMs: number
  observations: readonly Readonly<PerceptionObservation>[]
  coverage: readonly Readonly<PerceptionCoverage>[]
  inventedValues: 0
  timelineHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/

function range(value: PerceptionRange, durationMs: number): PerceptionRange {
  if (
    !Array.isArray(value) || value.length !== 2 ||
    !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1]) ||
    value[0] < 0 || value[1] > durationMs || value[1] <= value[0]
  ) throw new DomainError('INVALID_ARGUMENT', 'Invalid perception coverage range')
  return Object.freeze([value[0], value[1]])
}

function mergeRanges(values: readonly PerceptionRange[]): readonly PerceptionRange[] {
  const merged: [number, number][] = []
  for (const current of [...values].sort((left, right) =>
    left[0] - right[0] || left[1] - right[1])) {
    const previous = merged.at(-1)
    if (previous && current[0] <= previous[1]) previous[1] = Math.max(previous[1], current[1])
    else merged.push([current[0], current[1]])
  }
  return Object.freeze(merged.map((value) => Object.freeze(value)))
}

function coveredMs(values: readonly PerceptionRange[]) {
  return values.reduce((sum, value) => sum + value[1] - value[0], 0)
}

function coverageState(observedMs: number, durationMs: number): PerceptionCoverageState {
  return observedMs === 0 ? 'absent' : observedMs === durationMs ? 'complete' : 'partial'
}

function normalizeCoverage(
  durationMs: number,
  observations: readonly Readonly<PerceptionObservation>[],
  provided?: readonly Readonly<{ kind: PerceptionKind; ranges: readonly PerceptionRange[] }>[],
): readonly Readonly<PerceptionCoverage>[] {
  if (provided) {
    const kinds = provided.map((entry) => entry.kind)
    if (
      kinds.length !== PERCEPTION_KINDS.length ||
      new Set(kinds).size !== PERCEPTION_KINDS.length ||
      kinds.some((kind) => !PERCEPTION_KINDS.includes(kind))
    ) throw new DomainError('INVALID_ARGUMENT', 'Perception coverage must declare every kind exactly once')
  }
  return Object.freeze(PERCEPTION_KINDS.map((kind) => {
    const declared = provided?.find((entry) => entry.kind === kind)?.ranges ??
      observations.filter((item) => item.kind === kind)
        .map((item) => [item.startMs, item.endMs] as const)
    const ranges = mergeRanges(declared.map((value) => range(value, durationMs)))
    const observedMs = coveredMs(ranges)
    return Object.freeze({
      kind,
      state: coverageState(observedMs, durationMs),
      ranges,
      observedMs,
    })
  }))
}

function normalizeProvenance(value: PerceptionProvenance): Readonly<PerceptionProvenance> {
  const source = value.source?.trim()
  const model = value.model?.trim()
  const version = value.version?.trim()
  if (
    !TOKEN.test(source) || !TOKEN.test(model) || !TOKEN.test(version) ||
    !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
  ) throw new DomainError('INVALID_ARGUMENT', 'Invalid perception observation provenance')
  return Object.freeze({ source, model, version, confidence: value.confidence })
}

function normalizeObservation(
  value: PerceptionObservation,
  durationMs: number,
): Readonly<PerceptionObservation> {
  if (
    !ID.test(value.id?.trim()) || !PERCEPTION_KINDS.includes(value.kind) ||
    !Number.isSafeInteger(value.startMs) || !Number.isSafeInteger(value.endMs) ||
    value.startMs < 0 || value.endMs > durationMs || value.endMs <= value.startMs ||
    value.value === undefined
  ) throw new DomainError('INVALID_ARGUMENT', `Invalid perception observation ${value.id}`)
  try { stableSerialize(value.value) } catch {
    throw new DomainError('INVALID_ARGUMENT', `Invalid perception observation ${value.id}`)
  }
  return Object.freeze({
    id: value.id.trim(),
    kind: value.kind,
    startMs: value.startMs,
    endMs: value.endMs,
    value: value.value,
    provenance: normalizeProvenance(value.provenance),
  })
}

export function createPerceptionTimeline(input: {
  durationMs: number
  observations: readonly PerceptionObservation[]
  coverage?: readonly Readonly<{ kind: PerceptionKind; ranges: readonly PerceptionRange[] }>[]
}): Readonly<PerceptionTimeline> {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Timeline duration must be a positive integer')
  }
  const observations = Object.freeze(input.observations
    .map((value) => normalizeObservation(value, input.durationMs))
    .toSorted((left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs ||
      PERCEPTION_KINDS.indexOf(left.kind) - PERCEPTION_KINDS.indexOf(right.kind) ||
      left.id.localeCompare(right.id)))
  if (new Set(observations.map((value) => value.id)).size !== observations.length) {
    throw new DomainError('INVALID_ARGUMENT', 'Perception observation IDs must be unique')
  }
  const coverage = normalizeCoverage(input.durationMs, observations, input.coverage)
  for (const observation of observations) {
    const declared = coverage.find((entry) => entry.kind === observation.kind)!
    if (!declared.ranges.some((value) =>
      observation.startMs >= value[0] && observation.endMs <= value[1])) {
      throw new DomainError('INVALID_ARGUMENT', `Observation ${observation.id} is outside declared coverage`)
    }
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    durationMs: input.durationMs,
    observations,
    coverage,
    inventedValues: 0 as const,
  })
  return Object.freeze({ ...body, timelineHash: calculateCanonicalHash(body) })
}

export function queryPerceptionRange(timeline: PerceptionTimeline, input: {
  startMs: number
  endMs: number
  kinds?: readonly PerceptionKind[]
}) {
  if (
    !Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs) ||
    input.startMs < 0 || input.endMs > timeline.durationMs || input.endMs <= input.startMs
  ) throw new DomainError('INVALID_ARGUMENT', 'Requested range is outside timeline')
  const requested = input.kinds ?? PERCEPTION_KINDS
  if (
    requested.length < 1 || new Set(requested).size !== requested.length ||
    requested.some((kind) => !PERCEPTION_KINDS.includes(kind))
  ) throw new DomainError('INVALID_ARGUMENT', 'Requested perception kinds are invalid')
  const observations = timeline.observations.filter((item) =>
    requested.includes(item.kind) && item.startMs < input.endMs && item.endMs > input.startMs)
  const requestedDuration = input.endMs - input.startMs
  const coverage = requested.map((kind) => {
    const source = timeline.coverage.find((entry) => entry.kind === kind)!
    const ranges = mergeRanges(source.ranges.flatMap((value) => {
      const start = Math.max(value[0], input.startMs)
      const end = Math.min(value[1], input.endMs)
      return end > start ? [[start, end] as const] : []
    }))
    const observedMs = coveredMs(ranges)
    return Object.freeze({ kind, state: coverageState(observedMs, requestedDuration), ranges, observedMs })
  })
  return Object.freeze({
    schemaVersion: 'perception-range/v1' as const,
    timelineHash: timeline.timelineHash,
    range: Object.freeze({ startMs: input.startMs, endMs: input.endMs }),
    kinds: Object.freeze([...requested]),
    observations: Object.freeze(observations),
    coverage: Object.freeze(coverage),
    inventedValues: 0 as const,
  })
}

const source = (
  id: string, kind: PerceptionKind, startMs: number, endMs: number, value: unknown,
): PerceptionObservation => ({
  id, kind, startMs, endMs, value,
  provenance: { source: 'fixture', model: 'golden', version: 'v1', confidence: 1 },
})
const explicitCoverage = (
  entries: Partial<Record<PerceptionKind, readonly PerceptionRange[]>>,
) => PERCEPTION_KINDS.map((kind) => ({ kind, ranges: entries[kind] ?? [] }))

export const PERCEPTION_GOLDEN_FIXTURES = Object.freeze({
  talkingHead: createPerceptionTimeline({
    durationMs: 3_000,
    observations: [
      source('word-1', 'transcript-word', 0, 500, { text: 'Olá' }),
      source('speaker-1', 'speaker', 0, 3_000, { speakerId: 'speaker-a' }),
      source('face-1', 'face', 0, 3_000, { trackId: 'face-a' }),
      source('silence-1', 'silence', 800, 1_100, { rmsDb: -60 }),
      source('shot-1', 'shot', 0, 3_000, { shotId: 'shot-a' }),
      source('motion-1', 'motion', 0, 3_000, { level: 'low' }),
    ],
    coverage: explicitCoverage({
      'transcript-word': [[0, 3_000]], speaker: [[0, 3_000]], silence: [[0, 3_000]],
      face: [[0, 3_000]], shot: [[0, 3_000]], motion: [[0, 3_000]],
    }),
  }),
  audioOnly: createPerceptionTimeline({
    durationMs: 2_000,
    observations: [
      source('word-2', 'transcript-word', 0, 700, { text: 'Ouça' }),
      source('speaker-2', 'speaker', 0, 2_000, { speakerId: 'speaker-a' }),
      source('silence-2', 'silence', 1_500, 2_000, { rmsDb: -58 }),
    ],
    coverage: explicitCoverage({
      'transcript-word': [[0, 700]], speaker: [[0, 2_000]], silence: [[0, 2_000]],
    }),
  }),
  insertedImage: createPerceptionTimeline({
    durationMs: 1_500,
    observations: [
      source('image-1', 'image-insert', 0, 1_500, { artifactId: 'asset-image' }),
      source('object-1', 'object', 0, 1_500, { label: 'product' }),
      source('ocr-1', 'ocr', 200, 1_200, { text: 'Prova' }),
    ],
    coverage: explicitCoverage({
      'image-insert': [[0, 1_500]], object: [[0, 1_500]], ocr: [[0, 1_500]],
    }),
  }),
})
