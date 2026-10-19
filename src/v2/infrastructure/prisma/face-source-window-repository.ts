import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { FaceSourceWindowClaim, FaceSourceWindowWorkerRepository } from '../../application/ports/face-source-window-worker.ts'
import type { FaceSourceWindowEvidenceReader, StoredFaceSourceWindow } from '../../application/ports/face-source-window-evidence-reader.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { FACE0204_OUTPUT_BYTES, face0204OutputSha256 } from '../../domain/face-detector-output.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceSampleIntervalFrames, faceWindowFrames } from '../../domain/face-evidence-policy.ts'
import { faceSampleMatchesRawOutput } from '../../domain/face-producer-envelope-v2.ts'
import { createFaceProducerEnvelopeV3, type FaceProducerEnvelopeV3, type FaceProducerEnvelopeV3Input } from '../../domain/face-producer-envelope-v3.ts'
import { authenticateFaceEnvelope } from '../../domain/face-producer-registry.ts'
import { evaluatePerceptionSourceAnalysisRights } from '../../domain/perception-source-rights.ts'
import { startPublicOperationAttempt } from '../../domain/public-operation.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { conflict, emitOperationTransition, PrismaFaceProducerEnvelopeRepository } from './face-producer-envelope-repository.ts'
import { lockProducerPublishOperation, lockProducerPublishProject, lockProducerPublishSource, producerPublishClock } from './producer-publish-fence.ts'
import { hydratePublicOperationRecord, OPERATION_INCLUDE } from './public-operation-repository.ts'

/**
 * Durable side of the V9 SOURCE window profile (W65b): claim by profile, fenced publish and fenced read, with the evidence keyed by the
 * source artifact's own frames. The envelope belongs to the SOURCE (artifact id and bytes hash); the operation that produced it - and
 * the project and Version it was requested from - is lineage, not identity. The reuse rule is therefore simple and strict:
 *
 * - a window is readable by any project of the workspace that has the source attached, under any Version, and by nobody else;
 * - at EVERY use the source's identity is re-verified (the artifact of this workspace still has the sealed bytes hash), the rights are
 *   re-evaluated NOW for the CONSUMING project's locale, the producer's standing in the registry is recomputed, and the stored row is
 *   re-proved against its sealed content, its raw detector outputs and the fenced operation that published it.
 */
export const FACE_SOURCE_WINDOW_DETECTOR_PROFILE = 'openvino-face0204-v9-source' as const
const SCHEMA_VERSION = 'face-producer-envelope/v3' as const
const MAX_LIST = 200

export type StoredFaceSourceWindowEnvelope = StoredFaceSourceWindow

const ENVELOPE_KEYS = [
  'schemaVersion', 'authority', 'coverage', 'faceSafety', 'identity', 'detectorConfigHash', 'envelopeHash',
  'id', 'workspaceId', 'operationId', 'operationAttempt', 'operationFenceHash', 'sourceArtifactId', 'sourceSha256',
  'sourceFps', 'sourceTimebase', 'sourceClock', 'sourcePtsStart', 'sourcePtsRounding', 'sourceWidth', 'sourceHeight',
  'sourceOrientation', 'window', 'policyId', 'policySha256', 'detectorConfig', 'producer', 'samplePolicy', 'samples', 'gaps', 'createdAt',
].sort().join('|')

/** Rebuilds the envelope from stored JSON through the domain constructor; anything that does not round-trip is refused. */
function hydrateContent(contentJson: string, expectedHash: string): FaceProducerEnvelopeV3 {
  let parsed: unknown
  try { parsed = JSON.parse(contentJson) } catch { conflict('Stored face source window envelope JSON is invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) conflict('Stored face source window envelope is invalid')
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).sort().join('|') !== ENVELOPE_KEYS) conflict('Stored face source window envelope fields are invalid')
  const { schemaVersion, authority, coverage, faceSafety, identity, detectorConfigHash, envelopeHash, ...input } = record
  if (schemaVersion !== SCHEMA_VERSION || authority !== 'server-produced' || coverage !== 'sampled-only' ||
      faceSafety !== 'unknown' || identity !== 'not-performed' || typeof detectorConfigHash !== 'string' || typeof envelopeHash !== 'string') {
    conflict('Stored face source window envelope authority is invalid')
  }
  let rebuilt: FaceProducerEnvelopeV3
  try { rebuilt = createFaceProducerEnvelopeV3(input as FaceProducerEnvelopeV3Input) }
  catch { conflict('Stored face source window envelope content is invalid') }
  if (rebuilt.detectorConfigHash !== detectorConfigHash || rebuilt.envelopeHash !== envelopeHash || rebuilt.envelopeHash !== expectedHash ||
      stableSerialize(rebuilt) !== stableSerialize(record)) {
    conflict('Stored face source window envelope failed integrity validation')
  }
  return rebuilt
}

