import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'

export const SYNTHETIC_AUDIO_MASTER_SCHEMA_VERSION = 'synthetic-audio-master/v1' as const

export interface SyntheticAudioWord {
  word: string
  startMs: number
  endMs: number
  confidence: number
}

export type SyntheticAudioSource = Readonly<
  | { kind: 'tts'; text: string; providerJobId: string }
  | { kind: 'uploaded' }
  | { kind: 'concatenated'; planId: string; planVersionId: string; concatenationId: string }
>

export interface SyntheticAudioMaster {
  schemaVersion: typeof SYNTHETIC_AUDIO_MASTER_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  profileSnapshotId: string
  source: SyntheticAudioSource
  audio: Readonly<{
    artifactId: string
    artifactSha256: string
    durationMs: number
    locale: string
  }>
  alignmentEvidence: Readonly<{
    artifactId: string
    artifactSha256: string
  }>
  words: readonly Readonly<SyntheticAudioWord>[]
  wordsHash: string
  approvedAt: string
  approvalCriticHash: string
  createdAt: string
  masterHash: string
}

export interface SyntheticAvatarAudioRange {
  schemaVersion: 'synthetic-avatar-audio-range/v1'
  audioMasterId: string
  audioMasterHash: string
  audioArtifactId: string
  audioArtifactSha256: string
  locale: string
  startWordIndex: number
  endWordIndex: number
  startMs: number
  endMs: number
  durationMs: number
  text: string
  rangeHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

function iso(value: string, field: string): string {
  const timestamp = Date.parse(value)
  assertDomain(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value, 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function lexicalWords(value: string): readonly string[] {
  return Object.freeze((value.normalize('NFC').toLocaleLowerCase('und').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []))
}

function body(master: Omit<SyntheticAudioMaster, 'masterHash'>) {
  return master
}

export function createSyntheticAudioMaster(input: Omit<SyntheticAudioMaster, 'schemaVersion' | 'wordsHash' | 'masterHash'>): Readonly<SyntheticAudioMaster> {
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    profileSnapshotId: input.profileSnapshotId,
    audioArtifactId: input.audio.artifactId,
    alignmentEvidenceArtifactId: input.alignmentEvidence.artifactId,
  })) assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  assertDomain(HASH.test(input.audio.artifactSha256), 'INVALID_ARGUMENT', 'audio.artifactSha256 is invalid')
  assertDomain(HASH.test(input.alignmentEvidence.artifactSha256), 'INVALID_ARGUMENT', 'alignmentEvidence.artifactSha256 is invalid')
  assertDomain(HASH.test(input.approvalCriticHash), 'INVALID_ARGUMENT', 'approvalCriticHash is invalid')
  assertDomain(Number.isSafeInteger(input.audio.durationMs) && input.audio.durationMs > 0 && input.audio.durationMs <= 21_600_000, 'INVALID_ARGUMENT', 'audio.durationMs is invalid')
  assertDomain(LOCALE.test(input.audio.locale), 'INVALID_ARGUMENT', 'audio.locale is invalid')
  assertDomain(input.words.length > 0 && input.words.length <= 100_000, 'INVALID_ARGUMENT', 'word alignment is empty or too large')
  let previousEnd = 0
  const words = input.words.map((entry, index) => {
    const word = entry.word.normalize('NFC').trim()
    assertDomain(word.length > 0 && word.length <= 240, 'INVALID_ARGUMENT', `words[${index}].word is invalid`)
    assertDomain(Number.isSafeInteger(entry.startMs) && Number.isSafeInteger(entry.endMs) && entry.startMs >= previousEnd && entry.endMs > entry.startMs && entry.endMs <= input.audio.durationMs, 'INVALID_ARGUMENT', `words[${index}] timing is invalid`)
    assertDomain(Number.isFinite(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 1, 'INVALID_ARGUMENT', `words[${index}].confidence is invalid`)
    previousEnd = entry.endMs
    return Object.freeze({ word, startMs: entry.startMs, endMs: entry.endMs, confidence: entry.confidence })
  })
  if (input.source.kind === 'tts') {
    assertDomain(ID.test(input.source.providerJobId), 'INVALID_ARGUMENT', 'source.providerJobId is invalid')
    const text = input.source.text.normalize('NFC').trim()
    assertDomain(text.length > 0 && text.length <= 100_000, 'INVALID_ARGUMENT', 'source.text is invalid')
    assertDomain(JSON.stringify(lexicalWords(text)) === JSON.stringify(words.flatMap(({ word }) => lexicalWords(word))), 'INVALID_ARGUMENT', 'TTS text does not match word alignment')
  }
  if (input.source.kind === 'concatenated') {
    assertDomain(
      ID.test(input.source.planId) && ID.test(input.source.planVersionId) && ID.test(input.source.concatenationId),
      'INVALID_ARGUMENT',
      'Concatenated source lineage is invalid',
    )
  }
  const approvedAt = iso(input.approvedAt, 'approvedAt')
  const createdAt = iso(input.createdAt, 'createdAt')
  assertDomain(Date.parse(approvedAt) <= Date.parse(createdAt), 'INVALID_ARGUMENT', 'approval cannot occur after master creation')
  const wordsHash = calculateCanonicalHash(words)
  const core = Object.freeze({
    schemaVersion: SYNTHETIC_AUDIO_MASTER_SCHEMA_VERSION,
    ...input,
    source: Object.freeze({ ...input.source }),
    audio: Object.freeze({ ...input.audio }),
    alignmentEvidence: Object.freeze({ ...input.alignmentEvidence }),
    words: Object.freeze(words),
    wordsHash,
    approvedAt,
    createdAt,
  })
  return Object.freeze({ ...core, masterHash: calculateCanonicalHash(body(core)) })
}

export function assertSyntheticAudioMaster(value: Readonly<SyntheticAudioMaster>): void {
  if (value.schemaVersion !== SYNTHETIC_AUDIO_MASTER_SCHEMA_VERSION) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic audio master schema is invalid')
  const recreated = createSyntheticAudioMaster({
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    projectVersionId: value.projectVersionId,
    profileSnapshotId: value.profileSnapshotId,
    source: value.source,
    audio: value.audio,
    alignmentEvidence: value.alignmentEvidence,
    words: value.words,
    approvedAt: value.approvedAt,
    approvalCriticHash: value.approvalCriticHash,
    createdAt: value.createdAt,
  })
  if (recreated.wordsHash !== value.wordsHash || recreated.masterHash !== value.masterHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic audio master hash is invalid')
}

export function createSyntheticAvatarAudioRange(input: {
  master: Readonly<SyntheticAudioMaster>
  startWordIndex: number
  endWordIndex: number
}): Readonly<SyntheticAvatarAudioRange> {
  assertSyntheticAudioMaster(input.master)
  assertDomain(Number.isSafeInteger(input.startWordIndex) && Number.isSafeInteger(input.endWordIndex) && input.startWordIndex >= 0 && input.endWordIndex > input.startWordIndex && input.endWordIndex <= input.master.words.length, 'INVALID_ARGUMENT', 'Synthetic avatar word range is invalid')
  const selected = input.master.words.slice(input.startWordIndex, input.endWordIndex)
  const startMs = selected[0]!.startMs
  const endMs = selected.at(-1)!.endMs
  const core = Object.freeze({
    schemaVersion: 'synthetic-avatar-audio-range/v1' as const,
    audioMasterId: input.master.id,
    audioMasterHash: input.master.masterHash,
    audioArtifactId: input.master.audio.artifactId,
    audioArtifactSha256: input.master.audio.artifactSha256,
    locale: input.master.audio.locale,
    startWordIndex: input.startWordIndex,
    endWordIndex: input.endWordIndex,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    text: selected.map(({ word }) => word).join(' '),
  })
  return Object.freeze({ ...core, rangeHash: calculateCanonicalHash(core) })
}
