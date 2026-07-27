import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { normalizeSpeechText } from './speech-segment-catalog.ts'

export const HIERARCHICAL_PROCESSING_POLICY_VERSION =
  'hierarchical-processing/v1' as const
export const HIERARCHICAL_CHUNK_POLICY_VERSION =
  'overlapping-time-chunks/v1' as const

export const HIERARCHICAL_PROCESSING_TIERS = [
  'cheap-signals',
  'vision',
  'language',
  'aggregation',
] as const

export type ProcessingTier =
  (typeof HIERARCHICAL_PROCESSING_TIERS)[number]

export const HIERARCHICAL_TIER_DEPENDENCIES:
Readonly<Record<ProcessingTier, readonly ProcessingTier[]>> =
  Object.freeze({
    'cheap-signals': Object.freeze([] as ProcessingTier[]),
    vision: Object.freeze(['cheap-signals'] as ProcessingTier[]),
    language: Object.freeze(['cheap-signals'] as ProcessingTier[]),
    aggregation: Object.freeze(
      ['vision', 'language'] as ProcessingTier[],
    ),
  })

export const HIERARCHICAL_COST_POLICY = Object.freeze({
  schemaVersion: 'hierarchical-cost-policy/v1' as const,
  currency: 'USD' as const,
  perChunkMinorUnits: Object.freeze({
    'cheap-signals': 0,
    vision: 3,
    language: 2,
    aggregation: 1,
  }),
})

export interface HierarchicalChunk {
  id: string
  artifactId: string
  sequence: number
  coreRangeMs: readonly [number, number]
  sourceRangeMs: readonly [number, number]
  overlapBeforeMs: number
  overlapAfterMs: number
  evidenceSpanIds: readonly string[]
  wordCount: number
  segmentCount: number
  speechMs: number
  chunkHash: string
}

export interface HierarchicalEvidenceSpan {
  id: string
  sourceSegmentId: number
  rangeMs: readonly [number, number]
  text: string
  textHash: string
  wordCount: number
  chunkIds: readonly string[]
  spanHash: string
}

export interface HierarchicalVisionObservation {
  chunkId: string
  sourceRangeMs: readonly [number, number]
  width: number
  height: number
  fps: number
  sampleCount: number
  catalogedObservationCount: number
  observationHash: string
}

export interface HierarchicalLanguageCandidate {
  id: string
  chunkId: string
  topic: string
  summary: string
  rangeMs: readonly [number, number]
  evidenceSpanIds: readonly string[]
  salience: number
  candidateHash: string
}

export interface HierarchicalMoment {
  id: string
  sourceChunkId: string
  chapterId: string
  ordinal: number
  topic: string
  summary: string
  rangesMs: readonly (readonly [number, number])[]
  evidenceSpanIds: readonly string[]
  salience: number
  momentHash: string
}

export interface HierarchicalChapter {
  id: string
  ordinal: number
  title: string
  rangeMs: readonly [number, number]
  momentIds: readonly string[]
  evidenceSpanIds: readonly string[]
  chapterHash: string
}

export interface HierarchicalAggregation {
  chapters: readonly Readonly<HierarchicalChapter>[]
  moments: readonly Readonly<HierarchicalMoment>[]
  evidencePreserved: true
  aggregationHash: string
}

export interface HierarchicalTierVersion {
  provider: string
  model: string
  version: string
}

export type HierarchicalTierVersions =
  Readonly<Record<ProcessingTier, Readonly<HierarchicalTierVersion>>>

export interface HierarchicalTierPlan {
  tier: ProcessingTier
  sequence: number
  version: Readonly<HierarchicalTierVersion>
  prerequisites: readonly ProcessingTier[]
  status: 'process' | 'reuse'
}

export interface HierarchicalProcessingPlan {
  tiers: readonly Readonly<HierarchicalTierPlan>[]
  executionOrder: readonly ProcessingTier[]
  invalidatedTiers: readonly ProcessingTier[]
  cheapSignalsFirst: true
  planHash: string
}

