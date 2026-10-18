import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { FaceWindowClaim, FaceWindowWorkerRepository } from '../../application/ports/face-window-worker.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { FACE0204_OUTPUT_BYTES, face0204OutputSha256 } from '../../domain/face-detector-output.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceWindowFrames } from '../../domain/face-evidence-policy.ts'
import {
  createFaceProducerEnvelopeV2, faceSampleMatchesRawOutput,
  type FaceProducerEnvelopeV2, type FaceProducerEnvelopeV2Input,
} from '../../domain/face-producer-envelope-v2.ts'
import { authenticateFaceEnvelope, type FaceProducerAuthentication } from '../../domain/face-producer-registry.ts'
import { evaluatePerceptionSourceAnalysisRights } from '../../domain/perception-source-rights.ts'
import { startPublicOperationAttempt } from '../../domain/public-operation.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { conflict, emitOperationTransition, PrismaFaceProducerEnvelopeRepository, sourceMap } from './face-producer-envelope-repository.ts'
import { lockProducerPublishOperation, lockProducerPublishProject, lockProducerPublishSource, producerPublishClock } from './producer-publish-fence.ts'
import { hydratePublicOperationRecord, OPERATION_INCLUDE } from './public-operation-repository.ts'

export const FACE_WINDOW_DETECTOR_PROFILE = 'openvino-face0204-v9' as const
const SCHEMA_VERSION = 'face-producer-envelope/v2' as const
const MAX_LIST = 200

/** An envelope read back from the store: the sealed content plus what the registry says about its producer today. */
export type StoredFaceWindowEnvelope = Readonly<{ envelope: FaceProducerEnvelopeV2; authentication: FaceProducerAuthentication }>

const ENVELOPE_KEYS = [
  'schemaVersion', 'authority', 'coverage', 'faceSafety', 'identity', 'timeMapHash', 'detectorConfigHash', 'envelopeHash',
  'id', 'workspaceId', 'projectId', 'projectVersionId', 'operationId', 'operationAttempt', 'operationFenceHash',
  'sourceArtifactId', 'sourceSha256', 'editPlanSnapshotId', 'editPlanSnapshotHash', 'timelineDurationFrames', 'timeMap',
  'timelineFps', 'sourceFps', 'sourceTimebase', 'sourceClock', 'sourcePtsStart', 'sourcePtsRounding', 'sourceWidth',
  'sourceHeight', 'sourceOrientation', 'window', 'policyId', 'policySha256', 'detectorConfig', 'producer', 'samplePolicy',
  'samples', 'gaps', 'createdAt',
].sort().join('|')

/** Rebuilds the envelope from stored JSON through the domain constructor; anything that does not round-trip is refused. */
function hydrateContent(contentJson: string, expectedHash: string): FaceProducerEnvelopeV2 {
  let parsed: unknown
  try { parsed = JSON.parse(contentJson) } catch { conflict('Stored face window envelope JSON is invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) conflict('Stored face window envelope is invalid')
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).sort().join('|') !== ENVELOPE_KEYS) conflict('Stored face window envelope fields are invalid')
  const { schemaVersion, authority, coverage, faceSafety, identity, timeMapHash, detectorConfigHash, envelopeHash, ...input } = record
  if (schemaVersion !== SCHEMA_VERSION || authority !== 'server-produced' || coverage !== 'sampled-only' ||
      faceSafety !== 'unknown' || identity !== 'not-performed' || typeof timeMapHash !== 'string' ||
      typeof detectorConfigHash !== 'string' || typeof envelopeHash !== 'string') {
    conflict('Stored face window envelope authority is invalid')
  }
  let rebuilt: FaceProducerEnvelopeV2
  try { rebuilt = createFaceProducerEnvelopeV2(input as FaceProducerEnvelopeV2Input) }
  catch { conflict('Stored face window envelope content is invalid') }
  if (rebuilt.timeMapHash !== timeMapHash || rebuilt.detectorConfigHash !== detectorConfigHash ||
      rebuilt.envelopeHash !== envelopeHash || rebuilt.envelopeHash !== expectedHash ||
      stableSerialize(rebuilt) !== stableSerialize(record)) {
    conflict('Stored face window envelope failed integrity validation')
  }
  return rebuilt
}