type RawOutputRow = Readonly<{ sampleIndex: number; sourceFrame: number; sha256: string; rawBytes: Uint8Array }>

/**
 * Every sample that claims a raw detector output must have exactly that output stored, hash-bound, and its boxes must be re-derivable
 * from it by the literal V9 decoder; samples without one must have none. The reverse also holds.
 */
function assertRawOutputs(envelope: FaceProducerEnvelopeV3, rows: readonly RawOutputRow[]) {
  const bySample = new Map(rows.map((row) => [row.sampleIndex, row] as const))
  if (bySample.size !== rows.length) conflict('Face source window raw outputs repeat a sample')
  let expected = 0
  envelope.samples.forEach((sample, index) => {
    const row = bySample.get(index)
    if (sample.rawOutput === null) {
      if (row) conflict('Face source window raw output exists for a sample that declares none')
      return
    }
    expected += 1
    if (!row || row.sourceFrame !== sample.sourceFrame || row.sha256 !== sample.rawOutput.sha256 ||
        row.rawBytes.byteLength !== FACE0204_OUTPUT_BYTES || face0204OutputSha256(row.rawBytes) !== row.sha256 ||
        !faceSampleMatchesRawOutput(sample, row.rawBytes)) {
      conflict('Face source window raw output does not reproduce its sample')
    }
  })
  if (rows.length !== expected) conflict('Face source window raw outputs do not match the samples')
}

function inputRawOutputs(envelope: FaceProducerEnvelopeV3, rawOutputs: readonly (Uint8Array | null)[]): RawOutputRow[] {
  if (rawOutputs.length !== envelope.samples.length) conflict('Face source window raw outputs do not match the samples')
  const rows: RawOutputRow[] = []
  envelope.samples.forEach((sample, index) => {
    const raw = rawOutputs[index]
    if (raw === null || raw === undefined) return
    rows.push({ sampleIndex: index, sourceFrame: sample.sourceFrame, sha256: face0204OutputSha256(raw), rawBytes: raw })
  })
  return rows
}

/** The integer frame rate and frame count of a source from its manifest probe, or null when they cannot be established. */
function probeClock(manifestJson: string | undefined): Readonly<{ fps: number; durationFrames: number }> | null {
  if (!manifestJson) return null
  let manifest: unknown
  try { manifest = JSON.parse(manifestJson) } catch { return null }
  const probe = (manifest as { probe?: Record<string, unknown> } | null)?.probe
  if (!probe || typeof probe !== 'object') return null
  const fps = Number(probe.fps), duration = Number(probe.duration)
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 240 || !Number.isFinite(duration) || duration <= 0) return null
  const durationFrames = Math.round(duration * fps)
  return durationFrames >= 1 ? Object.freeze({ fps, durationFrames }) : null
}

export class PrismaFaceSourceWindowRepository implements FaceSourceWindowWorkerRepository, FaceSourceWindowEvidenceReader {
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

