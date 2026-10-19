import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { ServerPerceptionEvidenceReader } from '../../application/ports/server-perception-snapshot-repository.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  collectFaceWindowsOfSources, FACE_WINDOW_LIMIT_EXCEEDED, FACE_WINDOW_PAGE_SIZE, FACE_WINDOW_SNAPSHOT_CAP,
} from '../../domain/face-window-paging.ts'
import type { FaceProducerEnvelopeV3 } from '../../domain/face-producer-envelope-v3.ts'
import type { PerceptionProducerEnvelope } from '../../domain/perception-producer-envelope.ts'
import type {
  PerceptionSnapshotClip, PerceptionSnapshotWord, ServerPerceptionAssemblyInput,
} from '../../domain/server-perception-snapshot.ts'
import type { TemporalProducerEnvelope } from '../../domain/temporal-producer-envelope.ts'
import { PrismaFaceSourceWindowRepository } from './face-source-window-repository.ts'
import { readPerceptionProducerEnvelope } from './perception-producer-envelope-repository.ts'
import { readTemporalProducerEnvelope } from './temporal-producer-envelope-repository.ts'

function conflict(message: string): never { throw new DomainError('PERSISTENCE_CONFLICT', message) }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const frame = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** The clips of a stored EditPlan, whatever track plays them; anything malformed is a conflict, never a guess. */
function planClips(plan: Record<string, unknown>): readonly PerceptionSnapshotClip[] {
  if (!Array.isArray(plan.videoTracks)) conflict('Stored edit plan has no video tracks')
  return (plan.videoTracks as unknown[]).flatMap((track) => {
    if (!isRecord(track) || !Array.isArray(track.clips)) conflict('Stored edit plan track is invalid')
    return (track as { clips: unknown[] }).clips.map((clip) => {
      if (!isRecord(clip) || typeof clip.id !== 'string' || typeof clip.sourceArtifactId !== 'string' ||
          ![clip.sourceInFrame, clip.sourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame].every(frame) ||
          typeof clip.rate !== 'number' || !Number.isFinite(clip.rate)) conflict('Stored edit plan clip is invalid')
      const item = clip as Record<string, unknown>
      return Object.freeze({ id: item.id as string, sourceArtifactId: item.sourceArtifactId as string,
        sourceInFrame: item.sourceInFrame as number, sourceOutFrame: item.sourceOutFrame as number,
        timelineInFrame: item.timelineInFrame as number, timelineOutFrame: item.timelineOutFrame as number, rate: item.rate as number })
    })
  })
}

function retimedWords(plan: Record<string, unknown>) {
  const retimed = plan.retimedTranscript
  if (!isRecord(retimed) || !Array.isArray(retimed.words) || retimed.words.length === 0) return null
  const words = retimed.words.map((word): PerceptionSnapshotWord => {
    if (!isRecord(word) || typeof word.text !== 'string' ||
        ![word.sourceStartSeconds, word.sourceEndSeconds].every((value) => typeof value === 'number' && Number.isFinite(value)) ||
        !frame(word.timelineStartFrame) || !frame(word.timelineEndFrame)) conflict('Stored retimed transcript word is invalid')
    const item = word as Record<string, unknown>
    return Object.freeze({ text: item.text as string, sourceStartSeconds: item.sourceStartSeconds as number,
      sourceEndSeconds: item.sourceEndSeconds as number, timelineStartFrame: item.timelineStartFrame as number,
      timelineEndFrame: item.timelineEndFrame as number })
  })
  if (typeof retimed.sourceTranscriptId !== 'string') conflict('Stored retimed transcript names no transcript')
  return { transcriptId: retimed.sourceTranscriptId as string,
    transcriptHash: typeof retimed.sourceTranscriptHash === 'string' ? retimed.sourceTranscriptHash : null, words }
}

