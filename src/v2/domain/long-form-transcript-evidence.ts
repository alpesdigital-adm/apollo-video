import {
  calculateCanonicalHash,
} from './canonical-hash.ts'
import type {
  HierarchicalEvidenceSpan,
} from './hierarchical-processing.ts'
import { assertDomain } from './errors.ts'

export interface LongFormMomentTranscriptEvidence {
  schemaVersion: 'long-form-moment-transcript-evidence/v1'
  id: string
  workspaceId: string
  projectId: string
  indexRunId: string
  indexRunHash: string
  momentId: string
  momentHash: string
  hierarchicalRunId: string
  hierarchicalRunHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  spans: readonly Readonly<HierarchicalEvidenceSpan>[]
  spanCount: number
  rangeMs: readonly [number, number]
  wordCount: number
  evidenceHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: string, field: string): string {
  const normalized = value?.trim()
  assertDomain(
    ID.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function hash(value: string, field: string): string {
  assertDomain(
    HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function validateSpan(
  span: Readonly<HierarchicalEvidenceSpan>,
  previousStartMs: number,
): void {
  const content = {
    id: identity(span.id, 'span.id'),
    sourceSegmentId: span.sourceSegmentId,
    rangeMs: span.rangeMs,
    text: span.text,
    textHash: span.textHash,
    wordCount: span.wordCount,
    chunkIds: span.chunkIds,
  }
  assertDomain(
    Number.isSafeInteger(span.sourceSegmentId) &&
      span.sourceSegmentId >= 0 &&
      Array.isArray(span.rangeMs) &&
      span.rangeMs.length === 2 &&
      Number.isSafeInteger(span.rangeMs[0]) &&
      Number.isSafeInteger(span.rangeMs[1]) &&
      span.rangeMs[0] >= previousStartMs &&
      span.rangeMs[1] > span.rangeMs[0] &&
      typeof span.text === 'string' &&
      span.text.trim() === span.text &&
      span.text.length > 0 &&
      span.text.length <= 10_000 &&
      calculateCanonicalHash(span.text) === span.textHash &&
      Number.isSafeInteger(span.wordCount) &&
      span.wordCount ===
        span.text.split(/\s+/u).filter(Boolean).length &&
      Array.isArray(span.chunkIds) &&
      span.chunkIds.length > 0 &&
      span.chunkIds.length <= 16 &&
      new Set(span.chunkIds).size === span.chunkIds.length &&
      span.chunkIds.every((chunkId) => ID.test(chunkId)) &&
      calculateCanonicalHash(content) === span.spanHash,
    'INVALID_ARGUMENT',
    'transcript evidence span is invalid',
  )
}

export function createLongFormMomentTranscriptEvidence(
  input: Omit<
    LongFormMomentTranscriptEvidence,
    | 'schemaVersion'
    | 'spanCount'
    | 'rangeMs'
    | 'wordCount'
    | 'evidenceHash'
  >,
): Readonly<LongFormMomentTranscriptEvidence> {
  assertDomain(
    Array.isArray(input.spans) &&
      input.spans.length > 0 &&
      input.spans.length <= 1_024 &&
      new Set(input.spans.map((span) => span.id)).size ===
        input.spans.length,
    'INVALID_ARGUMENT',
    'transcript evidence spans are invalid',
  )
  let previousStartMs = 0
  for (const span of input.spans) {
    validateSpan(span, previousStartMs)
    previousStartMs = span.rangeMs[0]
  }
  const spans = Object.freeze([...input.spans])
  const body = Object.freeze({
    schemaVersion:
      'long-form-moment-transcript-evidence/v1' as const,
    id: identity(input.id, 'id'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    indexRunId: identity(input.indexRunId, 'indexRunId'),
    indexRunHash: hash(input.indexRunHash, 'indexRunHash'),
    momentId: identity(input.momentId, 'momentId'),
    momentHash: hash(input.momentHash, 'momentHash'),
    hierarchicalRunId: identity(
      input.hierarchicalRunId,
      'hierarchicalRunId',
    ),
    hierarchicalRunHash: hash(
      input.hierarchicalRunHash,
      'hierarchicalRunHash',
    ),
    sourceTranscriptId: identity(
      input.sourceTranscriptId,
      'sourceTranscriptId',
    ),
    sourceTranscriptHash: hash(
      input.sourceTranscriptHash,
      'sourceTranscriptHash',
    ),
    spans,
    spanCount: spans.length,
    rangeMs: Object.freeze([
      Math.min(...spans.map((span) => span.rangeMs[0])),
      Math.max(...spans.map((span) => span.rangeMs[1])),
    ]) as readonly [number, number],
    wordCount: spans.reduce(
      (total, span) => total + span.wordCount,
      0,
    ),
  })
  return Object.freeze({
    ...body,
    evidenceHash: calculateCanonicalHash(body),
  })
}
