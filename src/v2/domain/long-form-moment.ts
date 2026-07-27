import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { normalizeSpeechText } from './speech-segment-catalog.ts'

export const LONG_FORM_INDEX_POLICY_VERSION = 'long-form-index/v1' as const

export interface LongFormProducer {
  provider: string
  model: string
  version: string
  confidence: number
}

export interface LongFormObservationInput {
  value: string
  confidence: number
}

export interface LongFormObservation {
  value: string
  normalizedValue: string
  provenance: Readonly<{
    source: 'long-form-analysis'
    provider: string
    model: string
    version: string
    confidence: number
    observedAt: string
  }>
}

export interface LongFormChapterInput {
  sourceChapterId: string
  title: LongFormObservationInput
  topicPath: readonly string[]
  rangeMs: readonly [number, number]
}

export interface LongFormMomentInput {
  sourceMomentId: string
  sourceChapterId: string
  topic: LongFormObservationInput
  summary: LongFormObservationInput
  keyQuote?: LongFormObservationInput
  speakerIds: readonly string[]
  rangesMs: readonly (readonly [number, number])[]
  recommendedRangeIndex: number
  evidenceSpanIds: readonly string[]
  salience: number
  hookPotential: number
  standaloneScore: number
  contextScore: number
  insightDensity: number
  roles: readonly string[]
  tags: readonly string[]
}

export interface CatalogedLongFormChapter {
  schemaVersion: 'long-form-chapter/v1'
  id: string
  workspaceId: string
  projectId: string
  indexRunId: string
  sourceArtifactId: string
  sourceChapterId: string
  title: Readonly<LongFormObservation>
  topicPath: readonly string[]
  rangeMs: readonly [number, number]
  momentIds: readonly string[]
  physicalMaterialized: false
  indexPolicyVersion: typeof LONG_FORM_INDEX_POLICY_VERSION
  createdAt: string
  chapterHash: string
}

export interface CatalogedLongFormMoment {
  schemaVersion: 'long-form-moment/v1'
  id: string
  workspaceId: string
  projectId: string
  indexRunId: string
  chapterId: string
  sourceArtifactId: string
  sourceMomentId: string
  topic: Readonly<LongFormObservation>
  summary: Readonly<LongFormObservation>
  keyQuote?: Readonly<LongFormObservation>
  speakerIds: readonly string[]
  rangesMs: readonly (readonly [number, number])[]
  recommendedRangeIndex: number
  recommendedRangeMs: readonly [number, number]
  evidenceSpanIds: readonly string[]
  salience: number
  hookPotential: number
  standaloneScore: number
  contextScore: number
  insightDensity: number
  roles: readonly string[]
  tags: readonly string[]
  physicalMaterialized: false
  indexPolicyVersion: typeof LONG_FORM_INDEX_POLICY_VERSION
  createdAt: string
  momentHash: string
}

export interface LongFormMomentPreview {
  sourceArtifactId: string
  masterDurationMs: number
  requestedContextMs: Readonly<{ before: number; after: number }>
  primary: Readonly<{
    sourceRangeMs: readonly [number, number]
    previewRangeMs: readonly [number, number]
    clippedBefore: boolean
    clippedAfter: boolean
  }>
  ranges: readonly Readonly<{
    sourceRangeMs: readonly [number, number]
    previewRangeMs: readonly [number, number]
    clippedBefore: boolean
    clippedAfter: boolean
  }>[]
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function text(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  assertDomain(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim().length <= maxLength,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = value.trim()
  assertDomain(
    normalizeSpeechText(normalized).length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function score(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return value
}

export function normalizeLongFormProducer(
  input: LongFormProducer,
): Readonly<LongFormProducer> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'producer is required',
  )
  const provider = input.provider?.trim()
  const model = input.model?.trim()
  const version = input.version?.trim()
  assertDomain(
    typeof provider === 'string' &&
      typeof model === 'string' &&
      typeof version === 'string' &&
      TOKEN.test(provider) &&
      TOKEN.test(model) &&
      TOKEN.test(version),
    'INVALID_ARGUMENT',
    'producer identity is invalid',
  )
  return Object.freeze({
    provider,
    model,
    version,
    confidence: score(input.confidence, 'producer.confidence'),
  })
}

function observation(
  input: LongFormObservationInput,
  producer: Readonly<LongFormProducer>,
  observedAt: string,
  field: string,
  maxLength: number,
): Readonly<LongFormObservation> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    `${field} is required`,
  )
  const value = text(input.value, field, maxLength)
  return Object.freeze({
    value,
    normalizedValue: normalizeSpeechText(value),
    provenance: Object.freeze({
      source: 'long-form-analysis' as const,
      provider: producer.provider,
      model: producer.model,
      version: producer.version,
      confidence: score(input.confidence, `${field}.confidence`),
      observedAt,
    }),
  })
}

