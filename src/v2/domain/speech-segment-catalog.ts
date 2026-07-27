import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type {
  MediaTranscript,
  TranscriptSegment,
  TranscriptWord,
} from './media-transcript.ts'

export const SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION =
  'speech-segment-extraction/v1' as const

export const SPEECH_SEGMENT_CLASSIFICATIONS = [
  'complete-thought',
  'incomplete',
  'interrupted',
] as const

export type SpeechSegmentClassification =
  typeof SPEECH_SEGMENT_CLASSIFICATIONS[number]

export interface SpeechCatalogProducer {
  provider: string
  model: string
  version: string
  confidence: number
}

export interface SpeechCatalogObservedInput {
  value: string
  confidence: number
}

export interface SpeechSegmentAnnotationInput {
  sourceSegmentId: number
  speaker?: SpeechCatalogObservedInput
  visual?: Readonly<{
    emotion?: SpeechCatalogObservedInput
    expression?: SpeechCatalogObservedInput
    wardrobe?: SpeechCatalogObservedInput
    setting?: SpeechCatalogObservedInput
    colors?: readonly SpeechCatalogObservedInput[]
  }>
  intentions?: readonly SpeechCatalogObservedInput[]
}

export interface SpeechCatalogProvenance {
  source: 'transcript' | 'catalog-observation'
  provider: string
  model: string
  version: string
  confidence: number
  observedAt: string
}

export interface SpeechCatalogObservation {
  value: string
  normalizedValue: string
  provenance: Readonly<SpeechCatalogProvenance>
}

export interface SpeechCatalogWordAlignment {
  word: string
  startMs: number
  endMs: number
  confidence: number
}

export interface CatalogedSpeechSegment {
  schemaVersion: 'speech-segment/v1'
  id: string
  workspaceId: string
  projectId: string
  catalogRunId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  sourceArtifactId: string
  sourceSegmentId: number
  exactText: string
  normalizedText: string
  words: readonly Readonly<SpeechCatalogWordAlignment>[]
  speaker: Readonly<SpeechCatalogObservation>
  speakerId: string
  rangeMs: readonly [number, number]
  completeThoughtScore: number
  classification: SpeechSegmentClassification
  visual: Readonly<{
    emotion?: Readonly<SpeechCatalogObservation>
    expression?: Readonly<SpeechCatalogObservation>
    wardrobe?: Readonly<SpeechCatalogObservation>
    setting?: Readonly<SpeechCatalogObservation>
    colors: readonly Readonly<SpeechCatalogObservation>[]
  }>
  intentions: readonly Readonly<SpeechCatalogObservation>[]
  extractionProvenance: Readonly<SpeechCatalogProvenance>
  extractionPolicyVersion: typeof SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION
  physicalMaterialized: false
  createdAt: string
  segmentHash: string
}

const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export function normalizeSpeechText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function identity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function producer(input: SpeechCatalogProducer): Readonly<SpeechCatalogProducer> {
  const provider = input.provider.trim()
  const model = input.model.trim()
  const version = input.version.trim()
  assertDomain(
    TOKEN.test(provider) && TOKEN.test(model) && TOKEN.test(version),
    'INVALID_ARGUMENT',
    'Speech catalog producer identity is invalid',
  )
  assertDomain(
    Number.isFinite(input.confidence) &&
      input.confidence >= 0 &&
      input.confidence <= 1,
    'INVALID_ARGUMENT',
    'Speech catalog producer confidence is invalid',
  )
  return Object.freeze({
    provider,
    model,
    version,
    confidence: input.confidence,
  })
}

function observation(
  input: SpeechCatalogObservedInput,
  provenance: Omit<SpeechCatalogProvenance, 'confidence'>,
  field: string,
): Readonly<SpeechCatalogObservation> {
  const value = input.value.trim()
  const normalizedValue = normalizeSpeechText(value)
  assertDomain(
    value.length > 0 && value.length <= 240 && normalizedValue.length > 0,
    'INVALID_ARGUMENT',
    `${field} value is invalid`,
  )
  assertDomain(
    Number.isFinite(input.confidence) &&
      input.confidence >= 0 &&
      input.confidence <= 1,
    'INVALID_ARGUMENT',
    `${field} confidence is invalid`,
  )
  return Object.freeze({
    value,
    normalizedValue,
    provenance: Object.freeze({
      ...provenance,
      confidence: input.confidence,
    }),
  })
}

