import { randomUUID } from 'node:crypto'

import type { ArtifactSourceMaterializer } from '../../application/ports/media-ingest.ts'
import type { CaptureTrackPart } from '../../domain/capture-session.ts'
import { DomainError } from '../../domain/errors.ts'

interface ArtifactRow {
  readonly artifactKey: string
  readonly sha256: string
  readonly byteSize: bigint
}

interface ArtifactLookup {
  v2MediaArtifact: {
    findFirst(args: {
      where: { id: string; workspaceId: string }
      select: { artifactKey: true; sha256: true; byteSize: true }
    }): Promise<ArtifactRow | null>
  }
}

/**
 * Turn a capture track's file into a path a detector can open (F4.010).
 *
 * The chain is: the session names an artifact id, the artifact registry names
 * a key and a hash, and the materializer verifies the bytes against that hash
 * before handing back a path. Every link is checked, and the check that
 * matters most is the middle one — the session's recorded `ingestSha256`
 * against the registry's `sha256`.
 *
 * If those disagree, the file behind the artifact is not the file the session
 * was built from. That is not a mismatch to log and continue through: a
 * detector pointed at substituted bytes would report a marker that the actual
 * recording never contained, and every offset derived from it would be
 * confidently wrong. So it fails closed.
 *
 * The materializer's own verification is not redundant with that. It catches a
 * different failure — bytes corrupted or replaced in storage since the
 * registry row was written — and neither check subsumes the other.
 */
export class CaptureMediaResolver {
  private readonly client: ArtifactLookup
  private readonly materializer: ArtifactSourceMaterializer

  constructor(client: ArtifactLookup, materializer: ArtifactSourceMaterializer) {
    this.client = client
    this.materializer = materializer
  }

  async resolve(input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }): Promise<string> {
    const artifact = await this.client.v2MediaArtifact.findFirst({
      where: { id: input.part.evidence.ingestArtifactId, workspaceId: input.workspaceId },
      select: { artifactKey: true, sha256: true, byteSize: true },
    })
    if (!artifact) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        `Capture part ${input.part.partId} names artifact ${input.part.evidence.ingestArtifactId}, which does not exist`,
      )
    }
    if (artifact.sha256 !== input.part.evidence.ingestSha256) {
      throw new DomainError(
        'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
        `Capture part ${input.part.partId} was built from a different file than artifact ${input.part.evidence.ingestArtifactId} now holds`,
      )
    }
    const byteSize = Number(artifact.byteSize)
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new DomainError(
        'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
        `Artifact ${input.part.evidence.ingestArtifactId} has no usable byte size`,
      )
    }
    const materialized = await this.materializer.materialize({
      operationId: `marker-detect-${randomUUID()}`,
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      byteSize,
    })
    return materialized.path
  }
}