function textList(
  values: readonly string[],
  field: string,
  maxItems: number,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= maxItems,
    'INVALID_ARGUMENT',
    `${field} must contain at most ${maxItems} values`,
  )
  const normalized = values.map((value) => text(value, field, 240))
  assertDomain(
    new Set(normalized.map(normalizeSpeechText)).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicates`,
  )
  return Object.freeze([...normalized])
}

function referenceList(
  values: readonly string[],
  field: string,
  maxItems = 128,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= maxItems,
    'INVALID_ARGUMENT',
    `${field} must contain at most ${maxItems} references`,
  )
  const normalized = values.map((value) => identity(value, field))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicates`,
  )
  return Object.freeze([...normalized].sort())
}

function sourceRange(
  value: readonly [number, number],
  durationMs: number,
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      value.every(Number.isSafeInteger) &&
      value[0] >= 0 &&
      value[1] > value[0] &&
      value[1] <= durationMs,
    'INVALID_ARGUMENT',
    `${field} is outside the long-form master`,
  )
  return Object.freeze([value[0], value[1]])
}

function sourceRanges(
  values: readonly (readonly [number, number])[],
  durationMs: number,
  chapterRange: readonly [number, number],
  field: string,
): readonly (readonly [number, number])[] {
  assertDomain(
    Array.isArray(values) && values.length >= 1 && values.length <= 32,
    'INVALID_ARGUMENT',
    `${field} must contain between 1 and 32 ranges`,
  )
  const ranges = values.map((value, index) =>
    sourceRange(value, durationMs, `${field}[${index}]`))
  for (let index = 0; index < ranges.length; index += 1) {
    const current = ranges[index]
    const previous = ranges[index - 1]
    assertDomain(
      current[0] >= chapterRange[0] &&
        current[1] <= chapterRange[1] &&
        (!previous || current[0] >= previous[1]),
      'INVALID_ARGUMENT',
      `${field} must be chronological and contained by its chapter`,
    )
  }
  return Object.freeze(ranges)
}