type RawOutputRow = Readonly<{ sampleIndex: number; timelineFrame: number; sha256: string; rawBytes: Uint8Array }>

/**
 * Every sample that claims a raw detector output must have exactly that output stored, hash-bound, and its boxes must
 * be re-derivable from it by the literal V9 decoder; samples without one must have none. The reverse also holds.
 */
function assertRawOutputs(envelope: FaceProducerEnvelopeV2, rows: readonly RawOutputRow[]) {
  const bySample = new Map(rows.map((row) => [row.sampleIndex, row] as const))
  if (bySample.size !== rows.length) conflict('Face window raw outputs repeat a sample')
  let expected = 0
  envelope.samples.forEach((sample, index) => {
    const row = bySample.get(index)
    if (sample.rawOutput === null) {
      if (row) conflict('Face window raw output exists for a sample that declares none')
      return
    }
    expected += 1
    if (!row || row.timelineFrame !== sample.timelineFrame || row.sha256 !== sample.rawOutput.sha256 ||
        row.rawBytes.byteLength !== FACE0204_OUTPUT_BYTES || face0204OutputSha256(row.rawBytes) !== row.sha256 ||
        !faceSampleMatchesRawOutput(sample, row.rawBytes)) {
      conflict('Face window raw output does not reproduce its sample')
    }
  })
  if (rows.length !== expected) conflict('Face window raw outputs do not match the samples')
}

function inputRawOutputs(envelope: FaceProducerEnvelopeV2, rawOutputs: readonly (Uint8Array | null)[]): RawOutputRow[] {
  if (rawOutputs.length !== envelope.samples.length) conflict('Face window raw outputs do not match the samples')
  const rows: RawOutputRow[] = []
  envelope.samples.forEach((sample, index) => {
    const raw = rawOutputs[index]
    if (raw === null || raw === undefined) return
    rows.push({ sampleIndex: index, timelineFrame: sample.timelineFrame, sha256: face0204OutputSha256(raw), rawBytes: raw })
  })
  return rows
}

function planTiming(plan: Record<string, unknown>) {
  if (!Number.isSafeInteger(plan.fps) || Number(plan.fps) < 1 || !Number.isSafeInteger(plan.durationFrames) ||
      Number(plan.durationFrames) < 1 || Number(plan.durationFrames) > 10_000_000) conflict('Producer edit plan timing is invalid')
  return { fps: Number(plan.fps), durationFrames: Number(plan.durationFrames) }
}

/**
 * Durable side of the V9 window profile: claim by profile, fenced publish and fenced read. The YuNet diagnostic keeps
 * its own repository; this class never claims, publishes or reads one of its operations, and the converse holds.
 * Lease bookkeeping (heartbeat, phases, failure) is the same fenced code for both and is delegated.
 */
export class PrismaFaceWindowEnvelopeRepository implements FaceWindowWorkerRepository {
  private readonly client: PrismaClient
  private readonly leases: PrismaFaceProducerEnvelopeRepository

  constructor(client: PrismaClient) {
    this.client = client
    this.leases = new PrismaFaceProducerEnvelopeRepository(client)
  }

