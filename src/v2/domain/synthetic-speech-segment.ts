import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { SyntheticMasterAsset } from './synthetic-master-asset.ts'

export const SYNTHETIC_SPEECH_SEGMENT_SCHEMA_VERSION = 'synthetic-speech-segment/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

export interface SyntheticSpeechSegmentWord {
  word: string
  startMs: number
  endMs: number
}

/**
 * The identity attributes a reusable synthetic sentence carries. Emotion has no
 * measured source in the presenter profile today, so it stays null rather than
 * being invented; wardrobe, background and framing come from the profile's
 * declared visual continuity.
 */
export interface SyntheticSpeechSegmentIdentity {
  actorIdentityId: string
  profileId: string
  profileVersion: number
  voiceId: string
  voiceVersion: number
  avatarIdentityRef: string
  emotion: string | null
  wardrobe: string | null
  background: string | null
  framing: string | null
}

export interface SyntheticSpeechSegment {
  schemaVersion: typeof SYNTHETIC_SPEECH_SEGMENT_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  masterId: string
  masterHash: string
  /** The approved block generation whose bytes produced this sentence. */
  blockId: string
  occurrence: number
  sequence: number
  audioArtifactId: string
  videoArtifactId: string
  alignmentArtifactId: string
  exactText: string
  normalizedText: string
  scriptHash: string
  words: readonly Readonly<SyntheticSpeechSegmentWord>[]
  /** Half-open [startMs, endMs) inside the master timeline. */
  startMs: number
  endMs: number
  locale: string
  identity: Readonly<SyntheticSpeechSegmentIdentity>
  consentSnapshotHash: string
  rightsSnapshotId: string | null
  criticReportId: string
  criticReportHash: string
  createdAt: string
  segmentHash: string
}

export function normalizeSyntheticSpeechText(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .map((token) => token.replace(PUNCTUATION, ''))
    .filter((token) => token.length > 0)
    .join(' ')
}

function calculateSegmentHash(segment: Omit<SyntheticSpeechSegment, 'segmentHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: segment.schemaVersion,
    masterHash: segment.masterHash,
    blockId: segment.blockId,
    occurrence: segment.occurrence,
    scriptHash: segment.scriptHash,
    startMs: segment.startMs,
    endMs: segment.endMs,
    locale: segment.locale,
    identity: { ...segment.identity },
    audioArtifactId: segment.audioArtifactId,
    videoArtifactId: segment.videoArtifactId,
    alignmentArtifactId: segment.alignmentArtifactId,
    consentSnapshotHash: segment.consentSnapshotHash,
    criticReportHash: segment.criticReportHash,
  })
}

export interface SyntheticSpeechSegmentBlock {
  blockId: string
  exactText: string
  occurrence: number
}

/**
 * Deterministically catalogs the master's approved sentences as reusable
 * segments.
 *
 * Boundaries are the F3.005 block boundaries — never re-segmented here — and
 * ranges come from the consolidated alignment, matched word by word in order.
 * A block whose words are not present, in order, in the alignment fails closed:
 * an invented range would make a segment that does not correspond to the bytes.
 * Silence between sentences stays a real gap between half-open ranges; it is
 * never absorbed into a segment to make the timeline look contiguous.
 */