export function catalogLongFormHierarchy(input: {
  workspaceId: string
  projectId: string
  indexRunId: string
  sourceArtifactId: string
  durationMs: number
  chapters: readonly LongFormChapterInput[]
  moments: readonly LongFormMomentInput[]
  producer: LongFormProducer
  createdAt: string
  createId: (
    kind: 'long-form-chapter' | 'long-form-moment',
    sourceId: string,
  ) => string
}): Readonly<{
  chapters: readonly Readonly<CatalogedLongFormChapter>[]
  moments: readonly Readonly<CatalogedLongFormMoment>[]
}> {
  const date = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(date.getTime()) && date.toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'long-form createdAt is invalid',
  )
  assertDomain(
    Number.isSafeInteger(input.durationMs) && input.durationMs > 0,
    'INVALID_ARGUMENT',
    'long-form duration must be a positive integer',
  )
  assertDomain(
    Array.isArray(input.chapters) &&
      input.chapters.length >= 1 &&
      input.chapters.length <= 10_000,
    'INVALID_ARGUMENT',
    'chapters must contain between 1 and 10000 entries',
  )
  assertDomain(
    Array.isArray(input.moments) &&
      input.moments.length >= 1 &&
      input.moments.length <= 100_000,
    'INVALID_ARGUMENT',
    'moments must contain between 1 and 100000 entries',
  )
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const indexRunId = identity(input.indexRunId, 'indexRunId')
  const sourceArtifactId = identity(
    input.sourceArtifactId,
    'sourceArtifactId',
  )
  const producer = normalizeLongFormProducer(input.producer)
  const sourceChapterIds = input.chapters.map((chapter) =>
    identity(chapter.sourceChapterId, 'chapter.sourceChapterId'))
  const sourceMomentIds = input.moments.map((moment) =>
    identity(moment.sourceMomentId, 'moment.sourceMomentId'))
  assertDomain(
    new Set(sourceChapterIds).size === sourceChapterIds.length,
    'INVALID_ARGUMENT',
    'chapter source identities must be unique',
  )
  assertDomain(
    new Set(sourceMomentIds).size === sourceMomentIds.length,
    'INVALID_ARGUMENT',
    'moment source identities must be unique',
  )
  const chapterDrafts = input.chapters.map((chapter, index) => {
    const rangeMs = sourceRange(
      chapter.rangeMs,
      input.durationMs,
      `chapters[${index}].rangeMs`,
    )
    const previous = index > 0
      ? sourceRange(
          input.chapters[index - 1].rangeMs,
          input.durationMs,
          `chapters[${index - 1}].rangeMs`,
        )
      : undefined
    assertDomain(
      !previous || rangeMs[0] >= previous[1],
      'INVALID_ARGUMENT',
      'chapters must be chronological and non-overlapping',
    )
    return {
      sourceChapterId: sourceChapterIds[index],
      id: identity(
        input.createId('long-form-chapter', sourceChapterIds[index]),
        'chapter.id',
      ),
      title: observation(
        chapter.title,
        producer,
        input.createdAt,
        `chapters[${index}].title`,
        240,
      ),
      topicPath: textList(
        chapter.topicPath,
        `chapters[${index}].topicPath`,
        16,
      ),
      rangeMs,
    }
  })
  assertDomain(
    new Set(chapterDrafts.map((chapter) => chapter.id)).size ===
      chapterDrafts.length,
    'INVALID_ARGUMENT',
    'generated chapter identities must be unique',
  )
  const chapterBySource = new Map(
    chapterDrafts.map((chapter) => [chapter.sourceChapterId, chapter]),
  )
  const moments = input.moments.map((moment, index) => {
    const sourceChapterId = sourceChapterIds.includes(moment.sourceChapterId)
      ? moment.sourceChapterId
      : identity(moment.sourceChapterId, 'moment.sourceChapterId')
    const chapter = chapterBySource.get(sourceChapterId)
    assertDomain(
      chapter !== undefined,
      'INVALID_ARGUMENT',
      `moments[${index}] references an unknown chapter`,
    )
    const rangesMs = sourceRanges(
      moment.rangesMs,
      input.durationMs,
      chapter.rangeMs,
      `moments[${index}].rangesMs`,
    )
    assertDomain(
      Number.isSafeInteger(moment.recommendedRangeIndex) &&
        moment.recommendedRangeIndex >= 0 &&
        moment.recommendedRangeIndex < rangesMs.length,
      'INVALID_ARGUMENT',
      `moments[${index}].recommendedRangeIndex is invalid`,
    )
    const content = Object.freeze({
      schemaVersion: 'long-form-moment/v1' as const,
      id: identity(
        input.createId('long-form-moment', sourceMomentIds[index]),
        'moment.id',
      ),
      workspaceId,
      projectId,
      indexRunId,
      chapterId: chapter.id,
      sourceArtifactId,
      sourceMomentId: sourceMomentIds[index],
      topic: observation(
        moment.topic,
        producer,
        input.createdAt,
        `moments[${index}].topic`,
        500,
      ),
      summary: observation(
        moment.summary,
        producer,
        input.createdAt,
        `moments[${index}].summary`,
        5_000,
      ),
      ...(moment.keyQuote
        ? {
            keyQuote: observation(
              moment.keyQuote,
              producer,
              input.createdAt,
              `moments[${index}].keyQuote`,
              2_000,
            ),
          }
        : {}),
      speakerIds: referenceList(
        moment.speakerIds,
        `moments[${index}].speakerIds`,
        64,
      ),
      rangesMs,
      recommendedRangeIndex: moment.recommendedRangeIndex,
      recommendedRangeMs: rangesMs[moment.recommendedRangeIndex],
      evidenceSpanIds: referenceList(
        moment.evidenceSpanIds,
        `moments[${index}].evidenceSpanIds`,
        256,
      ),
      salience: score(moment.salience, `moments[${index}].salience`),
      hookPotential: score(
        moment.hookPotential,
        `moments[${index}].hookPotential`,
      ),
      standaloneScore: score(
        moment.standaloneScore,
        `moments[${index}].standaloneScore`,
      ),
      contextScore: score(
        moment.contextScore,
        `moments[${index}].contextScore`,
      ),
      insightDensity: score(
        moment.insightDensity,
        `moments[${index}].insightDensity`,
      ),
      roles: textList(
        moment.roles,
        `moments[${index}].roles`,
        32,
      ),
      tags: textList(moment.tags, `moments[${index}].tags`, 64),
      physicalMaterialized: false as const,
      indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
      createdAt: input.createdAt,
    })
    return Object.freeze({
      ...content,
      momentHash: calculateCanonicalHash(content),
    })
  })
  assertDomain(
    new Set(moments.map((moment) => moment.id)).size === moments.length,
    'INVALID_ARGUMENT',
    'generated moment identities must be unique',
  )
  const chapters = chapterDrafts.map((chapter) => {
    const content = Object.freeze({
      schemaVersion: 'long-form-chapter/v1' as const,
      id: chapter.id,
      workspaceId,
      projectId,
      indexRunId,
      sourceArtifactId,
      sourceChapterId: chapter.sourceChapterId,
      title: chapter.title,
      topicPath: chapter.topicPath,
      rangeMs: chapter.rangeMs,
      momentIds: Object.freeze(
        moments
          .filter((moment) => moment.chapterId === chapter.id)
          .map((moment) => moment.id),
      ),
      physicalMaterialized: false as const,
      indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
      createdAt: input.createdAt,
    })
    return Object.freeze({
      ...content,
      chapterHash: calculateCanonicalHash(content),
    })
  })
  return Object.freeze({
    chapters: Object.freeze(chapters),
    moments: Object.freeze(moments),
  })
}