  currentFenceHash(input: { operationId: string; attempt: number; leaseOwner: string; now: Date }) { return this.leases.currentFenceHash(input) }
  heartbeat(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; leaseMs: number }) { return this.leases.heartbeat(input) }
  advancePhase(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; phase: 'analyzing' | 'verifying' | 'persisting' }) {
    return this.leases.advancePhase(input)
  }
  failAttempt(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; errorCode: string; errorMessage: string; retryable: boolean }) {
    return this.leases.failAttempt(input)
  }

  async claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<FaceWindowClaim | null> {
    if (!input.leaseOwner.trim() || !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 10_000 || input.leaseMs > 300_000) {
      throw new DomainError('INVALID_ARGUMENT', 'Producer worker lease is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const candidates = await transaction.v2PublicOperation.findMany({
        where: { type: 'perception-face-run', faceProducerOperation: { is: { detectorProfile: FACE_WINDOW_DETECTOR_PROFILE } },
          OR: [{ status: 'queued' }, { status: 'retrying', nextAttemptAt: { lte: input.now } },
            { status: 'running', leaseExpiresAt: { lte: input.now } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: OPERATION_INCLUDE,
        take: 20,
      })
      for (const exhausted of candidates.filter((row) => row.status === 'running' && row.attempt >= row.maxAttempts)) {
        const terminal = await transaction.v2PublicOperation.updateMany({
          where: { id: exhausted.id, status: 'running', attempt: exhausted.attempt,
            leaseOwner: exhausted.leaseOwner, leaseExpiresAt: { lte: input.now } },
          data: { status: 'failed', phase: 'failed', cancelable: false, retryable: false,
            leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null,
            completedAt: input.now, deadLetteredAt: input.now,
            errorCode: 'worker_lease_expired', errorMessage: 'Operation exhausted its available attempts',
            errorRetryable: false, updatedAt: input.now },
        })
        if (terminal.count === 1) await emitOperationTransition(transaction, exhausted, exhausted.id)
      }
      const candidate = candidates.find((row) => row.attempt < row.maxAttempts && row.faceProducerOperation)
      const run = candidate?.faceProducerOperation
      if (!candidate || !run) return null
      const claimed = startPublicOperationAttempt(hydratePublicOperationRecord(candidate).operation, input.now.toISOString())
      const nextAttempt = claimed.attempt
      const updated = await transaction.v2PublicOperation.updateMany({
        where: { id: candidate.id, status: candidate.status, attempt: candidate.attempt,
          leaseOwner: candidate.leaseOwner, leaseExpiresAt: candidate.leaseExpiresAt },
        data: { status: claimed.status, phase: claimed.phase, attempt: claimed.attempt,
          progressCompleted: claimed.progress?.completed, progressTotal: claimed.progress?.total,
          progressUnit: claimed.progress?.unit, cancelable: claimed.cancelable, retryable: claimed.retryable,
          leaseOwner: input.leaseOwner, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          heartbeatAt: input.now, startedAt: new Date(claimed.startedAt as string),
          nextAttemptAt: null, completedAt: null, deadLetteredAt: null,
          errorCode: null, errorMessage: null, errorRetryable: null, resultJson: null,
          updatedAt: input.now },
      })
      if (updated.count !== 1) return null
      let source: NonNullable<Awaited<ReturnType<typeof transaction.v2MediaArtifact.findFirst>>>
      let timing: ReturnType<typeof planTiming>
      let timeMap: ReturnType<typeof sourceMap>
      let window: { startTimelineFrame: number; endTimelineFrame: number }
      try {
        await lockProducerPublishProject(transaction, run.projectId, candidate.workspaceId)
        await lockProducerPublishSource(transaction, run.sourceArtifactId, candidate.workspaceId)
        const foundSource = await transaction.v2MediaArtifact.findFirst({
          where: { id: run.sourceArtifactId, workspaceId: candidate.workspaceId, status: 'available', mediaType: 'video' },
          include: { currentRightsSnapshot: true },
        })
        if (!foundSource || foundSource.byteSize > BigInt(Number.MAX_SAFE_INTEGER) || foundSource.sha256 !== run.sourceSha256) {
          conflict('Producer source artifact is unavailable')
        }
        source = foundSource
        const project = await transaction.v2Project.findFirst({
          where: { id: run.projectId, workspaceId: candidate.workspaceId, currentVersionId: run.projectVersionId },
          select: { locale: true },
        })
        const attached = await transaction.v2ProjectMediaAsset.findFirst({
          where: { workspaceId: candidate.workspaceId, projectId: run.projectId, artifactId: source.id, role: 'source-master' },
          select: { id: true },
        })
        if (!project || !attached) conflict('Producer source is not current and attached')
        const rights = foundSource.currentRightsSnapshot ? hydrateAssetRights(foundSource.currentRightsSnapshot) : null
        const checkedAt = await producerPublishClock(transaction)
        if (new Date(input.now.getTime() + input.leaseMs) <= checkedAt) conflict('Producer lease expired during claim')
        if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: candidate.workspaceId,
          locale: project.locale ?? 'und' }, checkedAt).outcome !== 'allow') {
          throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are not approved')
        }
        const version = await transaction.v2ProjectVersion.findFirst({
          where: { id: run.projectVersionId, projectId: run.projectId, workspaceId: candidate.workspaceId },
          include: { editPlanSnapshot: true },
        })
        if (!version || version.editPlanSnapshot.kind !== 'edit-plan' || version.baseHash !== run.projectVersionHash ||
            version.editPlanSnapshotId !== run.editPlanSnapshotId ||
            version.editPlanSnapshot.contentHash !== run.editPlanSnapshotHash) {
          conflict('Producer operation source version is unavailable')
        }
        let plan: Record<string, unknown>
        try { plan = JSON.parse(version.editPlanSnapshot.contentJson) as Record<string, unknown> }
        catch { conflict('Producer edit plan JSON is invalid') }
        if (calculateCanonicalHash(plan) !== version.editPlanSnapshot.contentHash) conflict('Producer edit plan timing is invalid')
        timing = planTiming(plan)
        timeMap = sourceMap(version.editPlanSnapshot.contentJson, source.id)
        if (run.windowStartTimelineFrame === null || run.windowEndTimelineFrame === null) conflict('Face window operation has no window')
        window = { startTimelineFrame: run.windowStartTimelineFrame!, endTimelineFrame: run.windowEndTimelineFrame! }
        // One unit-rate clip that is the whole timeline; the window is the bounded part of it that is observed.
        if (timeMap.length !== 1 || timeMap[0]!.timelineInFrame !== 0 || timeMap[0]!.timelineOutFrame !== timing.durationFrames ||
            run.sampleIntervalFrames < 1 || run.sampleIntervalFrames > 300 ||
            window.endTimelineFrame > timing.durationFrames ||
            window.endTimelineFrame - window.startTimelineFrame > faceWindowFrames(run.sampleIntervalFrames)) {
          conflict('Producer source does not cover the current timeline as one ordered source')
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        const terminal = await transaction.v2PublicOperation.updateMany({
          where: { id: candidate.id, status: 'running', attempt: nextAttempt, leaseOwner: input.leaseOwner },
          data: { status: 'failed', phase: 'failed', cancelable: false, retryable: false,
            leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null,
            completedAt: input.now, deadLetteredAt: null, errorCode: 'invalid_producer_context',
            errorMessage: 'Producer input context is invalid', errorRetryable: false, updatedAt: input.now },
        })
        if (terminal.count === 1) await emitOperationTransition(transaction, candidate, candidate.id)
        return null
      }
      await emitOperationTransition(transaction, candidate, candidate.id)
      return Object.freeze({ operationId: candidate.id, workspaceId: candidate.workspaceId,
        projectId: run.projectId, projectVersionId: run.projectVersionId,
        sourceArtifactId: source.id, sourceSha256: source.sha256, artifactKey: source.artifactKey,
        sourceByteSize: Number(source.byteSize),
        editPlanSnapshotId: run.editPlanSnapshotId, editPlanSnapshotHash: run.editPlanSnapshotHash,
        timeMap, timelineDurationFrames: timing.durationFrames,
        timelineFps: Object.freeze({ num: timing.fps, den: 1 }),
        window: Object.freeze(window), sampleIntervalFrames: run.sampleIntervalFrames, attempt: nextAttempt,
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  /**
   * Seals the window envelope and its raw detector outputs in the same transaction that completes the operation.
   * Refused: a producer the registry does not authenticate, raw outputs that do not reproduce their samples, a lost or
   * expired lease, a changed version, source or rights, or a request context that differs from the sealed result.
   */
  async publish(input: { envelope: FaceProducerEnvelopeV2; rawOutputs: readonly (Uint8Array | null)[]; leaseOwner: string; now: Date }) {
    const envelope = hydrateContent(stableSerialize(input.envelope), input.envelope.envelopeHash)
    if (!authenticateFaceEnvelope(envelope).authenticated) conflict('Face producer is not an accepted producer on a parity-proven platform')
    const rawRows = inputRawOutputs(envelope, input.rawOutputs)
    assertRawOutputs(envelope, rawRows)
    const { leaseOwner } = input
    return this.client.$transaction(async (transaction) => {
      await lockProducerPublishOperation(transaction, envelope.operationId, envelope.workspaceId)
      const lockedAt = await producerPublishClock(transaction)
      const operation = await transaction.v2PublicOperation.findUnique({ where: { id: envelope.operationId }, include: OPERATION_INCLUDE })
      if (!operation || operation.workspaceId !== envelope.workspaceId || operation.projectId !== envelope.projectId ||
          operation.type !== 'perception-face-run' || operation.targetType !== 'project-version' ||
          operation.targetId !== envelope.projectVersionId || operation.status !== 'running' || operation.phase !== 'persisting' ||
          operation.attempt !== envelope.operationAttempt || operation.leaseOwner !== leaseOwner ||
          !operation.leaseExpiresAt || operation.leaseExpiresAt <= lockedAt) {
        conflict('Producer operation is not held by the current fenced attempt')
      }
      const expectedFenceHash = calculateCanonicalHash({ operationId: operation.id, attempt: operation.attempt, leaseOwner })
      if (envelope.operationFenceHash !== expectedFenceHash) conflict('Producer operation fence differs')
      const run = await transaction.v2FaceProducerOperation.findUnique({ where: { operationId: operation.id } })
      if (!run || run.detectorProfile !== FACE_WINDOW_DETECTOR_PROFILE || run.workspaceId !== envelope.workspaceId ||
          run.projectId !== envelope.projectId || run.projectVersionId !== envelope.projectVersionId ||
          run.sourceArtifactId !== envelope.sourceArtifactId || run.sourceSha256 !== envelope.sourceSha256 ||
          run.editPlanSnapshotId !== envelope.editPlanSnapshotId || run.editPlanSnapshotHash !== envelope.editPlanSnapshotHash ||
          run.sampleIntervalFrames !== envelope.samplePolicy.intervalFrames ||
          envelope.samplePolicy.maxSamples !== FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow ||
          run.windowStartTimelineFrame !== envelope.window.startTimelineFrame ||
          run.windowEndTimelineFrame !== envelope.window.endTimelineFrame ||
          envelope.policySha256 !== FACE_EVIDENCE_POLICY_SHA256 ||
          run.requestHash !== operation.requestFingerprint) {
        conflict('Producer request context differs from the sealed result')
      }
      await lockProducerPublishProject(transaction, envelope.projectId, envelope.workspaceId)
      const project = await transaction.v2Project.findFirst({
        where: { id: envelope.projectId, workspaceId: envelope.workspaceId },
        select: { currentVersionId: true, locale: true },
      })
      const version = await transaction.v2ProjectVersion.findFirst({
        where: { id: envelope.projectVersionId, projectId: envelope.projectId, workspaceId: envelope.workspaceId },
        include: { editPlanSnapshot: true },
      })
      if (!project || project.currentVersionId !== envelope.projectVersionId || !version ||
          version.baseHash !== run.projectVersionHash || version.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
          version.editPlanSnapshot.contentHash !== envelope.editPlanSnapshotHash) {
        conflict('Producer input version or source-to-timeline map changed')
      }
      let plan: Record<string, unknown>
      try { plan = JSON.parse(version.editPlanSnapshot.contentJson) as Record<string, unknown> }
      catch { conflict('Producer edit plan JSON is invalid') }
      const timing = planTiming(plan)
      if (calculateCanonicalHash(plan) !== envelope.editPlanSnapshotHash ||
          calculateCanonicalHash(sourceMap(version.editPlanSnapshot.contentJson, envelope.sourceArtifactId)) !== envelope.timeMapHash ||
          timing.durationFrames !== envelope.timelineDurationFrames || timing.fps !== envelope.timelineFps.num ||
          envelope.timelineFps.den !== 1) {
        conflict('Producer input version or source-to-timeline map changed')
      }
      await lockProducerPublishSource(transaction, envelope.sourceArtifactId, envelope.workspaceId)
      const artifact = await transaction.v2MediaArtifact.findFirst({
        where: { id: envelope.sourceArtifactId, workspaceId: envelope.workspaceId },
        include: { currentRightsSnapshot: true },
      })
      const attached = await transaction.v2ProjectMediaAsset.findFirst({
        where: { workspaceId: envelope.workspaceId, projectId: envelope.projectId,
          artifactId: envelope.sourceArtifactId, role: 'source-master' },
        select: { id: true },
      })
      if (!artifact || !attached || artifact.sha256 !== envelope.sourceSha256 ||
          artifact.status !== 'available' || artifact.mediaType !== 'video') {
        conflict('Producer source artifact is unavailable or changed')
      }
      const rights = artifact.currentRightsSnapshot ? hydrateAssetRights(artifact.currentRightsSnapshot) : null
      const committedAt = await producerPublishClock(transaction)
      if (operation.leaseExpiresAt <= committedAt) conflict('Producer lease expired before publication')
      if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: envelope.workspaceId, locale: project.locale ?? 'und' }, committedAt).outcome !== 'allow') {
        throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are not approved')
      }
      const updated = await transaction.v2PublicOperation.updateMany({
        where: { id: operation.id, workspaceId: envelope.workspaceId, status: 'running', phase: 'persisting',
          attempt: envelope.operationAttempt, leaseOwner,
          leaseExpiresAt: { equals: operation.leaseExpiresAt, gt: committedAt } },
        data: { status: 'succeeded', phase: 'completed', completedAt: committedAt, updatedAt: committedAt,
          cancelable: false, retryable: false, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null,
          errorCode: null, errorMessage: null, errorRetryable: null,
          progressCompleted: 4, progressTotal: 4, progressUnit: 'stage',
          resultJson: stableSerialize({ resource: { type: 'project-version', id: envelope.projectVersionId } }) },
      })
      if (updated.count !== 1) conflict('Producer operation fence was lost at commit')
      await transaction.v2FaceProducerEnvelope.create({ data: {
        id: envelope.id, workspaceId: envelope.workspaceId, projectId: envelope.projectId,
        projectVersionId: envelope.projectVersionId, operationId: envelope.operationId,
        operationAttempt: envelope.operationAttempt, operationFenceHash: expectedFenceHash,
        sourceArtifactId: envelope.sourceArtifactId, sourceSha256: envelope.sourceSha256,
        editPlanSnapshotId: envelope.editPlanSnapshotId, editPlanSnapshotHash: envelope.editPlanSnapshotHash,
        timeMapHash: envelope.timeMapHash, detectorConfigHash: envelope.detectorConfigHash,
        contentJson: stableSerialize(envelope), envelopeHash: envelope.envelopeHash,
        schemaVersion: SCHEMA_VERSION,
        windowStartTimelineFrame: envelope.window.startTimelineFrame, windowEndTimelineFrame: envelope.window.endTimelineFrame,
        createdAt: new Date(envelope.createdAt),
      } })
      if (rawRows.length) {
        await transaction.v2FaceProducerRawOutput.createMany({ data: rawRows.map((row) => ({
          id: `face-raw-${calculateCanonicalHash({ envelopeId: envelope.id, sampleIndex: row.sampleIndex })}`,
          workspaceId: envelope.workspaceId, envelopeId: envelope.id, sampleIndex: row.sampleIndex,
          timelineFrame: row.timelineFrame, sha256: row.sha256, rawBytes: Buffer.from(row.rawBytes),
          createdAt: new Date(envelope.createdAt),
        })) })
      }
      await emitOperationTransition(transaction, operation, operation.id)
      const returnedAt = await producerPublishClock(transaction)
      if (operation.leaseExpiresAt <= returnedAt) conflict('Producer lease expired during publication')
      if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: envelope.workspaceId, locale: project.locale ?? 'und' }, returnedAt).outcome !== 'allow') {
        throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights expired during publication')
      }
      return envelope
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  read(input: { id: string; workspaceId: string; projectId: string; inputVersionId: string; now: Date }) {
    return readFaceWindowEnvelope(this.client, input)
  }

  /**
   * Verified envelopes of one version and source whose window overlaps [from, to), oldest window first. Several
   * envelopes may cover the same window (a re-run); deciding between them is the evidence stream's job, not this one's.
   */
  async listWindows(input: { workspaceId: string; projectId: string; projectVersionId: string; sourceArtifactId: string
    fromTimelineFrame: number; toTimelineFrame: number; now: Date; limit?: number }): Promise<readonly StoredFaceWindowEnvelope[]> {
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST || !Number.isSafeInteger(input.fromTimelineFrame) ||
        !Number.isSafeInteger(input.toTimelineFrame) || input.fromTimelineFrame < 0 || input.toTimelineFrame <= input.fromTimelineFrame) {
      throw new DomainError('INVALID_ARGUMENT', 'Face window listing range is invalid')
    }
    const rows = await this.client.v2FaceProducerEnvelope.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId,
        sourceArtifactId: input.sourceArtifactId, schemaVersion: SCHEMA_VERSION,
        windowStartTimelineFrame: { lt: input.toTimelineFrame }, windowEndTimelineFrame: { gt: input.fromTimelineFrame } },
      orderBy: [{ windowStartTimelineFrame: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true }, take: limit,
    })
    const result: StoredFaceWindowEnvelope[] = []
    for (const row of rows) {
      const stored = await readFaceWindowEnvelope(this.client, { id: row.id, workspaceId: input.workspaceId,
        projectId: input.projectId, inputVersionId: input.projectVersionId, now: input.now })
      if (stored) result.push(stored)
    }
    return Object.freeze(result)
  }
}