interface TranscriptSegmentInput {
  id: number
  startMs: number
  endMs: number
  text: string
}

const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

function frozenRange(
  startMs: number,
  endMs: number,
): readonly [number, number] {
  return Object.freeze([startMs, endMs]) as readonly [number, number]
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${calculateCanonicalHash(value).slice(0, 40)}`
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(stableSerialize(value)).byteLength
}

function normalizedText(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.slice(0, maximum)
}

export function normalizeHierarchicalTierVersions(
  input: Readonly<Record<string, unknown>>,
): HierarchicalTierVersions {
  const normalized = Object.fromEntries(
    HIERARCHICAL_PROCESSING_TIERS.map((tier) => {
      const raw = input[tier]
      assertDomain(
        typeof raw === 'object' &&
          raw !== null &&
          !Array.isArray(raw),
        'INVALID_ARGUMENT',
        `tierVersions.${tier} is invalid`,
      )
      const value = raw as Record<string, unknown>
      assertDomain(
        Object.keys(value).every((key) =>
          ['provider', 'model', 'version'].includes(key)),
        'INVALID_ARGUMENT',
        `tierVersions.${tier} contains an unsupported field`,
      )
      assertDomain(
        typeof value.provider === 'string' &&
          TOKEN.test(value.provider.trim()) &&
          typeof value.model === 'string' &&
          TOKEN.test(value.model.trim()) &&
          typeof value.version === 'string' &&
          TOKEN.test(value.version.trim()),
        'INVALID_ARGUMENT',
        `tierVersions.${tier} identity is invalid`,
      )
      return [
        tier,
        Object.freeze({
          provider: value.provider.trim(),
          model: value.model.trim(),
          version: value.version.trim(),
        }),
      ]
    }),
  )
  return Object.freeze(
    normalized as unknown as Record<
      ProcessingTier,
      Readonly<HierarchicalTierVersion>
    >,
  )
}

export function chunkLongForm(input: {
  artifactId: string
  durationMs: number
  chunkDurationMs?: number
  overlapMs?: number
}): readonly Readonly<HierarchicalChunk>[] {
  const chunkDurationMs = input.chunkDurationMs ?? 300_000
  const overlapMs = input.overlapMs ?? 15_000
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.artifactId) &&
      Number.isSafeInteger(input.durationMs) &&
      input.durationMs > 0 &&
      input.durationMs <= 43_200_000,
    'INVALID_ARGUMENT',
    'Hierarchical source is invalid',
  )
  assertDomain(
    Number.isSafeInteger(chunkDurationMs) &&
      chunkDurationMs >= 60_000 &&
      chunkDurationMs <= 900_000 &&
      Number.isSafeInteger(overlapMs) &&
      overlapMs >= 0 &&
      overlapMs <= 60_000 &&
      overlapMs * 2 < chunkDurationMs,
    'INVALID_ARGUMENT',
    'Hierarchical chunk configuration is invalid',
  )
  const chunks: HierarchicalChunk[] = []
  for (
    let coreStartMs = 0, sequence = 0;
    coreStartMs < input.durationMs;
    coreStartMs += chunkDurationMs, sequence += 1
  ) {
    const coreEndMs = Math.min(
      input.durationMs,
      coreStartMs + chunkDurationMs,
    )
    const sourceStartMs = Math.max(0, coreStartMs - overlapMs)
    const sourceEndMs = Math.min(
      input.durationMs,
      coreEndMs + overlapMs,
    )
    const identity = {
      artifactId: input.artifactId,
      sequence,
      coreRangeMs: [coreStartMs, coreEndMs],
      sourceRangeMs: [sourceStartMs, sourceEndMs],
      policy: HIERARCHICAL_CHUNK_POLICY_VERSION,
    }
    const content = {
      id: stableId('hierarchical-chunk', identity),
      artifactId: input.artifactId,
      sequence,
      coreRangeMs: frozenRange(coreStartMs, coreEndMs),
      sourceRangeMs: frozenRange(sourceStartMs, sourceEndMs),
      overlapBeforeMs: coreStartMs - sourceStartMs,
      overlapAfterMs: sourceEndMs - coreEndMs,
      evidenceSpanIds: Object.freeze([]) as readonly string[],
      wordCount: 0,
      segmentCount: 0,
      speechMs: 0,
    }
    chunks.push(Object.freeze({
      ...content,
      chunkHash: calculateCanonicalHash(content),
    }))
  }
  return Object.freeze(chunks)
}

export function createHierarchicalEvidenceSpans(input: {
  transcriptId: string
  durationMs: number
  segments: readonly Readonly<TranscriptSegmentInput>[]
  chunks: readonly Readonly<HierarchicalChunk>[]
}): readonly Readonly<HierarchicalEvidenceSpan>[] {
  assertDomain(
    input.segments.length > 0 && input.segments.length <= 100_000,
    'INVALID_ARGUMENT',
    'Hierarchical processing requires aligned transcript segments',
  )
  let previousStartMs = 0
  const spans = input.segments.map((segment, index) => {
    const text = normalizedText(segment.text, 10_000)
    assertDomain(
      Number.isSafeInteger(segment.id) &&
        segment.id >= 0 &&
        Number.isSafeInteger(segment.startMs) &&
        Number.isSafeInteger(segment.endMs) &&
        segment.startMs >= 0 &&
        segment.endMs > segment.startMs &&
        segment.endMs <= input.durationMs &&
        (index === 0 || segment.startMs >= previousStartMs) &&
        text.length > 0,
      'INVALID_ARGUMENT',
      'Transcript segment time mapping is invalid',
    )
    previousStartMs = segment.startMs
    const chunkIds = input.chunks
      .filter((chunk) =>
        segment.endMs > chunk.sourceRangeMs[0] &&
        segment.startMs < chunk.sourceRangeMs[1])
      .map((chunk) => chunk.id)
    assertDomain(
      chunkIds.length > 0,
      'INVALID_ARGUMENT',
      'Transcript segment is outside the chunk map',
    )
    const content = {
      id: stableId('evidence-span', {
        transcriptId: input.transcriptId,
        sourceSegmentId: segment.id,
        rangeMs: [segment.startMs, segment.endMs],
        textHash: calculateCanonicalHash(text),
      }),
      sourceSegmentId: segment.id,
      rangeMs: frozenRange(segment.startMs, segment.endMs),
      text,
      textHash: calculateCanonicalHash(text),
      wordCount: text.split(/\s+/u).filter(Boolean).length,
      chunkIds: Object.freeze(chunkIds),
    }
    return Object.freeze({
      ...content,
      spanHash: calculateCanonicalHash(content),
    })
  })
  return Object.freeze(spans)
}

export function processCheapSignals(input: {
  chunks: readonly Readonly<HierarchicalChunk>[]
  evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
}): Readonly<{
  chunks: readonly Readonly<HierarchicalChunk>[]
  evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
  workingSetBytes: number
}> {
  const chunks = input.chunks.map((chunk) => {
    const spans = input.evidenceSpans.filter((span) =>
      span.chunkIds.includes(chunk.id))
    const content = {
      ...chunk,
      evidenceSpanIds: Object.freeze(spans.map((span) => span.id)),
      wordCount: spans.reduce((total, span) => total + span.wordCount, 0),
      segmentCount: spans.length,
      speechMs: spans.reduce(
        (total, span) =>
          total + Math.max(
            0,
            Math.min(chunk.sourceRangeMs[1], span.rangeMs[1]) -
              Math.max(chunk.sourceRangeMs[0], span.rangeMs[0]),
          ),
        0,
      ),
    }
    const { chunkHash: _oldHash, ...hashable } = content
    return Object.freeze({
      ...hashable,
      chunkHash: calculateCanonicalHash(hashable),
    })
  })
  const output = {
    chunks: Object.freeze(chunks),
    evidenceSpans: input.evidenceSpans,
  }
  return Object.freeze({
    ...output,
    workingSetBytes: serializedBytes(output),
  })
}

export function processHierarchicalVision(input: {
  chunks: readonly Readonly<HierarchicalChunk>[]
  width: number
  height: number
  fps: number
  catalogedVisualObservationCount: number
  sampleIntervalMs?: number
}): Readonly<{
  observations: readonly Readonly<HierarchicalVisionObservation>[]
  workingSetBytes: number
}> {
  const sampleIntervalMs = input.sampleIntervalMs ?? 10_000
  assertDomain(
    Number.isSafeInteger(input.width) &&
      input.width > 0 &&
      Number.isSafeInteger(input.height) &&
      input.height > 0 &&
      Number.isFinite(input.fps) &&
      input.fps > 0 &&
      Number.isSafeInteger(input.catalogedVisualObservationCount) &&
      input.catalogedVisualObservationCount >= 0 &&
      Number.isSafeInteger(sampleIntervalMs) &&
      sampleIntervalMs >= 1_000 &&
      sampleIntervalMs <= 60_000,
    'INVALID_ARGUMENT',
    'Hierarchical vision context is invalid',
  )
  const observations = input.chunks.map((chunk) => {
    const content = {
      chunkId: chunk.id,
      sourceRangeMs: chunk.sourceRangeMs,
      width: input.width,
      height: input.height,
      fps: input.fps,
      sampleCount: Math.max(
        1,
        Math.ceil(
          (chunk.sourceRangeMs[1] - chunk.sourceRangeMs[0]) /
            sampleIntervalMs,
        ),
      ),
      catalogedObservationCount:
        input.catalogedVisualObservationCount,
    }
    return Object.freeze({
      ...content,
      observationHash: calculateCanonicalHash(content),
    })
  })
  return Object.freeze({
    observations: Object.freeze(observations),
    workingSetBytes: serializedBytes(observations),
  })
}

function ownedSpans(
  chunk: Readonly<HierarchicalChunk>,
  spans: readonly Readonly<HierarchicalEvidenceSpan>[],
) {
  return spans.filter((span) => {
    const midpoint = span.rangeMs[0] +
      Math.floor((span.rangeMs[1] - span.rangeMs[0]) / 2)
    const isLast = chunk.coreRangeMs[1] ===
      Math.max(...spans.map((item) => item.rangeMs[1]))
    return midpoint >= chunk.coreRangeMs[0] &&
      (midpoint < chunk.coreRangeMs[1] ||
        (isLast && midpoint === chunk.coreRangeMs[1]))
  })
}

export function processHierarchicalLanguage(input: {
  chunks: readonly Readonly<HierarchicalChunk>[]
  evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
}): Readonly<{
  candidates: readonly Readonly<HierarchicalLanguageCandidate>[]
  workingSetBytes: number
}> {
  const candidates = input.chunks.flatMap((chunk) => {
    const spans = ownedSpans(chunk, input.evidenceSpans)
    if (spans.length === 0) return []
    const combined = spans.map((span) => span.text).join(' ')
    const normalized = normalizeSpeechText(combined)
    const topic = normalizedText(
      normalized || combined,
      160,
    )
    const summary = normalizedText(combined, 1_000)
    const rangeMs = frozenRange(
      Math.min(...spans.map((span) => span.rangeMs[0])),
      Math.max(...spans.map((span) => span.rangeMs[1])),
    )
    const content = {
      id: stableId('hierarchical-candidate', {
        chunkId: chunk.id,
        rangeMs,
        evidenceSpanIds: spans.map((span) => span.id),
      }),
      chunkId: chunk.id,
      topic,
      summary,
      rangeMs,
      evidenceSpanIds: Object.freeze(spans.map((span) => span.id)),
      salience: Math.min(
        1,
        Number(
          (
            0.35 +
            Math.log10(
              1 + spans.reduce(
                (total, span) => total + span.wordCount,
                0,
              ),
            ) / 3
          ).toFixed(6),
        ),
      ),
    }
    return [Object.freeze({
      ...content,
      candidateHash: calculateCanonicalHash(content),
    })]
  })
  const evidenceIds = new Set(
    candidates.flatMap((candidate) => candidate.evidenceSpanIds),
  )
  assertDomain(
    input.evidenceSpans.every((span) => evidenceIds.has(span.id)),
    'INVALID_ARGUMENT',
    'Language tier lost one or more evidence spans',
  )
  return Object.freeze({
    candidates: Object.freeze(candidates),
    workingSetBytes: serializedBytes(candidates),
  })
}

export function aggregateHierarchicalMoments(input: {
  candidates: readonly Readonly<HierarchicalLanguageCandidate>[]
  evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
  momentsPerChapter?: number
}): Readonly<HierarchicalAggregation & { workingSetBytes: number }> {
  const momentsPerChapter = input.momentsPerChapter ?? 4
  assertDomain(
    input.candidates.length > 0 &&
      Number.isSafeInteger(momentsPerChapter) &&
      momentsPerChapter >= 1 &&
      momentsPerChapter <= 20,
    'INVALID_ARGUMENT',
    'Hierarchical aggregation input is invalid',
  )
  const chapterCount = Math.ceil(
    input.candidates.length / momentsPerChapter,
  )
  const chapterIds = Array.from(
    { length: chapterCount },
    (_, index) => stableId('hierarchical-chapter', {
      index,
      candidates: input.candidates
        .slice(
          index * momentsPerChapter,
          (index + 1) * momentsPerChapter,
        )
        .map((candidate) => candidate.candidateHash),
    }),
  )
  const moments = input.candidates.map((candidate, ordinal) => {
    const chapterId =
      chapterIds[Math.floor(ordinal / momentsPerChapter)]!
    const content = {
      id: stableId('hierarchical-moment', {
        ordinal,
        candidateHash: candidate.candidateHash,
        chapterId,
      }),
      sourceChunkId: candidate.chunkId,
      chapterId,
      ordinal,
      topic: candidate.topic,
      summary: candidate.summary,
      rangesMs: Object.freeze([candidate.rangeMs]),
      evidenceSpanIds: candidate.evidenceSpanIds,
      salience: candidate.salience,
    }
    return Object.freeze({
      ...content,
      momentHash: calculateCanonicalHash(content),
    })
  })
  const chapters = chapterIds.map((id, ordinal) => {
    const chapterMoments = moments.slice(
      ordinal * momentsPerChapter,
      (ordinal + 1) * momentsPerChapter,
    )
    const content = {
      id,
      ordinal,
      title: chapterMoments[0]!.topic,
      rangeMs: frozenRange(
        Math.min(
          ...chapterMoments.flatMap((moment) =>
            moment.rangesMs.map((range) => range[0])),
        ),
        Math.max(
          ...chapterMoments.flatMap((moment) =>
            moment.rangesMs.map((range) => range[1])),
        ),
      ),
      momentIds: Object.freeze(
        chapterMoments.map((moment) => moment.id),
      ),
      evidenceSpanIds: Object.freeze([
        ...new Set(
          chapterMoments.flatMap((moment) =>
            moment.evidenceSpanIds),
        ),
      ]),
    }
    return Object.freeze({
      ...content,
      chapterHash: calculateCanonicalHash(content),
    })
  })
  const aggregateEvidence = new Set(
    moments.flatMap((moment) => moment.evidenceSpanIds),
  )
  assertDomain(
    input.evidenceSpans.every((span) => aggregateEvidence.has(span.id)),
    'INVALID_ARGUMENT',
    'Aggregation lost one or more evidence spans',
  )
  const body = {
    chapters: Object.freeze(chapters),
    moments: Object.freeze(moments),
    evidencePreserved: true as const,
  }
  return Object.freeze({
    ...body,
    aggregationHash: calculateCanonicalHash(body),
    workingSetBytes: serializedBytes(body),
  })
}

function sameTierVersion(
  left: Readonly<HierarchicalTierVersion>,
  right: Readonly<HierarchicalTierVersion>,
): boolean {
  return calculateCanonicalHash(left) === calculateCanonicalHash(right)
}

function transitiveInvalidations(
  directlyChanged: ReadonlySet<ProcessingTier>,
): ReadonlySet<ProcessingTier> {
  const invalidated = new Set(directlyChanged)
  let changed = true
  while (changed) {
    changed = false
    for (const tier of HIERARCHICAL_PROCESSING_TIERS) {
      if (
        !invalidated.has(tier) &&
        HIERARCHICAL_TIER_DEPENDENCIES[tier]
          .some((dependency) => invalidated.has(dependency))
      ) {
        invalidated.add(tier)
        changed = true
      }
    }
  }
  return invalidated
}

export function planHierarchicalProcessing(input: {
  tierVersions: HierarchicalTierVersions
  previousTierVersions?: HierarchicalTierVersions
  chunkConfigurationChanged: boolean
}): Readonly<HierarchicalProcessingPlan> {
  const directlyChanged = new Set<ProcessingTier>()
  if (!input.previousTierVersions || input.chunkConfigurationChanged) {
    for (const tier of HIERARCHICAL_PROCESSING_TIERS) {
      directlyChanged.add(tier)
    }
  } else {
    for (const tier of HIERARCHICAL_PROCESSING_TIERS) {
      if (
        !sameTierVersion(
          input.tierVersions[tier],
          input.previousTierVersions[tier],
        )
      ) {
        directlyChanged.add(tier)
      }
    }
  }
  const invalidated = transitiveInvalidations(directlyChanged)
  const tiers = HIERARCHICAL_PROCESSING_TIERS.map((tier, sequence) =>
    Object.freeze({
      tier,
      sequence,
      version: input.tierVersions[tier],
      prerequisites: HIERARCHICAL_TIER_DEPENDENCIES[tier],
      status: invalidated.has(tier)
        ? 'process' as const
        : 'reuse' as const,
    }))
  const executionOrder = HIERARCHICAL_PROCESSING_TIERS
    .filter((tier) => invalidated.has(tier))
  const body = {
    tiers: Object.freeze(tiers),
    executionOrder: Object.freeze(executionOrder),
    invalidatedTiers: Object.freeze(executionOrder),
    cheapSignalsFirst: true as const,
  }
  return Object.freeze({
    ...body,
    planHash: calculateCanonicalHash(body),
  })
}

export function estimateHierarchicalFixture(input: {
  durationMs: number
  chunkCount: number
  workingSetBytes: number
  costMinorUnits: number
  elapsedMs: number
}): Readonly<{
  durationMs: number
  chunkCount: number
  workingSetBytes: number
  costMinorUnits: number
  elapsedMs: number
  bounded: boolean
  measurementHash: string
}> {
  assertDomain(
    [input.durationMs, input.chunkCount, input.workingSetBytes,
      input.costMinorUnits, input.elapsedMs]
      .every((value) => Number.isSafeInteger(value) && value >= 0) &&
      input.durationMs > 0 &&
      input.chunkCount > 0,
    'INVALID_ARGUMENT',
    'Hierarchical fixture measurement is invalid',
  )
  const body = {
    ...input,
    bounded:
      input.durationMs <= 7_200_000 &&
      input.workingSetBytes <= 256 * 1024 * 1024 &&
      input.costMinorUnits <= 10_000 &&
      input.elapsedMs <= 30 * 60 * 1_000,
  }
  return Object.freeze({
    ...body,
    measurementHash: calculateCanonicalHash(body),
  })
}
