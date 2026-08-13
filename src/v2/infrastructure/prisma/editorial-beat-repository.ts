import { Prisma, type PrismaClient, type V2EditorialBeatAdjustment, type V2EditorialBeatSet } from '../../../../generated/prisma-v2/index.js'
import type { EditorialBeatAdjustment, EditorialBeatRepository, EditorialBeatSet } from '../../application/ports/editorial-beat-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import type { AlignedBeatWord, BeatSignal, EditorialBeat } from '../../domain/editorial-beat.ts'
import { DomainError } from '../../domain/errors.ts'
import { hydrateStoredMediaTranscript } from './speech-segment-catalog-repository.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function json<T>(value: string, field: string): T {
  try { return JSON.parse(value) as T } catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`) }
}
function prismaCode(error: unknown, code: string) { return typeof error === 'object' && error !== null && 'code' in error && error.code === code }

function hydrateSet(row: V2EditorialBeatSet): EditorialBeatSet {
  const actor = hydrateExternalActorAudit({ workspaceId: row.workspaceId, actorCredentialId: row.actorCredentialId, actorEnvironment: row.actorEnvironment, actorAuthenticationKind: row.actorAuthenticationKind, actorContextHash: row.actorContextHash, delegatedUserId: row.actorDelegatedUserId, delegatedIdentityId: row.actorDelegatedIdentityId, workspaceRole: row.actorWorkspaceRole }, row.actorClientId)
  const body = {
    schemaVersion: row.schemaVersion as 'editorial-beat-set/v1', id: row.id, workspaceId: row.workspaceId,
    projectId: row.projectId, projectVersionId: row.projectVersionId, transcriptId: row.transcriptId, transcriptHash: row.transcriptHash,
    derivationVersion: row.derivationVersion as 'editorial-beat-derivation/v1', pauseBoundaryMs: row.pauseBoundaryMs, maxDurationMs: row.maxDurationMs,
    words: Object.freeze(json<AlignedBeatWord[]>(row.wordsJson, 'editorial beat words')), wordsHash: row.wordsHash,
    signals: Object.freeze(json<BeatSignal[]>(row.signalsJson, 'editorial beat signals')), signalsHash: row.signalsHash,
    beats: Object.freeze(json<EditorialBeat[]>(row.beatsJson, 'editorial beats')), beatsHash: row.beatsHash,
    idempotencyKey: row.idempotencyKey, requestFingerprint: row.requestFingerprint, actor, createdAt: row.createdAt.toISOString(),
  }
  const expectedBeatsHash = calculateCanonicalHash({ derivationVersion: body.derivationVersion, transcriptHash: body.transcriptHash, pauseBoundaryMs: body.pauseBoundaryMs, maxDurationMs: body.maxDurationMs, beats: body.beats })
  if (row.schemaVersion !== 'editorial-beat-set/v1' || row.derivationVersion !== 'editorial-beat-derivation/v1' || calculateCanonicalHash(body) !== row.recordHash || calculateCanonicalHash(body.words) !== row.wordsHash || calculateCanonicalHash(body.signals) !== row.signalsHash || expectedBeatsHash !== row.beatsHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial beat set failed integrity validation')
  return Object.freeze({ ...body, recordHash: row.recordHash })
}

function hydrateAdjustment(row: V2EditorialBeatAdjustment): EditorialBeatAdjustment {
  const actor = hydrateExternalActorAudit({ workspaceId: row.workspaceId, actorCredentialId: row.actorCredentialId, actorEnvironment: row.actorEnvironment, actorAuthenticationKind: row.actorAuthenticationKind, actorContextHash: row.actorContextHash, delegatedUserId: row.actorDelegatedUserId, delegatedIdentityId: row.actorDelegatedIdentityId, workspaceRole: row.actorWorkspaceRole }, row.actorClientId)
  const adjustedBeat = Object.freeze(json<EditorialBeat>(row.adjustedBeatJson, 'adjusted editorial beat'))
  const body = { schemaVersion: row.schemaVersion as 'editorial-beat-adjustment-record/v1', id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, beatSetId: row.beatSetId, sourceBeatId: row.sourceBeatId, directorRunId: row.directorRunId, reason: row.reason, startWordId: row.startWordId, endWordId: row.endWordId, sourceBeatHash: row.sourceBeatHash, adjustedBeat, wordAlignmentHash: row.wordAlignmentHash, wordAlignmentUnchanged: true as const, adjustmentHash: row.adjustmentHash, idempotencyKey: row.idempotencyKey, requestFingerprint: row.requestFingerprint, actor, createdAt: row.createdAt.toISOString() }
  const expectedAdjustmentHash = calculateCanonicalHash({ schemaVersion: 'editorial-beat-adjustment/v1', sourceBeatHash: row.sourceBeatHash, adjustedBeatHash: adjustedBeat.beatHash, wordAlignmentHash: row.wordAlignmentHash, directorRunId: row.directorRunId, reason: row.reason })
  if (!row.wordAlignmentUnchanged || row.schemaVersion !== 'editorial-beat-adjustment-record/v1' || adjustedBeat.beatHash !== row.adjustedBeatHash || expectedAdjustmentHash !== row.adjustmentHash || calculateCanonicalHash(body) !== row.recordHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial beat adjustment failed integrity validation')
  return Object.freeze({ ...body, recordHash: row.recordHash })
}

export class PrismaEditorialBeatRepository implements EditorialBeatRepository {
  constructor(private readonly client: PrismaClient) {}
  async readSource(input: { workspaceId: string; projectId: string; projectVersionId: string; transcriptId: string }) {
    const [version, transcript] = await Promise.all([
      this.client.v2ProjectVersion.findFirst({ where: { id: input.projectVersionId, projectId: input.projectId, workspaceId: input.workspaceId }, select: { id: true } }),
      this.client.v2MediaTranscript.findFirst({ where: { id: input.transcriptId, projectId: input.projectId, workspaceId: input.workspaceId }, select: { transcriptJson: true, transcriptHash: true } }),
    ])
    if (!version || !transcript) return null
    return Object.freeze({ ...input, transcript: hydrateStoredMediaTranscript(transcript) })
  }
  async findSetByIdempotency(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorClientId: string; actorContextHash: string }) {
    const row = await this.client.v2EditorialBeatSet.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, actorClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (row.actorContextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Editorial beat idempotency belongs to another credential context')
    return hydrateSet(row)
  }
  async findSet(input: { workspaceId: string; projectId: string; beatSetId: string }) {
    const row = await this.client.v2EditorialBeatSet.findFirst({ where: { id: input.beatSetId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrateSet(row) : null
  }
  async persistSet(set: EditorialBeatSet) {
    for (let attempt = 0; attempt < 3; attempt += 1) try {
      return await this.client.$transaction(async (tx) => {
        const existing = await tx.v2EditorialBeatSet.findFirst({ where: { workspaceId: set.workspaceId, projectId: set.projectId, actorClientId: set.actor.clientId, idempotencyKey: set.idempotencyKey } })
        const row = existing ?? await tx.v2EditorialBeatSet.create({ data: { id: set.id, workspaceId: set.workspaceId, projectId: set.projectId, projectVersionId: set.projectVersionId, transcriptId: set.transcriptId, transcriptHash: set.transcriptHash, schemaVersion: set.schemaVersion, derivationVersion: set.derivationVersion, pauseBoundaryMs: set.pauseBoundaryMs, maxDurationMs: set.maxDurationMs, wordsJson: stableSerialize(set.words), wordsHash: set.wordsHash, signalsJson: stableSerialize(set.signals), signalsHash: set.signalsHash, beatsJson: stableSerialize(set.beats), beatsHash: set.beatsHash, idempotencyKey: set.idempotencyKey, requestFingerprint: set.requestFingerprint, actorClientId: set.actor.clientId, ...externalActorAuditData(set.actor, set.workspaceId, set.actor.clientId), actorDelegatedUserId: set.actor.delegatedUserId ?? null, actorDelegatedIdentityId: set.actor.delegatedIdentityId ?? null, actorWorkspaceRole: set.actor.workspaceRole ?? null, createdAt: new Date(set.createdAt), recordHash: set.recordHash } })
        const hydrated = hydrateSet(row)
        if (hydrated.recordHash !== set.recordHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Stored editorial beat set conflicts with request')
        return Object.freeze({ set: hydrated, replayed: existing !== null })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) { if (attempt < 2 && (prismaCode(error, 'P2002') || prismaCode(error, 'P2034'))) continue; throw error }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial beat set could not be serialized')
  }
  async assertDirectorRun(input: { workspaceId: string; projectId: string; projectVersionId: string; directorRunId: string }) {
    return Boolean(await this.client.v2DirectorRun.findFirst({ where: { id: input.directorRunId, workspaceId: input.workspaceId, projectId: input.projectId, resultVersionId: input.projectVersionId, status: 'completed' }, select: { id: true } }))
  }
  async findAdjustmentByIdempotency(input: { workspaceId: string; beatSetId: string; idempotencyKey: string; actorClientId: string; actorContextHash: string }) {
    const row = await this.client.v2EditorialBeatAdjustment.findFirst({ where: { workspaceId: input.workspaceId, beatSetId: input.beatSetId, actorClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (row.actorContextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Editorial beat adjustment idempotency belongs to another credential context')
    return hydrateAdjustment(row)
  }
  async persistAdjustment(adjustment: EditorialBeatAdjustment) {
    for (let attempt = 0; attempt < 3; attempt += 1) try {
      return await this.client.$transaction(async (tx) => {
        const set = await tx.v2EditorialBeatSet.findFirst({ where: { id: adjustment.beatSetId, workspaceId: adjustment.workspaceId, projectId: adjustment.projectId }, select: { wordsHash: true, beatsJson: true } })
        if (!set || set.wordsHash !== adjustment.wordAlignmentHash || !json<EditorialBeat[]>(set.beatsJson, 'beats').some((beat) => beat.id === adjustment.sourceBeatId && beat.beatHash === adjustment.sourceBeatHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial beat adjustment source evidence changed')
        const existing = await tx.v2EditorialBeatAdjustment.findFirst({ where: { workspaceId: adjustment.workspaceId, beatSetId: adjustment.beatSetId, actorClientId: adjustment.actor.clientId, idempotencyKey: adjustment.idempotencyKey } })
        const row = existing ?? await tx.v2EditorialBeatAdjustment.create({ data: { id: adjustment.id, workspaceId: adjustment.workspaceId, projectId: adjustment.projectId, beatSetId: adjustment.beatSetId, sourceBeatId: adjustment.sourceBeatId, directorRunId: adjustment.directorRunId, schemaVersion: adjustment.schemaVersion, reason: adjustment.reason, startWordId: adjustment.startWordId, endWordId: adjustment.endWordId, sourceBeatHash: adjustment.sourceBeatHash, adjustedBeatJson: stableSerialize(adjustment.adjustedBeat), adjustedBeatHash: adjustment.adjustedBeat.beatHash, wordAlignmentHash: adjustment.wordAlignmentHash, wordAlignmentUnchanged: true, adjustmentHash: adjustment.adjustmentHash, idempotencyKey: adjustment.idempotencyKey, requestFingerprint: adjustment.requestFingerprint, actorClientId: adjustment.actor.clientId, ...externalActorAuditData(adjustment.actor, adjustment.workspaceId, adjustment.actor.clientId), actorDelegatedUserId: adjustment.actor.delegatedUserId ?? null, actorDelegatedIdentityId: adjustment.actor.delegatedIdentityId ?? null, actorWorkspaceRole: adjustment.actor.workspaceRole ?? null, createdAt: new Date(adjustment.createdAt), recordHash: adjustment.recordHash } })
        const hydrated = hydrateAdjustment(row)
        if (hydrated.recordHash !== adjustment.recordHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Stored editorial beat adjustment conflicts with request')
        return Object.freeze({ adjustment: hydrated, replayed: existing !== null })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) { if (attempt < 2 && (prismaCode(error, 'P2002') || prismaCode(error, 'P2034'))) continue; throw error }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial beat adjustment could not be serialized')
  }
}