/** Fenced read of one stored window; the registry verdict is recomputed now, so a later change in trust is visible. */
export async function readFaceWindowEnvelope(client: Prisma.TransactionClient, input: {
  id: string; workspaceId: string; projectId: string; inputVersionId: string; now: Date
}): Promise<StoredFaceWindowEnvelope | null> {
  const row = await client.v2FaceProducerEnvelope.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.inputVersionId },
    include: { operation: { include: { faceProducerOperation: true } },
      sourceArtifact: { include: { currentRightsSnapshot: true } },
      projectVersion: { include: { editPlanSnapshot: true, project: true } },
      rawOutputs: { orderBy: { sampleIndex: 'asc' } } },
  })
  if (!row) return null
  if (row.schemaVersion !== SCHEMA_VERSION) conflict('Stored face envelope is not a window envelope')
  const envelope = hydrateContent(row.contentJson, row.envelopeHash)
  if (row.workspaceId !== envelope.workspaceId || row.projectId !== envelope.projectId ||
      row.projectVersionId !== envelope.projectVersionId || row.operationId !== envelope.operationId ||
      row.operationAttempt !== envelope.operationAttempt || row.operationFenceHash !== envelope.operationFenceHash ||
      row.sourceArtifactId !== envelope.sourceArtifactId || row.sourceSha256 !== envelope.sourceSha256 ||
      row.editPlanSnapshotId !== envelope.editPlanSnapshotId || row.editPlanSnapshotHash !== envelope.editPlanSnapshotHash ||
      row.timeMapHash !== envelope.timeMapHash || row.detectorConfigHash !== envelope.detectorConfigHash ||
      row.windowStartTimelineFrame !== envelope.window.startTimelineFrame ||
      row.windowEndTimelineFrame !== envelope.window.endTimelineFrame ||
      row.createdAt.toISOString() !== envelope.createdAt) conflict('Producer envelope columns differ from sealed content')
  assertRawOutputs(envelope, row.rawOutputs.map((raw) => ({ sampleIndex: raw.sampleIndex, timelineFrame: raw.timelineFrame,
    sha256: raw.sha256, rawBytes: new Uint8Array(raw.rawBytes) })))
  let result: Record<string, unknown>
  try { result = JSON.parse(row.operation.resultJson ?? '') as Record<string, unknown> }
  catch { conflict('Producer operation result is invalid') }
  const run = row.operation.faceProducerOperation
  if (!run || run.detectorProfile !== FACE_WINDOW_DETECTOR_PROFILE || run.workspaceId !== envelope.workspaceId ||
      run.projectId !== envelope.projectId || run.projectVersionId !== envelope.projectVersionId ||
      run.projectVersionHash !== row.projectVersion.baseHash || run.sourceArtifactId !== envelope.sourceArtifactId ||
      run.sourceSha256 !== envelope.sourceSha256 || run.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
      run.editPlanSnapshotHash !== envelope.editPlanSnapshotHash || run.sampleIntervalFrames !== envelope.samplePolicy.intervalFrames ||
      envelope.samplePolicy.maxSamples !== FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow ||
      run.windowStartTimelineFrame !== envelope.window.startTimelineFrame ||
      run.windowEndTimelineFrame !== envelope.window.endTimelineFrame ||
      run.requestHash !== row.operation.requestFingerprint ||
      Object.keys(result).sort().join('|') !== 'resource' ||
      !result.resource || typeof result.resource !== 'object' ||
      Object.keys(result.resource).sort().join('|') !== 'id|type' ||
      (result.resource as Record<string, unknown>).type !== 'project-version' ||
      (result.resource as Record<string, unknown>).id !== envelope.projectVersionId ||
      row.operation.workspaceId !== envelope.workspaceId || row.operation.projectId !== envelope.projectId ||
      row.operation.targetType !== 'project-version' || row.operation.targetId !== envelope.projectVersionId ||
      row.operation.status !== 'succeeded' || row.operation.phase !== 'completed' ||
      row.operation.type !== 'perception-face-run' || row.operation.attempt !== envelope.operationAttempt ||
      row.operation.progressCompleted !== 4 || row.operation.progressTotal !== 4 || row.operation.progressUnit !== 'stage') {
    conflict('Producer operation did not publish this fenced envelope')
  }
  const version = row.projectVersion
  const attached = await client.v2ProjectMediaAsset.findFirst({
    where: { workspaceId: envelope.workspaceId, projectId: envelope.projectId,
      artifactId: envelope.sourceArtifactId, role: 'source-master' }, select: { id: true },
  })
  let plan: Record<string, unknown>
  try { plan = JSON.parse(version.editPlanSnapshot.contentJson) as Record<string, unknown> }
  catch { conflict('Stored edit plan JSON is invalid') }
  const timing = planTiming(plan)
  if (version.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
      version.editPlanSnapshot.contentHash !== envelope.editPlanSnapshotHash ||
      calculateCanonicalHash(plan) !== envelope.editPlanSnapshotHash ||
      calculateCanonicalHash(sourceMap(version.editPlanSnapshot.contentJson, envelope.sourceArtifactId)) !== envelope.timeMapHash ||
      timing.durationFrames !== envelope.timelineDurationFrames || timing.fps !== envelope.timelineFps.num ||
      !attached || row.sourceArtifact.sha256 !== envelope.sourceSha256 ||
      row.sourceArtifact.status !== 'available' || row.sourceArtifact.mediaType !== 'video') {
    conflict('Producer source or time-map no longer matches the sealed input')
  }
  const rights = row.sourceArtifact.currentRightsSnapshot ? hydrateAssetRights(row.sourceArtifact.currentRightsSnapshot) : null
  const checkedAt = await producerPublishClock(client)
  if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: input.workspaceId,
    locale: version.project.locale ?? 'und' }, checkedAt).outcome !== 'allow') {
    throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are no longer approved')
  }
  return Object.freeze({ envelope, authentication: authenticateFaceEnvelope(envelope) })
}

// The pure halves of the persistence contract, exported so they can be proven without a database.
export { hydrateContent as hydrateFaceWindowEnvelopeContent, assertRawOutputs as assertFaceWindowRawOutputs,
  inputRawOutputs as faceWindowRawOutputRows }