  async claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }): Promise<FaceSourceWindowClaim | null> {
    if (!input.leaseOwner.trim() || !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 10_000 || input.leaseMs > 300_000) {
      throw new DomainError('INVALID_ARGUMENT', 'Producer worker lease is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const candidates = await transaction.v2PublicOperation.findMany({
        where: { type: 'perception-face-run', faceProducerOperation: { is: { detectorProfile: FACE_SOURCE_WINDOW_DETECTOR_PROFILE } },
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
      let clock: NonNullable<ReturnType<typeof probeClock>>
      let window: { startSourceFrame: number; endSourceFrame: number }
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
        // The Version the window was requested under is not part of the evidence, so it need not be current - only the project and its source.
        const project = await transaction.v2Project.findFirst({
          where: { id: run.projectId, workspaceId: candidate.workspaceId }, select: { locale: true },
        })
        const attached = await transaction.v2ProjectMediaAsset.findFirst({
          where: { workspaceId: candidate.workspaceId, projectId: run.projectId, artifactId: source.id, role: 'source-master' },
          select: { id: true },
        })
        if (!project || !attached) conflict('Producer source is not attached to the requesting project')
        const rights = foundSource.currentRightsSnapshot ? hydrateAssetRights(foundSource.currentRightsSnapshot) : null
        const checkedAt = await producerPublishClock(transaction)
        if (new Date(input.now.getTime() + input.leaseMs) <= checkedAt) conflict('Producer lease expired during claim')
        if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: candidate.workspaceId,
          locale: project.locale ?? 'und' }, checkedAt).outcome !== 'allow') {
          throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are not approved')
        }
        const manifest = await transaction.v2MediaArtifactManifest.findFirst({
          where: { workspaceId: candidate.workspaceId, artifactId: source.id }, orderBy: { createdAt: 'asc' }, select: { manifestJson: true },
        })
        const measured = probeClock(manifest?.manifestJson)
        if (!measured) conflict('Producer source has no integer frame rate in its manifest probe')
        clock = measured!
        if (run.windowStartSourceFrame === null || run.windowEndSourceFrame === null) conflict('Face source window operation has no window')
        window = { startSourceFrame: run.windowStartSourceFrame!, endSourceFrame: run.windowEndSourceFrame! }
        if (run.sampleIntervalFrames !== faceSampleIntervalFrames({ num: clock.fps, den: 1 }) ||
            window.endSourceFrame > clock.durationFrames ||
            window.endSourceFrame - window.startSourceFrame > faceWindowFrames(run.sampleIntervalFrames)) {
          conflict('Producer window does not fit the source or its cadence')
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
        sourceByteSize: Number(source.byteSize), sourceFps: clock.fps,
        window: Object.freeze(window), sampleIntervalFrames: run.sampleIntervalFrames, attempt: nextAttempt,
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  /**
   * Seals the source window envelope and its raw detector outputs in the same transaction that completes the operation.
   * Refused: a producer the registry does not authenticate, raw outputs that do not reproduce their samples, a lost or expired lease,
   * a source whose bytes or attachment changed, rights that are no longer approved, or a request context that differs from the sealed
   * result. The Version the window was requested under may have moved on; that is not a reason to discard evidence about the source.
   */
  async publish(input: { envelope: FaceProducerEnvelopeV3; rawOutputs: readonly (Uint8Array | null)[]; leaseOwner: string; now: Date }) {
    const envelope = hydrateContent(stableSerialize(input.envelope), input.envelope.envelopeHash)
    if (!authenticateFaceEnvelope(envelope).authenticated) conflict('Face producer is not an accepted producer on a parity-proven platform')
    const rawRows = inputRawOutputs(envelope, input.rawOutputs)
    assertRawOutputs(envelope, rawRows)
    const { leaseOwner } = input
    return this.client.$transaction(async (transaction) => {
      await lockProducerPublishOperation(transaction, envelope.operationId, envelope.workspaceId)
      const lockedAt = await producerPublishClock(transaction)
      const operation = await transaction.v2PublicOperation.findUnique({ where: { id: envelope.operationId }, include: OPERATION_INCLUDE })
      if (!operation || operation.workspaceId !== envelope.workspaceId || operation.type !== 'perception-face-run' ||
          operation.targetType !== 'project-version' || operation.status !== 'running' || operation.phase !== 'persisting' ||
          operation.attempt !== envelope.operationAttempt || operation.leaseOwner !== leaseOwner ||
          !operation.leaseExpiresAt || operation.leaseExpiresAt <= lockedAt) {
        conflict('Producer operation is not held by the current fenced attempt')
      }
      const expectedFenceHash = calculateCanonicalHash({ operationId: operation.id, attempt: operation.attempt, leaseOwner })
      if (envelope.operationFenceHash !== expectedFenceHash) conflict('Producer operation fence differs')
      const run = await transaction.v2FaceProducerOperation.findUnique({ where: { operationId: operation.id } })
      if (!run || run.detectorProfile !== FACE_SOURCE_WINDOW_DETECTOR_PROFILE || run.workspaceId !== envelope.workspaceId ||
          operation.projectId !== run.projectId || operation.targetId !== run.projectVersionId ||
          run.sourceArtifactId !== envelope.sourceArtifactId || run.sourceSha256 !== envelope.sourceSha256 ||
          run.sampleIntervalFrames !== envelope.samplePolicy.intervalFrames ||
          envelope.samplePolicy.maxSamples !== FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow ||
          run.windowStartSourceFrame !== envelope.window.startSourceFrame ||
          run.windowEndSourceFrame !== envelope.window.endSourceFrame ||
          run.windowStartTimelineFrame !== null || run.windowEndTimelineFrame !== null ||
          envelope.policySha256 !== FACE_EVIDENCE_POLICY_SHA256 ||
          run.requestHash !== operation.requestFingerprint) {
        conflict('Producer request context differs from the sealed result')
      }
      await lockProducerPublishProject(transaction, run.projectId, envelope.workspaceId)
      const project = await transaction.v2Project.findFirst({
        where: { id: run.projectId, workspaceId: envelope.workspaceId }, select: { locale: true },
      })
      await lockProducerPublishSource(transaction, envelope.sourceArtifactId, envelope.workspaceId)
      const artifact = await transaction.v2MediaArtifact.findFirst({
        where: { id: envelope.sourceArtifactId, workspaceId: envelope.workspaceId },
        include: { currentRightsSnapshot: true },
      })
      const attached = await transaction.v2ProjectMediaAsset.findFirst({
        where: { workspaceId: envelope.workspaceId, projectId: run.projectId,
          artifactId: envelope.sourceArtifactId, role: 'source-master' },
        select: { id: true },
      })
      if (!project || !artifact || !attached || artifact.sha256 !== envelope.sourceSha256 ||
          artifact.status !== 'available' || artifact.mediaType !== 'video') {
        conflict('Producer source artifact is unavailable or changed')
      }
      const rights = artifact!.currentRightsSnapshot ? hydrateAssetRights(artifact!.currentRightsSnapshot) : null
      const committedAt = await producerPublishClock(transaction)
      if (operation.leaseExpiresAt <= committedAt) conflict('Producer lease expired before publication')
      if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: envelope.workspaceId, locale: project!.locale ?? 'und' }, committedAt).outcome !== 'allow') {
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
          resultJson: stableSerialize({ resource: { type: 'project-version', id: run.projectVersionId } }) },
      })
      if (updated.count !== 1) conflict('Producer operation fence was lost at commit')
      await transaction.v2FaceSourceWindowEnvelope.create({ data: {
        id: envelope.id, workspaceId: envelope.workspaceId,
        sourceArtifactId: envelope.sourceArtifactId, sourceSha256: envelope.sourceSha256,
        operationId: envelope.operationId, operationAttempt: envelope.operationAttempt, operationFenceHash: expectedFenceHash,
        detectorConfigHash: envelope.detectorConfigHash,
        contentJson: stableSerialize(envelope), envelopeHash: envelope.envelopeHash, schemaVersion: SCHEMA_VERSION,
        windowStartSourceFrame: envelope.window.startSourceFrame, windowEndSourceFrame: envelope.window.endSourceFrame,
        createdAt: new Date(envelope.createdAt),
      } })
      if (rawRows.length) {
        await transaction.v2FaceSourceWindowRawOutput.createMany({ data: rawRows.map((row) => ({
          id: `face-source-raw-${calculateCanonicalHash({ envelopeId: envelope.id, sampleIndex: row.sampleIndex })}`,
          workspaceId: envelope.workspaceId, envelopeId: envelope.id, sampleIndex: row.sampleIndex,
          sourceFrame: row.sourceFrame, sha256: row.sha256, rawBytes: Buffer.from(row.rawBytes),
          createdAt: new Date(envelope.createdAt),
        })) })
      }
      await emitOperationTransition(transaction, operation, operation.id)
      const returnedAt = await producerPublishClock(transaction)
      if (operation.leaseExpiresAt <= returnedAt) conflict('Producer lease expired during publication')
      if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: envelope.workspaceId, locale: project!.locale ?? 'und' }, returnedAt).outcome !== 'allow') {
        throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights expired during publication')
      }
      return envelope
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  /** Fenced read of one stored window for a CONSUMING project; the registry verdict and the rights are recomputed now. */
  read(input: { id: string; workspaceId: string; projectId: string; now: Date }) {
    return readFaceSourceWindowEnvelope(this.client, input)
  }

  /**
   * Verified envelopes of one SOURCE whose window overlaps [from, to) of ITS OWN frames, oldest window first, for a consuming project.
   * Several envelopes may cover the same window (a re-run); deciding between them is the evidence stream's job, not this one's. A project
   * that does not have the source attached sees nothing.
   */
  async listSourceWindows(input: { workspaceId: string; projectId: string; sourceArtifactId: string
    fromSourceFrame: number; toSourceFrame: number; now: Date; limit?: number }): Promise<readonly StoredFaceSourceWindowEnvelope[]> {
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST || !Number.isSafeInteger(input.fromSourceFrame) ||
        !Number.isSafeInteger(input.toSourceFrame) || input.fromSourceFrame < 0 || input.toSourceFrame <= input.fromSourceFrame) {
      throw new DomainError('INVALID_ARGUMENT', 'Face source window listing range is invalid')
    }
    const attached = await this.client.v2ProjectMediaAsset.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, artifactId: input.sourceArtifactId, role: 'source-master' },
      select: { id: true },
    })
    if (!attached) return Object.freeze([])
    const rows = await this.client.v2FaceSourceWindowEnvelope.findMany({
      where: { workspaceId: input.workspaceId, sourceArtifactId: input.sourceArtifactId, schemaVersion: SCHEMA_VERSION,
        windowStartSourceFrame: { lt: input.toSourceFrame }, windowEndSourceFrame: { gt: input.fromSourceFrame } },
      orderBy: [{ windowStartSourceFrame: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true }, take: limit,
    })
    const result: StoredFaceSourceWindowEnvelope[] = []
    for (const row of rows) {
      const stored = await readFaceSourceWindowEnvelope(this.client, { id: row.id, workspaceId: input.workspaceId, projectId: input.projectId, now: input.now })
      if (stored) result.push(stored)
    }
    return Object.freeze(result)
  }
}

