import type { MasterAlignmentReader } from '../../application/synthetic-speech-segments.ts'
import type { ArtifactContentStorage } from '../../application/ports/artifact-content-storage.ts'
import type { MediaArtifactQueryRepository } from '../../application/ports/media-artifact-query-repository.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import type { SyntheticSpeechSegmentWord } from '../../domain/synthetic-speech-segment.ts'

interface StoredTtsAlignment {
  schemaVersion?: string
  characters?: readonly string[]
  startTimesSeconds?: readonly number[]
  endTimesSeconds?: readonly number[]
}

/**
 * Reads the consolidated word timing from the master's persisted alignment
 * artifact.
 *
 * The bytes are opened content-addressed — storage verifies the checksum and
 * byte size before yielding them — so an alignment that drifted from its
 * manifest cannot produce segment ranges. Character timings are folded into
 * words exactly like the block compilation does, keeping one interpretation of
 * provider alignment in the system.
 */
export class StoredSyntheticMasterAlignmentReader implements MasterAlignmentReader {
  private readonly artifacts: MediaArtifactQueryRepository
  private readonly storage: ArtifactContentStorage

  constructor(dependencies: { artifacts: MediaArtifactQueryRepository; storage: ArtifactContentStorage }) {
    this.artifacts = dependencies.artifacts
    this.storage = dependencies.storage
  }

  async readWords(input: { workspaceId: string; artifactId: string }): Promise<readonly Readonly<SyntheticSpeechSegmentWord>[]> {
    const artifact = await this.artifacts.findById(input.workspaceId, input.artifactId)
    assertDomain(Boolean(artifact), 'ASSET_NOT_FOUND', 'Master alignment artifact is missing from the catalog')

    const opened = await this.storage.open({
      artifactKey: artifact!.artifactKey,
      expectedByteSize: artifact!.byteSize,
      expectedSha256: artifact!.sha256,
    })
    const chunks: Uint8Array[] = []
    const reader = opened.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    let alignment: StoredTtsAlignment
    try {
      alignment = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StoredTtsAlignment
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored master alignment is not valid JSON')
    }

    const characters = alignment.characters ?? []
    const startTimes = alignment.startTimesSeconds ?? []
    const endTimes = alignment.endTimesSeconds ?? []
    assertDomain(
      characters.length > 0 && startTimes.length === characters.length && endTimes.length === characters.length,
      'PERSISTENCE_CONFLICT',
      'Stored master alignment is malformed',
    )

    const words: SyntheticSpeechSegmentWord[] = []
    let current: { text: string; startSeconds: number; endSeconds: number } | null = null
    for (const [index, character] of characters.entries()) {
      if (/\s/.test(character)) {
        if (current) {
          words.push({
            word: current.text,
            startMs: Math.round(current.startSeconds * 1_000),
            endMs: Math.round(current.endSeconds * 1_000),
          })
          current = null
        }
        continue
      }
      if (!current) current = { text: character, startSeconds: startTimes[index]!, endSeconds: endTimes[index]! }
      else {
        current.text += character
        current.endSeconds = endTimes[index]!
      }
    }
    if (current) {
      words.push({
        word: current.text,
        startMs: Math.round(current.startSeconds * 1_000),
        endMs: Math.round(current.endSeconds * 1_000),
      })
    }
    assertDomain(words.length > 0, 'PERSISTENCE_CONFLICT', 'Stored master alignment carries no words')
    return Object.freeze(words.map((word) => Object.freeze(word)))
  }
}