/**
 * Reads the sealed evidence a ProjectVersion's perception snapshot is made of (W63a). Everything goes through the producers' own
 * fenced readers, which rebuild each envelope through its domain constructor, check its columns and publishing operation, check
 * the source bytes and the consuming project's attachment, and re-evaluate the source's rights at `now`. A reader that refuses
 * (tampered row, other bytes, revoked rights) makes this read refuse: the evidence is never returned half-trusted.
 *
 * Selection is by scope, not by trust: only rows of THIS workspace, project and version (OCR, temporal) or of THIS workspace and
 * source (face windows, shared by every project that has the source attached) are looked at; the newest sealed OCR and temporal
 * envelope of each source is the one used, like the Director's own.
 *
 * ALL the face windows that overlap what a source plays are read, page by page (keyset); a source with more windows than the
 * snapshot has left of its budget (FACE_WINDOW_SNAPSHOT_CAP over all the sources, spent in source-id order) is refused with
 * FACE_WINDOW_LIMIT_EXCEEDED and contributes none: a partial list is never trusted, and a long source never loses evidence (or the
 * contradiction between two windows) silently.
 */
export class PrismaServerPerceptionEvidenceReader implements ServerPerceptionEvidenceReader {
  private readonly client: PrismaClient
  private readonly faceWindowCap: number
  private readonly faceWindowPageSize: number
  constructor(client: PrismaClient, options: Readonly<{ faceWindowCap?: number; faceWindowPageSize?: number }> = {}) {
    this.client = client
    this.faceWindowCap = options.faceWindowCap ?? FACE_WINDOW_SNAPSHOT_CAP
    this.faceWindowPageSize = options.faceWindowPageSize ?? FACE_WINDOW_PAGE_SIZE
  }