/**
 * Fenced read of one stored source window. It proves, in this order: the row is the sealed content; the raw outputs reproduce the
 * samples; the fenced operation published exactly this; the source artifact of THIS workspace still has the sealed bytes hash and is
 * available; the consuming project has the source attached; the rights of the source allow analysis NOW for that project's locale.
 */
export async function readFaceSourceWindowEnvelope(client: Prisma.TransactionClient, input: {
  id: string; workspaceId: string; projectId: string; now: Date
}): Promise<StoredFaceSourceWindowEnvelope | null> {
  const row = await client.v2FaceSourceWindowEnvelope.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId },
    include: { operation: { include: { faceProducerOperation: true } },
      sourceArtifact: { include: { currentRightsSnapshot: true } },
      rawOutputs: { orderBy: { sampleIndex: 'asc' } } },
  })
  if (!row) return null
  if (row.schemaVersion !== SCHEMA_VERSION) conflict('Stored face envelope is not a source window envelope')
  const envelope = hydrateContent(row.contentJson, row.envelopeHash)
  if (row.workspaceId !== envelope.workspaceId || row.operationId !== envelope.operationId ||
      row.operationAttempt !== envelope.operationAttempt || row.operationFenceHash !== envelope.operationFenceHash ||
      row.sourceArtifactId !== envelope.sourceArtifactId || row.sourceSha256 !== envelope.sourceSha256 ||
      row.detectorConfigHash !== envelope.detectorConfigHash ||
      row.windowStartSourceFrame !== envelope.window.startSourceFrame ||
      row.windowEndSourceFrame !== envelope.window.endSourceFrame ||
      row.createdAt.toISOString() !== envelope.createdAt) conflict('Producer envelope columns differ from sealed content')
  assertRawOutputs(envelope, row.rawOutputs.map((raw) => ({ sampleIndex: raw.sampleIndex, sourceFrame: raw.sourceFrame,
    sha256: raw.sha256, rawBytes: new Uint8Array(raw.rawBytes) })))
  let result: Record<string, unknown>
  try { result = JSON.parse(row.operation.resultJson ?? '') as Record<string, unknown> }
  catch { conflict('Producer operation result is invalid') }
  const run = row.operation.faceProducerOperation
  if (!run || run.detectorProfile !== FACE_SOURCE_WINDOW_DETECTOR_PROFILE || run.workspaceId !== envelope.workspaceId ||
      run.sourceArtifactId !== envelope.sourceArtifactId || run.sourceSha256 !== envelope.sourceSha256 ||
      run.sampleIntervalFrames !== envelope.samplePolicy.intervalFrames ||
      envelope.samplePolicy.maxSamples !== FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow ||
      run.windowStartSourceFrame !== envelope.window.startSourceFrame ||
      run.windowEndSourceFrame !== envelope.window.endSourceFrame ||
      run.windowStartTimelineFrame !== null || run.windowEndTimelineFrame !== null ||
      run.requestHash !== row.operation.requestFingerprint ||
      Object.keys(result).sort().join('|') !== 'resource' ||
      !result.resource || typeof result.resource !== 'object' ||
      Object.keys(result.resource).sort().join('|') !== 'id|type' ||
      (result.resource as Record<string, unknown>).type !== 'project-version' ||
      (result.resource as Record<string, unknown>).id !== run.projectVersionId ||
      row.operation.workspaceId !== envelope.workspaceId || row.operation.projectId !== run.projectId ||
      row.operation.targetType !== 'project-version' || row.operation.targetId !== run.projectVersionId ||
      row.operation.status !== 'succeeded' || row.operation.phase !== 'completed' ||
      row.operation.type !== 'perception-face-run' || row.operation.attempt !== envelope.operationAttempt ||
      row.operation.progressCompleted !== 4 || row.operation.progressTotal !== 4 || row.operation.progressUnit !== 'stage') {
    conflict('Producer operation did not publish this fenced envelope')
  }
  // The source identity at use: this workspace's artifact still has the bytes the window was observed on.
  if (row.sourceArtifact.sha256 !== envelope.sourceSha256 || row.sourceArtifact.status !== 'available' ||
      row.sourceArtifact.mediaType !== 'video') conflict('Producer source no longer matches the sealed input')
  const consumer = await client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { locale: true } })
  const attached = await client.v2ProjectMediaAsset.findFirst({
    where: { workspaceId: envelope.workspaceId, projectId: input.projectId, artifactId: envelope.sourceArtifactId, role: 'source-master' },
    select: { id: true },
  })
  if (!consumer || !attached) return null
  const rights = row.sourceArtifact.currentRightsSnapshot ? hydrateAssetRights(row.sourceArtifact.currentRightsSnapshot) : null
  const checkedAt = await producerPublishClock(client)
  if (evaluatePerceptionSourceAnalysisRights(rights, { workspaceId: input.workspaceId, locale: consumer.locale ?? 'und' }, checkedAt).outcome !== 'allow') {
    throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are no longer approved')
  }
  return Object.freeze({ envelope, authentication: authenticateFaceEnvelope(envelope) })
}

// The pure halves of the persistence contract, exported so they can be proven without a database.
export { hydrateContent as hydrateFaceSourceWindowContent, assertRawOutputs as assertFaceSourceWindowRawOutputs,
  inputRawOutputs as faceSourceWindowRawOutputRows, probeClock as faceSourceProbeClock }
