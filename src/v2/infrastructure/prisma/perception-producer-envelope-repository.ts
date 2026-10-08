import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import { randomUUID } from 'node:crypto'

import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { createPerceptionProducerEnvelope, type PerceptionProducerEnvelope, type PerceptionProducerEnvelopeInput } from '../../domain/perception-producer-envelope.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPublicOperationProgressEvents } from '../../domain/public-operation-event.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import { hydratePublicOperationRecord, OPERATION_INCLUDE, persistOperationStatusEvents,
  type StoredOperation } from './public-operation-repository.ts'

function conflict(message: string): never { throw new DomainError('PERSISTENCE_CONFLICT', message) }

async function emitOperationTransition(transaction: Prisma.TransactionClient,
  previous: StoredOperation, operationId: string) {
  const next = await transaction.v2PublicOperation.findUnique({
    where: { id: operationId }, include: OPERATION_INCLUDE,
  })
  if (!next) conflict('Producer operation disappeared during transition')
  const before = hydratePublicOperationRecord(previous).operation
  const after = hydratePublicOperationRecord(next).operation
  await persistPublicEvents(transaction, createPublicOperationProgressEvents({
    previous: before, operation: after, createEventId: randomUUID,
  }))
  await persistOperationStatusEvents(transaction, before.status, after, randomUUID)
}

function sourceMap(contentJson: string, sourceArtifactId: string) {
  let plan: unknown
  try { plan = JSON.parse(contentJson) } catch { conflict('Stored edit plan JSON is invalid') }
  const value = plan as Record<string, unknown>
  if (!value || !Array.isArray(value.videoTracks)) conflict('Stored edit plan has no video tracks')
  const clips = value.videoTracks.flatMap((track: unknown) => {
    const item = track as Record<string, unknown>
    return Array.isArray(item?.clips) ? item.clips : []
  }).filter((clip: unknown) => (clip as Record<string, unknown>)?.sourceArtifactId === sourceArtifactId)
  return clips.map((clip: unknown) => {
    const item = clip as Record<string, unknown>
    if (typeof item.id !== 'string' ||
        ![item.sourceInFrame, item.sourceOutFrame, item.timelineInFrame,
          item.timelineOutFrame, item.rate].every((number) => typeof number === 'number' && Number.isFinite(number))) {
      conflict('Stored edit plan source-to-timeline range is invalid')
    }
    return {
      clipId: item.id as string, sourceInFrame: item.sourceInFrame as number,
      sourceOutFrame: item.sourceOutFrame as number,
      timelineInFrame: item.timelineInFrame as number,
      timelineOutFrame: item.timelineOutFrame as number, rate: item.rate as number,
    }
  })
}

function hydrateContent(contentJson: string, expectedHash: string): PerceptionProducerEnvelope {
  let parsed: unknown
  try { parsed = JSON.parse(contentJson) } catch { conflict('Stored producer envelope JSON is invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) conflict('Stored producer envelope is invalid')
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).sort().join('|') !== [
    'schemaVersion', 'authority', 'faceSafety', 'timeMapHash', 'envelopeHash',
    'id', 'workspaceId', 'projectId', 'projectVersionId', 'operationId', 'operationAttempt',
    'operationFenceHash', 'sourceArtifactId', 'sourceSha256', 'editPlanSnapshotId',
    'editPlanSnapshotHash', 'timelineDurationFrames', 'timeMap', 'sourceTimebase',
    'sourceFps', 'timelineFps', 'sourcePtsStart', 'sourcePtsRounding', 'sourceClock',
    'modality', 'producer', 'samplePolicy', 'samples', 'gaps', 'createdAt',
  ].sort().join('|')) conflict('Stored producer envelope fields are invalid')
  const { schemaVersion, authority, faceSafety, timeMapHash, envelopeHash, ...input } = record
  if (schemaVersion !== 'perception-producer-envelope/v1' || authority !== 'server-produced' ||
      faceSafety !== 'unknown' || typeof timeMapHash !== 'string' || typeof envelopeHash !== 'string') {
    conflict('Stored producer envelope authority is invalid')
  }
  let rebuilt: PerceptionProducerEnvelope
  try { rebuilt = createPerceptionProducerEnvelope(input as PerceptionProducerEnvelopeInput) }
  catch { conflict('Stored producer envelope content is invalid') }
  if (rebuilt.timeMapHash !== timeMapHash || rebuilt.envelopeHash !== envelopeHash ||
      rebuilt.envelopeHash !== expectedHash || stableSerialize(rebuilt) !== stableSerialize(record)) {
    conflict('Stored producer envelope failed integrity validation')
  }
  return rebuilt
}

