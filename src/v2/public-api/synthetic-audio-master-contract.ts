import type { PersistedSyntheticAudioMaster } from '../application/ports/synthetic-audio-master-repository.ts'
import { assertDomain } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}
function exact(value: Record<string, unknown>, keys: readonly string[], field: string) {
  assertDomain(Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value), 'INVALID_ARGUMENT', `${field} contains missing or unsupported properties`)
}

export function parseCreateSyntheticAudioMasterBody(raw: unknown) {
  const body = record(raw, 'body')
  const keys = ['projectVersionId', 'profileSnapshotId', 'source', 'audioArtifactId', 'alignmentEvidenceArtifactId', 'durationMs', 'locale', 'words', 'approvedAt', 'approvalCriticHash', 'use', 'market']
  exact(body, keys, 'body')
  const source = record(body.source, 'body.source')
  assertDomain(source.kind === 'tts' || source.kind === 'uploaded', 'INVALID_ARGUMENT', 'body.source.kind is unsupported')
  if (source.kind === 'tts') exact(source, ['kind', 'text', 'providerJobId'], 'body.source')
  else exact(source, ['kind'], 'body.source')
  assertDomain(Array.isArray(body.words) && body.words.length > 0 && body.words.length <= 100_000, 'INVALID_ARGUMENT', 'body.words must be a bounded non-empty array')
  const words = body.words.map((value, index) => {
    const word = record(value, `body.words[${index}]`)
    exact(word, ['word', 'startMs', 'endMs', 'confidence'], `body.words[${index}]`)
    assertDomain(Number.isSafeInteger(word.startMs) && Number.isSafeInteger(word.endMs) && typeof word.confidence === 'number' && Number.isFinite(word.confidence), 'INVALID_ARGUMENT', `body.words[${index}] timing or confidence is invalid`)
    return Object.freeze({ word: string(word.word, `body.words[${index}].word`), startMs: word.startMs as number, endMs: word.endMs as number, confidence: word.confidence })
  })
  assertDomain(Number.isSafeInteger(body.durationMs), 'INVALID_ARGUMENT', 'body.durationMs must be an integer')
  return Object.freeze({
    projectVersionId: string(body.projectVersionId, 'body.projectVersionId'),
    profileSnapshotId: string(body.profileSnapshotId, 'body.profileSnapshotId'),
    source: source.kind === 'tts'
      ? Object.freeze({ kind: 'tts' as const, text: string(source.text, 'body.source.text'), providerJobId: string(source.providerJobId, 'body.source.providerJobId') })
      : Object.freeze({ kind: 'uploaded' as const }),
    audioArtifactId: string(body.audioArtifactId, 'body.audioArtifactId'),
    alignmentEvidenceArtifactId: string(body.alignmentEvidenceArtifactId, 'body.alignmentEvidenceArtifactId'),
    durationMs: body.durationMs as number,
    locale: string(body.locale, 'body.locale'),
    words: Object.freeze(words),
    approvedAt: string(body.approvedAt, 'body.approvedAt'),
    approvalCriticHash: string(body.approvalCriticHash, 'body.approvalCriticHash'),
    use: string(body.use, 'body.use'),
    market: string(body.market, 'body.market'),
  })
}

export function presentSyntheticAudioMaster(value: Readonly<PersistedSyntheticAudioMaster>) {
  return Object.freeze({ ...value.master })
}