export function catalogSyntheticSpeechSegments(input: {
  master: Readonly<SyntheticMasterAsset>
  blocks: readonly Readonly<SyntheticSpeechSegmentBlock>[]
  words: readonly Readonly<SyntheticSpeechSegmentWord>[]
  identity: Readonly<SyntheticSpeechSegmentIdentity>
  createId: (block: Readonly<SyntheticSpeechSegmentBlock>, sequence: number) => string
}): readonly Readonly<SyntheticSpeechSegment>[] {
  assertDomain(input.blocks.length > 0, 'INVALID_ARGUMENT', 'A master with no approved blocks cannot be catalogued')
  assertDomain(input.words.length > 0, 'PERSISTENCE_CONFLICT', 'Master alignment carries no words')

  for (const [index, word] of input.words.entries()) {
    assertDomain(
      Number.isSafeInteger(word.startMs) && Number.isSafeInteger(word.endMs) && word.endMs > word.startMs,
      'PERSISTENCE_CONFLICT',
      'Master alignment word range is invalid',
    )
    if (index > 0) {
      assertDomain(
        word.startMs >= input.words[index - 1]!.endMs,
        'PERSISTENCE_CONFLICT',
        'Master alignment words overlap',
      )
    }
  }

  const audio = input.master.artifacts.find((artifact) => artifact.role === 'final-audio')!
  // `normalized-video` is optional on the master, so a segment points at the
  // normalized track when a normalization stage produced one and at the
  // provider's own video otherwise. This names the bytes the segment is cut
  // from; it never relabels provider bytes as normalized.
  const video = input.master.artifacts.find((artifact) => artifact.role === 'normalized-video')
    ?? input.master.artifacts.find((artifact) => artifact.role === 'provider-original')!
  const alignment = input.master.artifacts.find((artifact) => artifact.role === 'alignment')!

  const segments: Readonly<SyntheticSpeechSegment>[] = []
  let cursor = 0
  let previousEnd = 0
  for (const [sequence, block] of input.blocks.entries()) {
    const expected = normalizeSyntheticSpeechText(block.exactText).split(' ').filter(Boolean)
    assertDomain(expected.length > 0, 'INVALID_ARGUMENT', `Block ${block.blockId} has no speakable text`)
    const consumed: Readonly<SyntheticSpeechSegmentWord>[] = []
    for (const token of expected) {
      const word = input.words[cursor]
      assertDomain(
        Boolean(word) && normalizeSyntheticSpeechText(word!.word) === token,
        'PERSISTENCE_CONFLICT',
        `Master alignment does not match block ${block.blockId} word by word`,
      )
      consumed.push(word!)
      cursor += 1
    }
    const startMs = consumed[0]!.startMs
    const endMs = consumed.at(-1)!.endMs
    assertDomain(startMs >= previousEnd, 'PERSISTENCE_CONFLICT', 'Catalogued segments would overlap')
    assertDomain(
      endMs <= input.master.audioDurationMs,
      'PERSISTENCE_CONFLICT',
      'Catalogued segment runs past the master duration',
    )
    previousEnd = endMs

    const body: Omit<SyntheticSpeechSegment, 'segmentHash'> = {
      schemaVersion: SYNTHETIC_SPEECH_SEGMENT_SCHEMA_VERSION,
      id: input.createId(block, sequence),
      workspaceId: input.master.workspaceId,
      projectId: input.master.projectId,
      masterId: input.master.id,
      masterHash: input.master.masterHash,
      blockId: block.blockId,
      occurrence: block.occurrence,
      sequence,
      audioArtifactId: audio.artifactId,
      videoArtifactId: video.artifactId,
      alignmentArtifactId: alignment.artifactId,
      exactText: block.exactText.trim(),
      normalizedText: normalizeSyntheticSpeechText(block.exactText),
      scriptHash: createHash('sha256').update(block.exactText.trim(), 'utf8').digest('hex'),
      words: Object.freeze(consumed.map((word) => Object.freeze({ ...word }))),
      startMs,
      endMs,
      locale: input.master.locale,
      identity: Object.freeze({ ...input.identity }),
      consentSnapshotHash: input.master.consentSnapshotHash,
      rightsSnapshotId: input.master.rightsSnapshotId,
      criticReportId: input.master.critic.reportId,
      criticReportHash: input.master.critic.reportHash,
      createdAt: input.master.createdAt,
    }
    assertDomain(ID.test(body.id), 'INVALID_ARGUMENT', 'segment.id is invalid')
    segments.push(Object.freeze({ ...body, segmentHash: calculateSegmentHash(body) }))
  }

  assertDomain(
    cursor === input.words.length,
    'PERSISTENCE_CONFLICT',
    'Master alignment carries words no approved block claims',
  )
  return Object.freeze(segments)
}

export function assertSyntheticSpeechSegmentIntegrity(
  segment: Readonly<SyntheticSpeechSegment>,
): Readonly<SyntheticSpeechSegment> {
  const { segmentHash, ...body } = segment
  assertDomain(
    calculateSegmentHash(body) === segmentHash,
    'PERSISTENCE_CONFLICT',
    'synthetic speech segment hash does not match its stored content',
  )
  return segment
}