export class PrismaPerceptionProducerEnvelopeRepository {
  constructor(private readonly client: PrismaClient) {}

  async currentFenceHash(input: { operationId: string; attempt: number; leaseOwner: string; now: Date }) {
    const operation = await this.client.v2PublicOperation.findFirst({ where: {
      id: input.operationId, type: 'perception-producer-run', status: 'running',
      attempt: input.attempt, leaseOwner: input.leaseOwner,
      leaseExpiresAt: { gt: input.now },
    }, select: { id: true } })
    if (!operation) conflict('Producer operation fence is no longer held')
    return calculateCanonicalHash({ operationId: operation.id, attempt: input.attempt, leaseOwner: input.leaseOwner })
  }

  async claimNext(input: { leaseOwner: string; now: Date; leaseMs: number }) {
    if (!input.leaseOwner.trim() || !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 10_000 || input.leaseMs > 300_000) {
      throw new DomainError('INVALID_ARGUMENT', 'Producer worker lease is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const candidates = await transaction.v2PublicOperation.findMany({
        where: { type: 'perception-producer-run',
          OR: [{ status: 'queued' }, { status: 'retrying', nextAttemptAt: { lte: input.now } },
            { status: 'running', leaseExpiresAt: { lte: input.now } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: OPERATION_INCLUDE,
        take: 20,
      })
      for (const exhausted of candidates.filter((row) => row.status === 'running' &&
        row.attempt >= row.maxAttempts)) {
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
      const candidate = candidates.find((row) => row.attempt < row.maxAttempts)
      if (!candidate || !candidate.perceptionProducerOperation) return null
      const nextAttempt = candidate.attempt + 1
      const updated = await transaction.v2PublicOperation.updateMany({
        where: { id: candidate.id, status: candidate.status, attempt: candidate.attempt,
          leaseOwner: candidate.leaseOwner, leaseExpiresAt: candidate.leaseExpiresAt },
        data: { status: 'running', phase: 'probing', attempt: nextAttempt,
          progressCompleted: 0, progressTotal: 4, progressUnit: 'stage',
          leaseOwner: input.leaseOwner, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          heartbeatAt: input.now, startedAt: candidate.startedAt ?? input.now,
          nextAttemptAt: null, completedAt: null, errorCode: null, errorMessage: null,
          errorRetryable: null, resultJson: null },
      })
      if (updated.count !== 1) return null
      let source: NonNullable<Awaited<ReturnType<typeof transaction.v2MediaArtifact.findFirst>>>
      let plan: Record<string, unknown>
      let timeMap: ReturnType<typeof sourceMap>
      try {
      const foundSource = await transaction.v2MediaArtifact.findFirst({
        where: { id: candidate.perceptionProducerOperation.sourceArtifactId,
          workspaceId: candidate.workspaceId, status: 'available', mediaType: 'video' },
        include: { currentRightsSnapshot: true },
      })
      if (!foundSource || foundSource.byteSize > BigInt(Number.MAX_SAFE_INTEGER) ||
          foundSource.sha256 !== candidate.perceptionProducerOperation.sourceSha256) {
        conflict('Producer source artifact is unavailable')
      }
      source = foundSource
      const project = await transaction.v2Project.findFirst({
        where: { id: candidate.perceptionProducerOperation.projectId,
          workspaceId: candidate.workspaceId,
          currentVersionId: candidate.perceptionProducerOperation.projectVersionId },
        select: { locale: true },
      })
      const attached = await transaction.v2ProjectMediaAsset.findFirst({
        where: { workspaceId: candidate.workspaceId,
          projectId: candidate.perceptionProducerOperation.projectId,
          artifactId: source.id, role: 'source-master' }, select: { id: true },
      })
      if (!project || !attached) conflict('Producer source is not current and attached')
      const rights = foundSource.currentRightsSnapshot ? hydrateAssetRights(foundSource.currentRightsSnapshot) : null
      if (evaluateAssetUse(rights, { workspaceId: candidate.workspaceId,
        use: 'editorial-reuse', locale: project.locale ?? 'und' }, input.now).outcome !== 'allow') {
        throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are not approved')
      }
      const version = await transaction.v2ProjectVersion.findFirst({
        where: { id: candidate.perceptionProducerOperation.projectVersionId,
          projectId: candidate.perceptionProducerOperation.projectId,
          workspaceId: candidate.workspaceId },
        include: { editPlanSnapshot: true },
      })
      if (!version || version.editPlanSnapshot.kind !== 'edit-plan' ||
          version.baseHash !== candidate.perceptionProducerOperation.projectVersionHash ||
          version.editPlanSnapshotId !== candidate.perceptionProducerOperation.editPlanSnapshotId ||
          version.editPlanSnapshot.contentHash !== candidate.perceptionProducerOperation.editPlanSnapshotHash) {
        conflict('Producer operation source version is unavailable')
      }
      try { plan = JSON.parse(version.editPlanSnapshot.contentJson) as Record<string, unknown> }
      catch { conflict('Producer edit plan JSON is invalid') }
      if (calculateCanonicalHash(plan) !== version.editPlanSnapshot.contentHash ||
          !Number.isSafeInteger(plan.fps) || Number(plan.fps) < 1 ||
          !Number.isSafeInteger(plan.durationFrames) || Number(plan.durationFrames) < 1) {
        conflict('Producer edit plan timing is invalid')
      }
      timeMap = sourceMap(version.editPlanSnapshot.contentJson, source.id)
      if (!timeMap.length || timeMap[0]!.timelineInFrame !== 0 ||
          timeMap.at(-1)!.timelineOutFrame !== Number(plan.durationFrames) ||
          timeMap.some((range, index) => index > 0 &&
            range.timelineInFrame !== timeMap[index - 1]!.timelineOutFrame)) {
        conflict('Producer source does not cover the current timeline as one ordered source')
      }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        const terminal = await transaction.v2PublicOperation.updateMany({
          where: { id: candidate.id, status: 'running', attempt: nextAttempt,
            leaseOwner: input.leaseOwner },
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
        projectId: candidate.perceptionProducerOperation.projectId,
        projectVersionId: candidate.perceptionProducerOperation.projectVersionId,
        sourceArtifactId: source.id, sourceSha256: source.sha256, artifactKey: source.artifactKey,
        sourceByteSize: Number(source.byteSize),
        editPlanSnapshotId: candidate.perceptionProducerOperation.editPlanSnapshotId,
        editPlanSnapshotHash: candidate.perceptionProducerOperation.editPlanSnapshotHash,
        timeMap, timelineDurationFrames: Number(plan.durationFrames),
        timelineFps: Object.freeze({ num: Number(plan.fps), den: 1 }),
        sampleIntervalFrames: candidate.perceptionProducerOperation.sampleIntervalFrames,
        attempt: nextAttempt, leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async heartbeat(input: { operationId: string; attempt: number; leaseOwner: string; now: Date; leaseMs: number }) {
    const count = await this.client.v2PublicOperation.updateMany({
      where: { id: input.operationId, type: 'perception-producer-run', status: 'running',
        attempt: input.attempt, leaseOwner: input.leaseOwner, leaseExpiresAt: { gt: input.now } },
      data: { heartbeatAt: input.now, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs) },
    })
    return count.count === 1
  }

  async advancePhase(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date; phase: 'transcribing' | 'verifying' | 'persisting' }) {
    const phases = ['probing', 'transcribing', 'verifying', 'persisting'] as const
    const completed = phases.indexOf(input.phase)
    const previous = phases[completed - 1]
    return this.client.$transaction(async (transaction) => {
    const before = await transaction.v2PublicOperation.findUnique({
      where: { id: input.operationId }, include: OPERATION_INCLUDE,
    })
    if (!before) return false
    const updated = await transaction.v2PublicOperation.updateMany({
      where: { id: input.operationId, type: 'perception-producer-run', status: 'running',
        phase: previous, attempt: input.attempt, leaseOwner: input.leaseOwner,
        leaseExpiresAt: { gt: input.now } },
      data: { phase: input.phase, progressCompleted: completed, updatedAt: input.now },
    })
    if (updated.count === 1) await emitOperationTransition(transaction, before, input.operationId)
    return updated.count === 1
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async failAttempt(input: { operationId: string; attempt: number; leaseOwner: string;
    now: Date; errorCode: string; errorMessage: string; retryable: boolean }) {
    return this.client.$transaction(async (transaction) => {
    const row = await transaction.v2PublicOperation.findUnique({
      where: { id: input.operationId }, include: OPERATION_INCLUDE,
    })
    if (!row || row.type !== 'perception-producer-run' || row.status !== 'running' ||
        row.attempt !== input.attempt || row.leaseOwner !== input.leaseOwner) return false
    const terminal = !input.retryable || row.attempt >= row.maxAttempts
    const updated = await transaction.v2PublicOperation.updateMany({
      where: { id: row.id, type: 'perception-producer-run', status: 'running',
        attempt: input.attempt, leaseOwner: input.leaseOwner, leaseExpiresAt: row.leaseExpiresAt },
      data: { status: terminal ? 'failed' : 'retrying', phase: terminal ? 'failed' : 'retrying',
        cancelable: !terminal, retryable: !terminal,
        leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
        // PublicOperation only permits an error payload on a terminal failure.
        errorCode: terminal ? input.errorCode.toLowerCase().replaceAll('_', '-').slice(0, 64) : null,
        errorMessage: terminal ? input.errorMessage.slice(0, 500) : null,
        errorRetryable: terminal ? false : null,
        nextAttemptAt: terminal ? null : new Date(input.now.getTime() + 1000),
        completedAt: terminal ? input.now : null,
        deadLetteredAt: terminal && input.retryable ? input.now : null,
        updatedAt: input.now },
    })
    if (updated.count === 1) await emitOperationTransition(transaction, row, input.operationId)
    return updated.count === 1
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async publish(input: { envelope: Readonly<PerceptionProducerEnvelope>; leaseOwner: string; now: Date }) {
    const envelope = hydrateContent(stableSerialize(input.envelope), input.envelope.envelopeHash)
    const { leaseOwner, now } = input
    return this.client.$transaction(async (transaction) => {
      const operation = await transaction.v2PublicOperation.findUnique({
        where: { id: envelope.operationId }, include: OPERATION_INCLUDE,
      })
      if (!operation || operation.workspaceId !== envelope.workspaceId || operation.projectId !== envelope.projectId ||
          operation.type !== 'perception-producer-run' || operation.targetType !== 'project-version' ||
          operation.targetId !== envelope.projectVersionId ||
          operation.status !== 'running' || operation.phase !== 'persisting' ||
          operation.attempt !== envelope.operationAttempt ||
          operation.leaseOwner !== leaseOwner || !operation.leaseExpiresAt || operation.leaseExpiresAt <= now) {
        conflict('Producer operation is not held by the current fenced attempt')
      }
      const expectedFenceHash = calculateCanonicalHash({
        operationId: operation.id, attempt: operation.attempt, leaseOwner,
      })
      if (envelope.operationFenceHash !== expectedFenceHash) conflict('Producer operation fence differs')
      const run = await transaction.v2PerceptionProducerOperation.findUnique({
        where: { operationId: operation.id },
      })
      if (!run || run.workspaceId !== envelope.workspaceId || run.projectId !== envelope.projectId ||
          run.projectVersionId !== envelope.projectVersionId || run.sourceArtifactId !== envelope.sourceArtifactId ||
          run.sourceSha256 !== envelope.sourceSha256 || run.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
          run.editPlanSnapshotHash !== envelope.editPlanSnapshotHash ||
          run.sampleIntervalFrames !== envelope.samplePolicy.intervalFrames) {
        conflict('Producer request context differs from the sealed result')
      }
      const project = await transaction.v2Project.findFirst({
        where: { id: envelope.projectId, workspaceId: envelope.workspaceId },
        select: { currentVersionId: true, locale: true },
      })
      const version = await transaction.v2ProjectVersion.findFirst({
        where: { id: envelope.projectVersionId, projectId: envelope.projectId, workspaceId: envelope.workspaceId },
        include: { editPlanSnapshot: true },
      })
      if (!project || project.currentVersionId !== envelope.projectVersionId || !version ||
          version.baseHash !== run.projectVersionHash ||
          version.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
          version.editPlanSnapshot.contentHash !== envelope.editPlanSnapshotHash ||
          calculateCanonicalHash(JSON.parse(version.editPlanSnapshot.contentJson)) !== envelope.editPlanSnapshotHash ||
          calculateCanonicalHash(sourceMap(version.editPlanSnapshot.contentJson, envelope.sourceArtifactId)) !== envelope.timeMapHash) {
        conflict('Producer input version or source-to-timeline map changed')
      }
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
      if (evaluateAssetUse(rights, { workspaceId: envelope.workspaceId, use: 'editorial-reuse', locale: project.locale ?? 'und' }, now).outcome !== 'allow') {
        throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are not approved')
      }
      const updated = await transaction.v2PublicOperation.updateMany({
        where: { id: operation.id, workspaceId: envelope.workspaceId, status: 'running', phase: 'persisting',
          attempt: envelope.operationAttempt, leaseOwner, leaseExpiresAt: operation.leaseExpiresAt },
        data: { status: 'succeeded', phase: 'completed', completedAt: now,
          cancelable: false, retryable: false, leaseOwner: null,
          leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null,
          errorCode: null, errorMessage: null, errorRetryable: null,
          progressCompleted: 4, progressTotal: 4, progressUnit: 'stage',
          resultJson: stableSerialize({ resource: { type: 'project-version', id: envelope.projectVersionId } }) },
      })
      if (updated.count !== 1) conflict('Producer operation fence was lost at commit')
      await transaction.v2PerceptionProducerEnvelope.create({ data: {
        id: envelope.id, workspaceId: envelope.workspaceId, projectId: envelope.projectId,
        projectVersionId: envelope.projectVersionId, operationId: envelope.operationId,
        operationAttempt: envelope.operationAttempt, operationFenceHash: expectedFenceHash,
        sourceArtifactId: envelope.sourceArtifactId, sourceSha256: envelope.sourceSha256,
        editPlanSnapshotId: envelope.editPlanSnapshotId, editPlanSnapshotHash: envelope.editPlanSnapshotHash,
        timeMapHash: envelope.timeMapHash, modality: envelope.modality,
        contentJson: stableSerialize(envelope), envelopeHash: envelope.envelopeHash,
        createdAt: new Date(envelope.createdAt),
      } })
      await emitOperationTransition(transaction, operation, operation.id)
      return envelope
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async read(input: { id: string; workspaceId: string; projectId: string; inputVersionId: string; now: Date }) {
    const row = await this.client.v2PerceptionProducerEnvelope.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
        projectVersionId: input.inputVersionId },
      include: { operation: { include: { perceptionProducerOperation: true } },
        sourceArtifact: { include: { currentRightsSnapshot: true } },
        projectVersion: { include: { editPlanSnapshot: true, project: true } } },
    })
    if (!row) return null
    const envelope = hydrateContent(row.contentJson, row.envelopeHash)
    if (row.workspaceId !== envelope.workspaceId || row.projectId !== envelope.projectId ||
        row.projectVersionId !== envelope.projectVersionId || row.operationId !== envelope.operationId ||
        row.operationAttempt !== envelope.operationAttempt || row.operationFenceHash !== envelope.operationFenceHash ||
        row.sourceArtifactId !== envelope.sourceArtifactId || row.sourceSha256 !== envelope.sourceSha256 ||
        row.editPlanSnapshotId !== envelope.editPlanSnapshotId || row.editPlanSnapshotHash !== envelope.editPlanSnapshotHash ||
        row.timeMapHash !== envelope.timeMapHash || row.modality !== envelope.modality ||
        row.createdAt.toISOString() !== envelope.createdAt) conflict('Producer envelope columns differ from sealed content')
    let result: Record<string, unknown>
    try { result = JSON.parse(row.operation.resultJson ?? '') as Record<string, unknown> }
    catch { conflict('Producer operation result is invalid') }
    const run = row.operation.perceptionProducerOperation
    if (!run || run.workspaceId !== envelope.workspaceId || run.projectId !== envelope.projectId ||
        run.projectVersionId !== envelope.projectVersionId || run.projectVersionHash !== row.projectVersion.baseHash ||
        run.sourceArtifactId !== envelope.sourceArtifactId || run.sourceSha256 !== envelope.sourceSha256 ||
        run.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
        run.editPlanSnapshotHash !== envelope.editPlanSnapshotHash ||
        run.sampleIntervalFrames !== envelope.samplePolicy.intervalFrames ||
        Object.keys(result).sort().join('|') !== 'resource' ||
        !result.resource || typeof result.resource !== 'object' ||
        Object.keys(result.resource).sort().join('|') !== 'id|type' ||
        (result.resource as Record<string, unknown>).type !== 'project-version' ||
        (result.resource as Record<string, unknown>).id !== envelope.projectVersionId ||
        row.operation.workspaceId !== envelope.workspaceId || row.operation.projectId !== envelope.projectId ||
        row.operation.targetType !== 'project-version' || row.operation.targetId !== envelope.projectVersionId ||
        row.operation.status !== 'succeeded' || row.operation.phase !== 'completed' ||
        row.operation.type !== 'perception-producer-run' || row.operation.attempt !== envelope.operationAttempt ||
        row.operation.progressCompleted !== 4 || row.operation.progressTotal !== 4 ||
        row.operation.progressUnit !== 'stage') {
      conflict('Producer operation did not publish this fenced envelope')
    }
    const version = row.projectVersion
    const attached = await this.client.v2ProjectMediaAsset.findFirst({
      where: { workspaceId: envelope.workspaceId, projectId: envelope.projectId,
        artifactId: envelope.sourceArtifactId, role: 'source-master' }, select: { id: true },
    })
    let editPlanHash: string
    try { editPlanHash = calculateCanonicalHash(JSON.parse(version.editPlanSnapshot.contentJson)) }
    catch { conflict('Stored edit plan JSON is invalid') }
    if (version.editPlanSnapshotId !== envelope.editPlanSnapshotId ||
        version.editPlanSnapshot.contentHash !== envelope.editPlanSnapshotHash ||
        editPlanHash !== envelope.editPlanSnapshotHash ||
        calculateCanonicalHash(sourceMap(version.editPlanSnapshot.contentJson, envelope.sourceArtifactId)) !== envelope.timeMapHash ||
        !attached || row.sourceArtifact.sha256 !== envelope.sourceSha256 ||
        row.sourceArtifact.status !== 'available' || row.sourceArtifact.mediaType !== 'video') {
      conflict('Producer source or time-map no longer matches the sealed input')
    }
    const rights = row.sourceArtifact.currentRightsSnapshot ? hydrateAssetRights(row.sourceArtifact.currentRightsSnapshot) : null
    if (evaluateAssetUse(rights, { workspaceId: input.workspaceId, use: 'editorial-reuse',
      locale: version.project.locale ?? 'und' }, input.now).outcome !== 'allow') {
      throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights are no longer approved')
    }
    return envelope
  }
}