function contextAmount(value: number, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0 && value <= 300_000,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 0 and 300000`,
  )
  return value
}

export function buildLongFormMomentPreview(input: {
  moment: Readonly<CatalogedLongFormMoment>
  masterDurationMs: number
  contextBeforeMs: number
  contextAfterMs: number
}): Readonly<LongFormMomentPreview> {
  assertDomain(
    Number.isSafeInteger(input.masterDurationMs) &&
      input.masterDurationMs > 0 &&
      input.moment.rangesMs.every(
        ([start, end]) =>
          start >= 0 && end > start && end <= input.masterDurationMs,
      ),
    'INVALID_ARGUMENT',
    'moment ranges are outside the long-form master',
  )
  const before = contextAmount(input.contextBeforeMs, 'contextBeforeMs')
  const after = contextAmount(input.contextAfterMs, 'contextAfterMs')
  const ranges = Object.freeze(input.moment.rangesMs.map((range) => {
    const previewStart = Math.max(0, range[0] - before)
    const previewEnd = Math.min(input.masterDurationMs, range[1] + after)
    return Object.freeze({
      sourceRangeMs: range,
      previewRangeMs: Object.freeze([
        previewStart,
        previewEnd,
      ]) as readonly [number, number],
      clippedBefore: previewStart !== range[0] - before,
      clippedAfter: previewEnd !== range[1] + after,
    })
  }))
  return Object.freeze({
    sourceArtifactId: input.moment.sourceArtifactId,
    masterDurationMs: input.masterDurationMs,
    requestedContextMs: Object.freeze({ before, after }),
    primary: ranges[input.moment.recommendedRangeIndex],
    ranges,
  })
}
