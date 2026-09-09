import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { LocalizationRunRepository } from '../../application/ports/localization-run-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { beginLocalizationTranslation, failLocalizationTranslation, LOCALIZATION_RUN_SCHEMA_VERSION, type LocalizationRun } from '../../domain/localization-run.ts'
import { assertLocalizationVariantIntegrity, transitionLocalizationVariant, type LocalizationVariant } from '../../domain/localization.ts'
import { LOCALIZATION_TRANSLATION_PREFLIGHT_SCHEMA_VERSION, type LocalizationTranslationPreflight } from '../../domain/localization-translation-preflight.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { batchActorAuditData, hydrateBatchActorAudit } from './batch-actor-audit.ts'
import { childRowId } from './child-row-id.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'

function parse<T>(value: string, label: string): T { try { return JSON.parse(value) as T } catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${label} is invalid JSON`) } }
function hydrate(row: { runJson: string; runHash: string }): Readonly<LocalizationRun> {
  const run = parse<LocalizationRun>(row.runJson, 'localization run')
  if (run.schemaVersion !== LOCALIZATION_RUN_SCHEMA_VERSION || run.runHash !== row.runHash || calculateCanonicalHash({ ...run, runHash: undefined }) !== run.runHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored localization run hash is inconsistent')
  if (run.translation) {
    const { translationHash, ...body } = run.translation
    if (calculateCanonicalHash(body) !== translationHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored localization translation hash is inconsistent')
  }
  return Object.freeze(run)
}
function hydratePreflight(row: { preflightJson: string; preflightHash: string }): Readonly<LocalizationTranslationPreflight> {
  const value = parse<LocalizationTranslationPreflight>(row.preflightJson, 'localization translation preflight')
  if (value.schemaVersion !== LOCALIZATION_TRANSLATION_PREFLIGHT_SCHEMA_VERSION || value.preflightHash !== row.preflightHash || calculateCanonicalHash({ ...value, preflightHash: undefined }) !== value.preflightHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored localization translation preflight hash is inconsistent')
  return Object.freeze(value)
}

export class PrismaLocalizationRunRepository implements LocalizationRunRepository {
  private readonly prisma: PrismaClient
  constructor(prisma: PrismaClient = getV2PostgresClient()) { this.prisma = prisma }

  async readAuthenticationAudit(input: { workspaceId: string; runId: string }) {
    const row = await this.prisma.v2LocalizationRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId } })
    if (!row) throw new DomainError('LOCALIZATION_VARIANT_NOT_FOUND', 'Localization run was not found')
    return hydrateBatchActorAudit(row, row.requestedByClientId)
  }

  async authorizeCurrentSource(input: { run: Readonly<LocalizationRun>; preflight: Readonly<LocalizationTranslationPreflight>; at: string }) {
    const head = await this.prisma.v2LocalizationVariantHead.findFirst({ where: { id: input.run.variantId, workspaceId: input.run.workspaceId, projectId: input.run.projectId, currentRevision: input.run.variantRevision, currentVariantHash: input.run.variantHash, canonicalScriptVersionId: input.run.canonicalScriptVersionId }, include: { sourceArtifact: { include: { currentRightsSnapshot: true } } } })
    const rights = head?.sourceArtifact.currentRightsSnapshot
    const operations = input.preflight.mode === 'authorized-tts' ? ['tts'] : input.preflight.mode === 'lip-sync' ? ['lip-sync'] : input.preflight.mode === 'regenerated-avatar' ? ['audio-avatar'] : []
    const decision = rights && head.sourceArtifact.status === 'available' && head.sourceArtifact.sha256 === head.sourceSha256 && rights.id === head.sourceRightsSnapshotId ? evaluateAssetUse(hydrateAssetRights(rights), { workspaceId: input.run.workspaceId, use: 'localization', locale: input.preflight.targetLocale, ...(input.preflight.market ? { market: input.preflight.market } : {}), ...(operations.length ? { syntheticOperations: operations } : {}) }, new Date(input.at)) : null
    if (!decision || decision.outcome !== 'allow') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Localization source authorization changed after enqueue')
  }

  async findRequestReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    const row = await this.prisma.v2LocalizationRun.findFirst({ where: { workspaceId: input.workspaceId, requestedByClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (hydrateBatchActorAudit(row, row.requestedByClientId).contextHash !== input.actorContextHash || row.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Localization run idempotency key belongs to another request or actor context')
    return hydrate(row)
  }

  async findPreflightReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    const row = await this.prisma.v2LocalizationTranslationPreflight.findFirst({ where: { workspaceId: input.workspaceId, requestedByClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (hydrateBatchActorAudit(row, row.requestedByClientId).contextHash !== input.actorContextHash || row.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Localization preflight idempotency key belongs to another request or actor context')
    return hydratePreflight(row)
  }

  async readPreflight(input: { workspaceId: string; projectId: string; variantId: string; preflightId: string }) {
    const row = await this.prisma.v2LocalizationTranslationPreflight.findFirst({ where: { id: input.preflightId, workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId } })
    return row ? hydratePreflight(row) : null
  }

  async createPreflight(input: Parameters<LocalizationRunRepository['createPreflight']>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.v2LocalizationTranslationPreflight.findFirst({ where: { workspaceId: input.preflight.workspaceId, requestedByClientId: input.preflight.requestedByClientId, idempotencyKey: input.idempotencyKey } })
      if (replay) {
        if (hydrateBatchActorAudit(replay, replay.requestedByClientId).contextHash !== input.authenticationAudit.contextHash || replay.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Localization preflight idempotency key belongs to another request or actor context')
        return Object.freeze({ preflight: hydratePreflight(replay), replayed: true })
      }
      const [head, canonical, actor] = await Promise.all([
        tx.v2LocalizationVariantHead.findFirst({ where: { id: input.preflight.variantId, workspaceId: input.preflight.workspaceId, projectId: input.preflight.projectId, currentRevision: input.preflight.variantRevision, currentVariantHash: input.preflight.variantHash, status: 'draft' } }),
        tx.v2LocalizationCanonicalScript.findFirst({ where: { id: input.preflight.canonicalScriptVersionId, workspaceId: input.preflight.workspaceId, projectId: input.preflight.projectId, contentHash: input.preflight.canonicalContentHash } }),
        tx.v2ApiClient.findFirst({ where: { id: input.preflight.requestedByClientId, workspaceId: input.preflight.workspaceId, status: 'active' } }),
      ])
      if (!head || !canonical) throw new DomainError('VERSION_CONFLICT', 'Localization authority changed before preflight persistence')
      if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Localization requester is inactive')
      const source = await tx.v2MediaArtifact.findFirst({ where: { id: head.sourceArtifactId, workspaceId: input.preflight.workspaceId, sha256: head.sourceSha256, currentRightsSnapshotId: head.sourceRightsSnapshotId, status: 'available' }, include: { currentRightsSnapshot: true } })
      const operations = input.preflight.mode === 'authorized-tts' ? ['tts'] : input.preflight.mode === 'lip-sync' ? ['lip-sync'] : input.preflight.mode === 'regenerated-avatar' ? ['audio-avatar'] : []
      const rightsDecision = source?.currentRightsSnapshot ? evaluateAssetUse(hydrateAssetRights(source.currentRightsSnapshot), { workspaceId: input.preflight.workspaceId, use: 'localization', locale: input.preflight.targetLocale, ...(input.preflight.market ? { market: input.preflight.market } : {}), ...(operations.length ? { syntheticOperations: operations } : {}) }, new Date(input.preflight.createdAt)) : null
      if (!rightsDecision || rightsDecision.outcome !== 'allow') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Localization source is not currently authorized for the requested locale, market, use and operation')
      const row = await tx.v2LocalizationTranslationPreflight.create({ data: { id: input.preflight.id, workspaceId: input.preflight.workspaceId, projectId: input.preflight.projectId, variantId: input.preflight.variantId, variantRevision: input.preflight.variantRevision, variantHash: input.preflight.variantHash, canonicalScriptVersionId: input.preflight.canonicalScriptVersionId, canonicalContentHash: input.preflight.canonicalContentHash, preflightJson: stableSerialize(input.preflight), preflightHash: input.preflight.preflightHash, costFingerprint: input.preflight.costFingerprint, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey, requestedByClientId: input.preflight.requestedByClientId, ...batchActorAuditData(input.authenticationAudit, input.preflight.workspaceId, input.preflight.requestedByClientId), createdAt: new Date(input.preflight.createdAt), expiresAt: new Date(input.preflight.expiresAt) } })
      return Object.freeze({ preflight: hydratePreflight(row), replayed: false })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async create(input: Parameters<LocalizationRunRepository['create']>[0]) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await tx.v2LocalizationRun.findFirst({ where: { workspaceId: input.run.workspaceId, requestedByClientId: input.run.requestedByClientId, idempotencyKey: input.idempotencyKey } })
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.requestedByClientId).contextHash !== input.authenticationAudit.contextHash || replay.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Localization run idempotency key belongs to another request or actor context')
          return Object.freeze({ run: hydrate(replay), replayed: true })
        }
        const [head, canonical, actor, preflight] = await Promise.all([
          tx.v2LocalizationVariantHead.findFirst({ where: { id: input.run.variantId, workspaceId: input.run.workspaceId, projectId: input.run.projectId, currentRevision: input.run.variantRevision, currentVariantHash: input.run.variantHash } }),
          tx.v2LocalizationCanonicalScript.findFirst({ where: { id: input.run.canonicalScriptVersionId, workspaceId: input.run.workspaceId, projectId: input.run.projectId, contentHash: input.run.canonicalContentHash }, select: { id: true } }),
          tx.v2ApiClient.findFirst({ where: { id: input.run.requestedByClientId, workspaceId: input.run.workspaceId, status: 'active' }, select: { id: true } }),
          tx.v2LocalizationTranslationPreflight.findFirst({ where: { id: input.preflightId, workspaceId: input.run.workspaceId, projectId: input.run.projectId, variantId: input.run.variantId, requestedByClientId: input.run.requestedByClientId, preflightHash: input.expectedPreflightHash, variantRevision: input.run.variantRevision, variantHash: input.run.variantHash, canonicalContentHash: input.run.canonicalContentHash, consumedAt: null, expiresAt: { gt: new Date(input.consumedAt) } } }),
        ])
        if (!head || head.status !== 'draft' || head.canonicalScriptVersionId !== input.run.canonicalScriptVersionId || !canonical) throw new DomainError('VERSION_CONFLICT', 'Localization request authority changed before persistence')
        if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Localization requester is inactive')
        if (!preflight || hydrateBatchActorAudit(preflight, preflight.requestedByClientId).contextHash !== input.authenticationAudit.contextHash) throw new DomainError('PREFLIGHT_TOKEN_STALE', 'Localization preflight is expired, consumed, or belongs to another actor context')
        const consumed = await tx.v2LocalizationTranslationPreflight.updateMany({ where: { id: preflight.id, consumedAt: null }, data: { consumedAt: new Date(input.consumedAt), consumedByRunId: input.run.id } })
        if (consumed.count !== 1) throw new DomainError('PREFLIGHT_TOKEN_STALE', 'Localization preflight was already consumed')
        const data = { id: input.run.id, workspaceId: input.run.workspaceId, projectId: input.run.projectId, variantId: input.run.variantId, variantRevision: input.run.variantRevision, variantHash: input.run.variantHash, canonicalScriptVersionId: input.run.canonicalScriptVersionId, canonicalContentHash: input.run.canonicalContentHash, status: input.run.status, attempt: input.run.attempt, runJson: stableSerialize(input.run), runHash: input.run.runHash, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey, requestedByClientId: input.run.requestedByClientId, preflightId: input.preflightId, ...batchActorAuditData(input.authenticationAudit, input.run.workspaceId, input.run.requestedByClientId), createdAt: new Date(input.run.createdAt), updatedAt: new Date(input.run.updatedAt) }
        const row = await tx.v2LocalizationRun.create({ data })
        await tx.v2LocalizationRunRevision.create({ data: { id: childRowId([input.run.workspaceId, input.run.id, '1'], 160), workspaceId: input.run.workspaceId, runId: input.run.id, revision: 1, status: input.run.status, runJson: stableSerialize(input.run), runHash: input.run.runHash, createdAt: new Date(input.run.createdAt) } })
        return Object.freeze({ run: hydrate(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) { if (typeof error === 'object' && error && 'code' in error && (error.code === 'P2002' || error.code === 'P2034')) throw new DomainError('PERSISTENCE_CONFLICT', 'Localization run request conflicted'); throw error }
  }

  async claim(input: { workerId: string; leaseTokenHash: string; now: string; leaseExpiresAt: string }) {
    return this.prisma.$transaction(async (tx) => {
      const ambiguous = await tx.v2LocalizationRun.findFirst({ where: { status: 'translating', leaseExpiresAt: { lte: new Date(input.now) } }, orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }] })
      if (ambiguous) {
        const previous = hydrate(ambiguous)
        const failed = failLocalizationTranslation(previous, { code: 'LEASE_EXPIRED_AMBIGUOUS', message: 'Translation lease expired after dispatch; reconcile provider state before retry', retryable: false }, input.now)
        const fenced = await tx.v2LocalizationRun.updateMany({ where: { id: ambiguous.id, workspaceId: ambiguous.workspaceId, status: 'translating', runHash: ambiguous.runHash, leaseExpiresAt: { lte: new Date(input.now) } }, data: { status: failed.status, runJson: stableSerialize(failed), runHash: failed.runHash, leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, heartbeatAt: new Date(input.now), updatedAt: new Date(input.now) } })
        if (fenced.count === 1) await tx.v2LocalizationRunRevision.create({ data: { id: childRowId([failed.workspaceId, failed.id, String(failed.attempt * 2 + 1)], 160), workspaceId: failed.workspaceId, runId: failed.id, revision: failed.attempt * 2 + 1, status: failed.status, runJson: stableSerialize(failed), runHash: failed.runHash, createdAt: new Date(input.now) } })
      }
      const candidate = await tx.v2LocalizationRun.findFirst({ where: { status: 'requested', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date(input.now) } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      if (!candidate) return null
      const current = hydrate(candidate), next = beginLocalizationTranslation(current, input.now)
      const authority = await tx.v2LocalizationVariantHead.findFirst({ where: { id: current.variantId, workspaceId: current.workspaceId, projectId: current.projectId, currentRevision: current.variantRevision, currentVariantHash: current.variantHash, canonicalScriptVersionId: current.canonicalScriptVersionId } })
      if (!authority) {
        const failed = failLocalizationTranslation(next, { code: 'VERSION_CONFLICT', message: 'Localization variant changed before worker claim', retryable: false }, input.now)
        await tx.v2LocalizationRun.update({ where: { id: current.id }, data: { status: failed.status, runJson: stableSerialize(failed), runHash: failed.runHash, leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, heartbeatAt: new Date(input.now), updatedAt: new Date(input.now) } })
        await tx.v2LocalizationRunRevision.create({ data: { id: childRowId([current.workspaceId, current.id, '2'], 160), workspaceId: current.workspaceId, runId: current.id, revision: 2, status: next.status, runJson: stableSerialize(next), runHash: next.runHash, createdAt: new Date(input.now) } })
        await tx.v2LocalizationRunRevision.create({ data: { id: childRowId([current.workspaceId, current.id, '3'], 160), workspaceId: current.workspaceId, runId: current.id, revision: 3, status: failed.status, runJson: stableSerialize(failed), runHash: failed.runHash, createdAt: new Date(input.now) } })
        return null
      }
      const changed = await tx.v2LocalizationRun.updateMany({ where: { id: current.id, workspaceId: current.workspaceId, status: 'requested', runHash: current.runHash, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date(input.now) } }] }, data: { status: next.status, attempt: next.attempt, runJson: stableSerialize(next), runHash: next.runHash, leaseOwner: input.workerId, leaseTokenHash: input.leaseTokenHash, leaseExpiresAt: new Date(input.leaseExpiresAt), heartbeatAt: new Date(input.now), updatedAt: new Date(input.now) } })
      if (changed.count !== 1) return null
      await tx.v2LocalizationRunRevision.create({ data: { id: childRowId([current.workspaceId, current.id, String(next.attempt * 2)], 160), workspaceId: current.workspaceId, runId: current.id, revision: next.attempt * 2, status: next.status, runJson: stableSerialize(next), runHash: next.runHash, createdAt: new Date(input.now) } })
      const [revision, canonicalRow] = await Promise.all([
        tx.v2LocalizationVariantRevision.findFirstOrThrow({ where: { variantId: current.variantId, workspaceId: current.workspaceId, revision: current.variantRevision } }),
        tx.v2LocalizationCanonicalScript.findFirstOrThrow({ where: { id: current.canonicalScriptVersionId, workspaceId: current.workspaceId, projectId: current.projectId } }),
      ])
      const localizationModule = await import('./localization-repository.ts')
      const helper = new localizationModule.PrismaLocalizationRepository(tx as unknown as PrismaClient)
      const variant = await helper.readVariant({ workspaceId: current.workspaceId, projectId: current.projectId, variantId: current.variantId })
      const canonical = await helper.readCanonical({ workspaceId: current.workspaceId, projectId: current.projectId, canonicalId: current.canonicalScriptVersionId })
      if (!variant || !canonical || revision.variantHash !== current.variantHash || canonicalRow.contentHash !== current.canonicalContentHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Localization claim dependencies failed integrity validation')
      const preflightRow = candidate.preflightId ? await tx.v2LocalizationTranslationPreflight.findFirst({ where: { id: candidate.preflightId, workspaceId: current.workspaceId, consumedByRunId: current.id } }) : null
      if (!preflightRow) throw new DomainError('PERSISTENCE_CONFLICT', 'Localization run lacks its consumed preflight')
      return Object.freeze({ run: next, variant, canonical, preflight: hydratePreflight(preflightRow) })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async settle(input: { previousRunHash: string; run: Readonly<LocalizationRun>; leaseTokenHash: string; settledAt: string }) {
    return this.prisma.$transaction(async (tx) => {
      if (input.run.status === 'awaiting-human-review') {
        const authority = await tx.v2LocalizationVariantHead.findFirst({ where: { id: input.run.variantId, workspaceId: input.run.workspaceId, projectId: input.run.projectId, currentRevision: input.run.variantRevision, currentVariantHash: input.run.variantHash, canonicalScriptVersionId: input.run.canonicalScriptVersionId } })
        if (!authority) throw new DomainError('VERSION_CONFLICT', 'Localization variant changed during translation')
        const [preflightRow, source] = await Promise.all([
          tx.v2LocalizationTranslationPreflight.findFirst({ where: { consumedByRunId: input.run.id, workspaceId: input.run.workspaceId } }),
          tx.v2MediaArtifact.findFirst({ where: { id: authority.sourceArtifactId, workspaceId: input.run.workspaceId, sha256: authority.sourceSha256, currentRightsSnapshotId: authority.sourceRightsSnapshotId, status: 'available' }, include: { currentRightsSnapshot: true } }),
        ])
        if (!preflightRow || !source?.currentRightsSnapshot) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Localization settlement authority is missing')
        const preflight = hydratePreflight(preflightRow), operations = preflight.mode === 'authorized-tts' ? ['tts'] : preflight.mode === 'lip-sync' ? ['lip-sync'] : preflight.mode === 'regenerated-avatar' ? ['audio-avatar'] : []
        const rightsDecision = evaluateAssetUse(hydrateAssetRights(source.currentRightsSnapshot), { workspaceId: input.run.workspaceId, use: 'localization', locale: preflight.targetLocale, ...(preflight.market ? { market: preflight.market } : {}), ...(operations.length ? { syntheticOperations: operations } : {}) }, new Date(input.settledAt))
        if (rightsDecision.outcome !== 'allow') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Localization source authorization changed before settlement')
        if (!input.run.translation) throw new DomainError('PERSISTENCE_CONFLICT', 'Awaiting-review run lacks translation evidence')
        const currentRow = await tx.v2LocalizationVariantRevision.findFirst({ where: { variantId: input.run.variantId, workspaceId: input.run.workspaceId, revision: input.run.variantRevision, variantHash: input.run.variantHash } })
        if (!currentRow) throw new DomainError('VERSION_CONFLICT', 'Localization source revision disappeared before translation settlement')
        const current = assertLocalizationVariantIntegrity(parse<LocalizationVariant>(currentRow.variantJson, 'localization variant revision'))
        const translated = transitionLocalizationVariant(current, 'translating', { stage: 'awaiting-human-translation-review', updatedAt: input.settledAt, localizedBlocks: input.run.translation.blocks, translationProvenance: { runId: input.run.id, runHash: input.run.runHash, translationHash: input.run.translation.translationHash, providerId: input.run.translation.providerId, adapterVersion: input.run.translation.adapterVersion, model: input.run.translation.model, configHash: input.run.translation.configHash } })
        const advanced = await tx.v2LocalizationVariantHead.updateMany({ where: { id: current.id, workspaceId: current.workspaceId, currentRevision: current.revision, currentVariantHash: current.variantHash, status: 'draft' }, data: { currentRevision: translated.revision, currentVariantHash: translated.variantHash, status: translated.status, updatedAt: new Date(input.settledAt) } })
        if (advanced.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Localization variant changed before translated draft persistence')
        await tx.v2LocalizationVariantRevision.create({ data: { id: childRowId([translated.workspaceId, translated.id, String(translated.revision)], 160), workspaceId: translated.workspaceId, variantId: translated.id, revision: translated.revision, canonicalScriptVersionId: translated.canonicalScriptVersionId, status: translated.status, stage: translated.stage, variantJson: stableSerialize(translated), variantHash: translated.variantHash, createdAt: new Date(input.settledAt) } })
      }
      const changed = await tx.v2LocalizationRun.updateMany({ where: { id: input.run.id, workspaceId: input.run.workspaceId, status: 'translating', runHash: input.previousRunHash, leaseTokenHash: input.leaseTokenHash, leaseExpiresAt: { gt: new Date(input.settledAt) } }, data: { status: input.run.status, runJson: stableSerialize(input.run), runHash: input.run.runHash, leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, heartbeatAt: new Date(input.settledAt), updatedAt: new Date(input.settledAt) } })
      if (changed.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Localization lease expired or was fenced before settlement')
      await tx.v2LocalizationRunRevision.create({ data: { id: childRowId([input.run.workspaceId, input.run.id, String(input.run.attempt * 2 + 1)], 160), workspaceId: input.run.workspaceId, runId: input.run.id, revision: input.run.attempt * 2 + 1, status: input.run.status, runJson: stableSerialize(input.run), runHash: input.run.runHash, createdAt: new Date(input.settledAt) } })
      return input.run
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }
}