function transcriptObservation(
  value: string,
  input: {
    transcript: Readonly<MediaTranscript>
    confidence: number
    observedAt: string
  },
): Readonly<SpeechCatalogObservation> {
  return observation(
    { value, confidence: input.confidence },
    {
      source: 'transcript',
      provider: input.transcript.provider,
      model: input.transcript.model,
      version: input.transcript.schemaVersion,
      observedAt: input.observedAt,
    },
    'speaker',
  )
}

function milliseconds(seconds: number): number {
  return Math.round(seconds * 1_000)
}

function alignedWords(
  transcriptWords: readonly TranscriptWord[],
  source: Readonly<TranscriptSegment>,
): readonly TranscriptWord[] {
  const tolerance = 0.05
  return transcriptWords.filter(
    (word) =>
      word.start + tolerance >= source.start &&
      word.end <= source.end + tolerance,
  )
}

function thoughtAssessment(
  exactText: string,
  wordCount: number,
  transcriptConfidence: number,
): Readonly<{
  score: number
  classification: SpeechSegmentClassification
}> {
  const trimmed = exactText.trim()
  const normalized = normalizeSpeechText(trimmed)
  const interrupted =
    /(?:\.{2,}|…|[-—])$/.test(trimmed) ||
    /\b(?:interrompido|interrompida|cortado|cortada)$/.test(normalized)
  const dangling =
    /[,;:]$/.test(trimmed) ||
    /\b(?:e|mas|porque|que|para|como|se|quando|and|but|because|that|to)$/.test(
      normalized,
    )
  const terminal = /[.!?]["')\]]?$/.test(trimmed)

  let base: number
  let classification: SpeechSegmentClassification
  if (interrupted) {
    base = 0.2
    classification = 'interrupted'
  } else if (dangling || wordCount < 3) {
    base = 0.36
    classification = 'incomplete'
  } else if (terminal) {
    base = 0.94
    classification = 'complete-thought'
  } else if (wordCount >= 6) {
    base = 0.72
    classification = 'complete-thought'
  } else {
    base = 0.52
    classification = 'incomplete'
  }

  const score = Number(
    Math.max(
      0,
      Math.min(1, base * (0.7 + transcriptConfidence * 0.3)),
    ).toFixed(4),
  )
  return Object.freeze({ score, classification })
}

function freezeWord(
  word: Readonly<TranscriptWord>,
  confidence: number,
): Readonly<SpeechCatalogWordAlignment> {
  return Object.freeze({
    word: word.word,
    startMs: milliseconds(word.start),
    endMs: milliseconds(word.end),
    confidence,
  })
}

function annotationMap(
  transcript: Readonly<MediaTranscript>,
  annotations: readonly Readonly<SpeechSegmentAnnotationInput>[],
): ReadonlyMap<number, Readonly<SpeechSegmentAnnotationInput>> {
  const validIds = new Set(transcript.segments.map((segment) => segment.id))
  const result = new Map<number, Readonly<SpeechSegmentAnnotationInput>>()
  for (const annotation of annotations) {
    assertDomain(
      Number.isInteger(annotation.sourceSegmentId) &&
        validIds.has(annotation.sourceSegmentId),
      'INVALID_ARGUMENT',
      'Speech segment annotation references an unknown transcript segment',
    )
    assertDomain(
      !result.has(annotation.sourceSegmentId),
      'INVALID_ARGUMENT',
      'Speech segment annotations must be unique by source segment',
    )
    assertDomain(
      (annotation.visual?.colors?.length ?? 0) <= 32 &&
        (annotation.intentions?.length ?? 0) <= 64,
      'INVALID_ARGUMENT',
      'Speech segment annotation metadata exceeds catalog bounds',
    )
    result.set(annotation.sourceSegmentId, annotation)
  }
  return result
}

function catalogObservationProvenance(
  catalogProducer: Readonly<SpeechCatalogProducer>,
  observedAt: string,
): Omit<SpeechCatalogProvenance, 'confidence'> {
  return Object.freeze({
    source: 'catalog-observation' as const,
    provider: catalogProducer.provider,
    model: catalogProducer.model,
    version: catalogProducer.version,
    observedAt,
  })
}

export function catalogSpeechSegments(input: {
  workspaceId: string
  projectId: string
  catalogRunId: string
  sourceTranscriptId: string
  sourceArtifactId: string
  transcript: Readonly<MediaTranscript>
  annotations: readonly Readonly<SpeechSegmentAnnotationInput>[]
  producer: Readonly<SpeechCatalogProducer>
  createdAt: string
  createSegmentId: (sourceSegmentId: number) => string
}): readonly Readonly<CatalogedSpeechSegment>[] {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const catalogRunId = identity(input.catalogRunId, 'catalogRunId')
  const sourceTranscriptId = identity(
    input.sourceTranscriptId,
    'sourceTranscriptId',
  )
  const sourceArtifactId = identity(input.sourceArtifactId, 'sourceArtifactId')
  const catalogProducer = producer(input.producer)
  const createdAtDate = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAtDate.getTime()) &&
      createdAtDate.toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'Speech catalog createdAt is invalid',
  )
  assertDomain(
    input.transcript.words.length > 0 &&
      input.transcript.segments.length > 0,
    'INVALID_ARGUMENT',
    'Speech catalog requires an aligned transcript',
  )

  const annotations = annotationMap(input.transcript, input.annotations)
  const observedProvenance = catalogObservationProvenance(
    catalogProducer,
    input.createdAt,
  )

  return Object.freeze(
    input.transcript.segments.map((source) => {
      const words = alignedWords(input.transcript.words, source)
      assertDomain(
        source.end > source.start && words.length > 0,
        'INVALID_ARGUMENT',
        `Transcript segment ${source.id} has no aligned words`,
      )
      const transcriptConfidence = source.confidence ?? catalogProducer.confidence
      const annotation = annotations.get(source.id)
      const speaker = annotation?.speaker
        ? observation(
            annotation.speaker,
            observedProvenance,
            `annotations[${source.id}].speaker`,
          )
        : transcriptObservation('speaker-unknown', {
            transcript: input.transcript,
            confidence: transcriptConfidence,
            observedAt: input.createdAt,
          })
      const visual = annotation?.visual ?? {}
      const observedVisual = Object.freeze({
        ...(visual.emotion
          ? {
              emotion: observation(
                visual.emotion,
                observedProvenance,
                `annotations[${source.id}].visual.emotion`,
              ),
            }
          : {}),
        ...(visual.expression
          ? {
              expression: observation(
                visual.expression,
                observedProvenance,
                `annotations[${source.id}].visual.expression`,
              ),
            }
          : {}),
        ...(visual.wardrobe
          ? {
              wardrobe: observation(
                visual.wardrobe,
                observedProvenance,
                `annotations[${source.id}].visual.wardrobe`,
              ),
            }
          : {}),
        ...(visual.setting
          ? {
              setting: observation(
                visual.setting,
                observedProvenance,
                `annotations[${source.id}].visual.setting`,
              ),
            }
          : {}),
        colors: Object.freeze(
          (visual.colors ?? []).map((color, index) =>
            observation(
              color,
              observedProvenance,
              `annotations[${source.id}].visual.colors[${index}]`,
            ),
          ),
        ),
      })
      const intentions = Object.freeze(
        (annotation?.intentions ?? []).map((intention, index) =>
          observation(
            intention,
            observedProvenance,
            `annotations[${source.id}].intentions[${index}]`,
          ),
        ),
      )
      const exactText = source.text.trim()
      const normalizedText = normalizeSpeechText(exactText)
      assertDomain(
        normalizedText ===
          normalizeSpeechText(words.map((word) => word.word).join(' ')),
        'INVALID_ARGUMENT',
        `Transcript segment ${source.id} text does not match its word alignment`,
      )
      const assessment = thoughtAssessment(
        exactText,
        words.length,
        transcriptConfidence,
      )
      const extractionProvenance = Object.freeze({
        source: 'transcript' as const,
        provider: input.transcript.provider,
        model: input.transcript.model,
        version: input.transcript.schemaVersion,
        confidence: transcriptConfidence,
        observedAt: input.createdAt,
      })
      const content = Object.freeze({
        schemaVersion: 'speech-segment/v1' as const,
        id: identity(
          input.createSegmentId(source.id),
          `segment[${source.id}].id`,
        ),
        workspaceId,
        projectId,
        catalogRunId,
        sourceTranscriptId,
        sourceTranscriptHash: input.transcript.transcriptHash,
        sourceArtifactId,
        sourceSegmentId: source.id,
        exactText,
        normalizedText,
        words: Object.freeze(
          words.map((word) => freezeWord(word, transcriptConfidence)),
        ),
        speaker,
        speakerId: speaker.value,
        rangeMs: Object.freeze([
          milliseconds(source.start),
          milliseconds(source.end),
        ]) as readonly [number, number],
        completeThoughtScore: assessment.score,
        classification: assessment.classification,
        visual: observedVisual,
        intentions,
        extractionProvenance,
        extractionPolicyVersion: SPEECH_SEGMENT_EXTRACTION_POLICY_VERSION,
        physicalMaterialized: false as const,
        createdAt: input.createdAt,
      })
      return Object.freeze({
        ...content,
        segmentHash: calculateCanonicalHash(content),
      })
    }),
  )
}