  async readForVersion(input: { workspaceId: string; projectId: string; projectVersionId: string | null; now: Date }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true, currentVersionId: true },
    })
    if (!project) return null
    const versionId = input.projectVersionId ?? project.currentVersionId
    if (!versionId) return null
    const version = await this.client.v2ProjectVersion.findFirst({
      where: { id: versionId, projectId: input.projectId, workspaceId: input.workspaceId },
      include: { editPlanSnapshot: true },
    })
    if (!version) return null
    let plan: unknown
    try { plan = JSON.parse(version.editPlanSnapshot.contentJson) } catch { return conflict('Stored edit plan JSON is invalid') }
    if (!isRecord(plan)) return conflict('Stored edit plan is invalid')
    if (calculateCanonicalHash(plan) !== version.editPlanSnapshot.contentHash) conflict('Stored edit plan failed integrity validation')
    const clips = planClips(plan)
    const fps = plan.fps, durationFrames = plan.durationFrames
    if (clips.length === 0 || durationFrames === 0) return 'no-timeline' as const
    if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || !frame(durationFrames) || (durationFrames as number) <= 0) {
      return conflict('Stored edit plan clock is invalid')
    }
    const sourceIds = [...new Set(clips.map((clip) => clip.sourceArtifactId))].sort()
    const artifacts = await this.client.v2MediaArtifact.findMany({
      where: { workspaceId: input.workspaceId, id: { in: sourceIds } }, select: { id: true, sha256: true },
    })
    if (artifacts.length !== sourceIds.length) conflict('A source the timeline plays is not in this workspace')

    const ocr: PerceptionProducerEnvelope[] = []
    const temporal: TemporalProducerEnvelope[] = []
    const faceWindows: FaceProducerEnvelopeV3[] = []
    const faceWindowRefusals: { sourceArtifactId: string; reasonCode: typeof FACE_WINDOW_LIMIT_EXCEEDED }[] = []
    const faceReader = new PrismaFaceSourceWindowRepository(this.client)
    for (const sourceArtifactId of sourceIds) {
      const latestOcr = await this.client.v2PerceptionProducerEnvelope.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: version.id, sourceArtifactId, modality: 'ocr' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
      })
      if (latestOcr) {
        const envelope = await readPerceptionProducerEnvelope(this.client, { id: latestOcr.id,
          workspaceId: input.workspaceId, projectId: input.projectId, inputVersionId: version.id, now: input.now })
        if (!envelope) conflict('Selected OCR envelope disappeared')
        ocr.push(envelope as PerceptionProducerEnvelope)
      }
      const latestTemporal = await this.client.v2TemporalProducerEnvelope.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: version.id, sourceArtifactId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
      })
      if (latestTemporal) {
        const envelope = await readTemporalProducerEnvelope(this.client, { id: latestTemporal.id,
          workspaceId: input.workspaceId, projectId: input.projectId, inputVersionId: version.id, now: input.now })
        if (!envelope) conflict('Selected temporal envelope disappeared')
        temporal.push(envelope as TemporalProducerEnvelope)
      }
    }
    // The face windows of every source, against one budget for the whole snapshot (see FACE_WINDOW_SNAPSHOT_CAP).
    const rangeOf = (sourceArtifactId: string) => {
      const sourceClips = clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
      return { workspaceId: input.workspaceId, projectId: input.projectId, sourceArtifactId,
        fromSourceFrame: Math.min(...sourceClips.map((clip) => clip.sourceInFrame)),
        toSourceFrame: Math.max(...sourceClips.map((clip) => clip.sourceOutFrame)) }
    }
    const reads = await collectFaceWindowsOfSources({ sourceArtifactIds: sourceIds, cap: this.faceWindowCap, pageSize: this.faceWindowPageSize,
      count: (sourceArtifactId) => faceReader.countSourceWindows(rangeOf(sourceArtifactId)),
      page: (sourceArtifactId, after, limit) => faceReader.pageSourceWindows({ ...rangeOf(sourceArtifactId), now: input.now, after, limit }) })
    for (const read of reads) {
      if (read.status === 'over-cap') faceWindowRefusals.push({ sourceArtifactId: read.sourceArtifactId, reasonCode: read.reasonCode })
      else faceWindows.push(...read.items.map((item) => item.envelope))
    }

    const words = retimedWords(plan)
    let transcript: ServerPerceptionAssemblyInput['transcript']
    if (words) {
      // A cut copy owns no transcript row of its own; the id sealed in this immutable EditPlan names the original producer's.
      const row = await this.client.v2MediaTranscript.findFirst({
        where: { id: words.transcriptId, workspaceId: input.workspaceId },
        select: { id: true, sourceArtifactId: true, provider: true, model: true, transcriptHash: true },
      })
      if (row && words.transcriptHash !== null && words.transcriptHash !== row.transcriptHash) {
        conflict('The transcript row differs from the one the EditPlan was retimed from')
      }
      // A transcript no row of this workspace holds is not hidden: its words are still the sealed EditPlan's own. They are bound to
      // that snapshot instead (its hash is the envelope hash) and the producer says it could not be resolved, never a guess.
      transcript = row
        ? { transcript: Object.freeze({ id: row.id, provider: row.provider, model: row.model,
            transcriptHash: row.transcriptHash, sourceArtifactId: row.sourceArtifactId }), words: words.words }
        : { transcript: Object.freeze({ id: words.transcriptId, provider: 'unresolved', model: 'unresolved-transcript',
            transcriptHash: words.transcriptHash ?? version.editPlanSnapshot.contentHash,
            // The only source the timeline plays, when there is only one; otherwise the transcript's source is not known, and is not guessed.
            sourceArtifactId: sourceIds.length === 1 ? sourceIds[0]! : null }),
          words: words.words }
    }
    return Object.freeze({
      workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: version.id,
      editPlan: Object.freeze({ snapshotId: version.editPlanSnapshotId, snapshotHash: version.editPlanSnapshot.contentHash,
        fps: fps as number, durationFrames: durationFrames as number, clips }),
      sources: Object.freeze(artifacts.map((artifact) => Object.freeze({ artifactId: artifact.id, sha256: artifact.sha256 }))),
      ...(transcript ? { transcript } : {}), ocr, temporal, faceWindows,
      ...(faceWindowRefusals.length ? { faceWindowRefusals } : {}),
    }) as Readonly<ServerPerceptionAssemblyInput>
  }
}
