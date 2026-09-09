import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { LocalizationMutationRecord, LocalizationRepository, LocalizationSourceAuthority } from '../../application/ports/localization-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { assertLocalizationVariantIntegrity, createCanonicalScriptVersion, LOCALIZED_AUDIO_MODES, type CanonicalScriptVersion, type LocalizationVariant, type LocalizedAudioMode } from '../../domain/localization.ts'
import { hydrateScriptAlignmentRun } from '../../domain/script-alignment.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { batchActorAuditData, hydrateBatchActorAudit } from './batch-actor-audit.ts'
import { childRowId } from './child-row-id.ts'

function parse<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T } catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${label} is invalid JSON`) }
}
function prismaCode(error: unknown, code: string) { return typeof error === 'object' && error !== null && 'code' in error && error.code === code }
function hydrateCanonical(row: { snapshotJson: string; contentHash: string; alignmentRunHash: string }) {
  const raw = parse<CanonicalScriptVersion>(row.snapshotJson, 'canonical localization')
  const { contentHash: _contentHash, blocks, ...identity } = raw
  const canonical = createCanonicalScriptVersion({ ...identity, blocks: blocks.map(({ blockHash: _hash, ...block }) => block) })
  if (canonical.contentHash !== row.contentHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Canonical localization hash is inconsistent')
  return canonical
}
function hydrateVariant(row: { variantJson: string; variantHash: string }) {
  const variant = parse<LocalizationVariant>(row.variantJson, 'localization variant revision')
  if (variant.variantHash !== row.variantHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Localization variant hash is inconsistent')
  return assertLocalizationVariantIntegrity(Object.freeze(variant))
}
function rightsAllowedModes(json: string | null): readonly LocalizedAudioMode[] {
  const values = json ? parse<string[]>(json, 'rights synthetic operations') : []
  const modes: LocalizedAudioMode[] = ['uploaded', 'local-voice', 'subtitles-only']
  if (values.includes('tts')) modes.push('authorized-tts')
  if (values.includes('audio-avatar')) modes.push('regenerated-avatar')
  return Object.freeze(modes.filter((value) => LOCALIZED_AUDIO_MODES.includes(value)))
}
function profileAllowedModes(json: string): readonly LocalizedAudioMode[] {
  const values = parse<string[]>(json, 'localization profile modes')
  if (!values.length || new Set(values).size !== values.length || values.some((value) => !LOCALIZED_AUDIO_MODES.includes(value as LocalizedAudioMode))) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored localization profile modes are invalid')
  return Object.freeze(values as LocalizedAudioMode[])
}
function hydrateProfile(row: { id: string; workspaceId: string; targetLocale: string; market: string | null; allowedModesJson: string; snapshotJson: string; profileHash: string }) {
  const snapshot = parse<{ id: string; workspaceId: string; targetLocale: string; market?: string; allowedModes: readonly LocalizedAudioMode[]; profileHash: string }>(row.snapshotJson, 'localization profile')
  const { profileHash, ...body } = snapshot
  const modes = profileAllowedModes(row.allowedModesJson)
  if (calculateCanonicalHash(body) !== profileHash || profileHash !== row.profileHash || snapshot.id !== row.id || snapshot.workspaceId !== row.workspaceId || snapshot.targetLocale !== row.targetLocale || (snapshot.market ?? null) !== row.market || stableSerialize(snapshot.allowedModes) !== stableSerialize(modes)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored localization profile projection or hash is inconsistent')
  return Object.freeze({ ...snapshot, allowedModes: modes })
}
function assertAlignmentBelongsToVersion(run: ReturnType<typeof hydrateScriptAlignmentRun>, contentJson: string) {
  const plan = parse<{ sources?: readonly { artifactId?: unknown }[] }>(contentJson, 'project version edit plan')
  const versionArtifacts = new Set((plan.sources ?? []).map((source) => source.artifactId).filter((id): id is string => typeof id === 'string'))
  if (!versionArtifacts.size || run.sourceRefs.some((source) => !versionArtifacts.has(source.sourceArtifactId))) throw new DomainError('VERSION_CONFLICT', 'Script alignment sources do not belong to the selected project version')
}

export class PrismaLocalizationRepository implements LocalizationRepository {
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient = getV2PostgresClient()) { this.prisma = prisma }

  async findProfileReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    const row = await this.prisma.v2LocalizationProfile.findFirst({ where: { workspaceId: input.workspaceId, createdByClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (hydrateBatchActorAudit(row, row.createdByClientId).contextHash !== input.actorContextHash || row.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Profile idempotency key belongs to another request or actor context')
    return hydrateProfile(row)
  }

  async insertProfile(input: Parameters<LocalizationRepository['insertProfile']>[0]) {
    const replay = await this.findProfileReplay({ workspaceId: input.profile.workspaceId, actorClientId: input.actorClientId, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint })
    if (replay) return Object.freeze({ profile: replay, replayed: true })
    const actor = await this.prisma.v2ApiClient.findFirst({ where: { id: input.actorClientId, workspaceId: input.profile.workspaceId, status: 'active' }, select: { id: true } })
    if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Localization profile actor is inactive')
    try {
      const row = await this.prisma.v2LocalizationProfile.create({ data: { id: input.profile.id, workspaceId: input.profile.workspaceId, targetLocale: input.profile.targetLocale, market: input.profile.market, allowedModesJson: stableSerialize(input.profile.allowedModes), snapshotJson: stableSerialize(input.profile), profileHash: input.profile.profileHash, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey, createdByClientId: input.actorClientId, ...batchActorAuditData(input.authenticationAudit, input.profile.workspaceId, input.actorClientId), createdAt: new Date(input.createdAt) } })
      return Object.freeze({ profile: hydrateProfile(row), replayed: false })
    } catch (error) {
      if (prismaCode(error, 'P2002')) {
        const raced = await this.findProfileReplay({ workspaceId: input.profile.workspaceId, actorClientId: input.actorClientId, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint })
        if (raced) return Object.freeze({ profile: raced, replayed: true })
      }
      throw error
    }
  }

  async findCanonicalReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    const row = await this.prisma.v2LocalizationCanonicalScript.findFirst({ where: { workspaceId: input.workspaceId, approvedByClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!row) return null
    if (hydrateBatchActorAudit(row, row.approvedByClientId).contextHash !== input.actorContextHash || row.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Canonical idempotency key belongs to another request or actor context')
    return hydrateCanonical(row)
  }

  async findVariantReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    return this.findActionReplay(input)
  }

  async findMutationReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    return this.findActionReplay(input)
  }

  private async findActionReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }) {
    const action = await this.prisma.v2LocalizationVariantAction.findFirst({ where: { workspaceId: input.workspaceId, actorClientId: input.actorClientId, idempotencyKey: input.idempotencyKey } })
    if (!action) return null
    if (hydrateBatchActorAudit(action, action.actorClientId).contextHash !== input.actorContextHash || action.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Localization idempotency key belongs to another request or actor context')
    const revision = await this.prisma.v2LocalizationVariantRevision.findFirst({ where: { variantId: action.variantId, workspaceId: action.workspaceId, revision: action.resultRevision } })
    if (!revision || revision.variantHash !== action.resultVariantHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Localization replay does not address an immutable revision')
    return hydrateVariant(revision)
  }

  async loadCanonicalContext(input: { workspaceId: string; projectId: string; projectVersionId: string; alignmentId: string; expectedAlignmentHash: string; actorClientId: string }) {
    const [alignment, version, actor] = await Promise.all([
      this.prisma.v2ScriptAlignmentRun.findFirst({ where: { id: input.alignmentId, workspaceId: input.workspaceId, projectId: input.projectId } }),
      this.prisma.v2ProjectVersion.findFirst({ where: { id: input.projectVersionId, workspaceId: input.workspaceId, projectId: input.projectId }, select: { id: true, editPlanSnapshot: { select: { contentJson: true } } } }),
      this.prisma.v2ApiClient.findFirst({ where: { id: input.actorClientId, workspaceId: input.workspaceId, status: 'active' }, select: { id: true } }),
    ])
    if (!alignment || !version) throw new DomainError('SCRIPT_ALIGNMENT_NOT_FOUND', 'Reviewed alignment or project version was not found')
    if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Canonical reviewer is inactive or outside the workspace')
    const run = hydrateScriptAlignmentRun(parse(alignment.resultJson, 'script alignment result'))
    if (run.runHash !== alignment.runHash || run.runHash !== input.expectedAlignmentHash || run.status !== 'reviewed' || run.summary.reviewRequiredCount !== 0) throw new DomainError('VERSION_CONFLICT', 'Canonical source is stale or not an intact reviewed alignment')
    assertAlignmentBelongsToVersion(run, version.editPlanSnapshot.contentJson)
    return Object.freeze({ alignment: run, projectVersionId: version.id })
  }

  async insertCanonical(input: Parameters<LocalizationRepository['insertCanonical']>[0]) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await tx.v2LocalizationCanonicalScript.findFirst({ where: { workspaceId: input.canonical.workspaceId, approvedByClientId: input.canonical.approvedByClientId, idempotencyKey: input.idempotencyKey } })
        if (replay) {
          if (hydrateBatchActorAudit(replay, replay.approvedByClientId).contextHash !== input.authenticationAudit.contextHash || replay.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Canonical idempotency key belongs to another request or actor context')
          return Object.freeze({ canonical: hydrateCanonical(replay), replayed: true })
        }
        const [alignment, version, actor] = await Promise.all([
          tx.v2ScriptAlignmentRun.findFirst({ where: { id: input.canonical.blocks[0]?.sourceAlignmentId, workspaceId: input.canonical.workspaceId, projectId: input.canonical.projectId } }),
          tx.v2ProjectVersion.findFirst({ where: { id: input.canonical.projectVersionId, workspaceId: input.canonical.workspaceId, projectId: input.canonical.projectId }, select: { id: true, editPlanSnapshot: { select: { contentJson: true } } } }),
          tx.v2ApiClient.findFirst({ where: { id: input.canonical.approvedByClientId, workspaceId: input.canonical.workspaceId, status: 'active' }, select: { id: true } }),
        ])
        if (!alignment || alignment.runHash !== input.alignmentRunHash || alignment.status !== 'reviewed' || alignment.reviewRequiredCount !== 0 || !version || !actor) throw new DomainError('PRECONDITION_REQUIRED', 'Canonical source authority changed before persistence')
        assertAlignmentBelongsToVersion(hydrateScriptAlignmentRun(parse(alignment.resultJson, 'script alignment result')), version.editPlanSnapshot.contentJson)
        const row = await tx.v2LocalizationCanonicalScript.create({ data: {
          id: input.canonical.id, workspaceId: input.canonical.workspaceId, projectId: input.canonical.projectId,
          projectVersionId: input.canonical.projectVersionId, alignmentId: alignment.id, alignmentRunHash: input.alignmentRunHash,
          sourceLocale: input.canonical.sourceLocale, revision: input.canonical.revision, snapshotJson: stableSerialize(input.canonical),
          contentHash: input.canonical.contentHash, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey,
          approvedByClientId: input.canonical.approvedByClientId, ...batchActorAuditData(input.authenticationAudit, input.canonical.workspaceId, input.canonical.approvedByClientId), approvedAt: new Date(input.canonical.approvedAt),
        } })
        return Object.freeze({ canonical: hydrateCanonical(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) { if (prismaCode(error, 'P2002') || prismaCode(error, 'P2034')) throw new DomainError('PERSISTENCE_CONFLICT', 'Canonical localization creation conflicted'); throw error }
  }

  async readCanonical(input: { workspaceId: string; projectId: string; canonicalId: string }) {
    const row = await this.prisma.v2LocalizationCanonicalScript.findFirst({ where: { id: input.canonicalId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrateCanonical(row) : null
  }

  async loadVariantCreationContext(input: { workspaceId: string; projectId: string; canonicalId: string; profileId: string; sourceArtifactId: string; expectedSourceSha256: string; preferredMode: LocalizedAudioMode; actorClientId: string }) {
    const [canonicalRow, profile, source, actor] = await Promise.all([
      this.prisma.v2LocalizationCanonicalScript.findFirst({ where: { id: input.canonicalId, workspaceId: input.workspaceId, projectId: input.projectId } }),
      this.prisma.v2LocalizationProfile.findFirst({ where: { id: input.profileId, workspaceId: input.workspaceId } }),
      this.prisma.v2MediaArtifact.findFirst({ where: { id: input.sourceArtifactId, workspaceId: input.workspaceId }, include: { currentRightsSnapshot: true } }),
      this.prisma.v2ApiClient.findFirst({ where: { id: input.actorClientId, workspaceId: input.workspaceId, status: 'active' }, select: { id: true } }),
    ])
    if (!canonicalRow) throw new DomainError('LOCALIZATION_CANONICAL_NOT_FOUND', 'Canonical localization was not found')
    if (!profile) throw new DomainError('LOCALIZATION_PROFILE_NOT_FOUND', 'Localization profile was not found')
    if (!source) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Localization source artifact was not found')
    if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Localization actor is inactive or outside the workspace')
    const canonical = hydrateCanonical(canonicalRow)
    const version = await this.prisma.v2ProjectVersion.findFirst({ where: { id: canonical.projectVersionId, workspaceId: input.workspaceId, projectId: input.projectId }, include: { editPlanSnapshot: true } })
    if (!version) throw new DomainError('VERSION_CONFLICT', 'Canonical project version is no longer authoritative')
    const plan = parse<{ sources?: readonly { artifactId?: unknown }[] }>(version.editPlanSnapshot.contentJson, 'canonical project edit plan')
    if (!(plan.sources ?? []).some((entry) => entry.artifactId === input.sourceArtifactId)) throw new DomainError('VERSION_CONFLICT', 'Localization source does not belong to the canonical project version')
    const rights = source.currentRightsSnapshot
    if (source.status !== 'available' || source.sha256 !== input.expectedSourceSha256 || !rights || rights.status !== 'approved' || !['approved', 'not-required'].includes(rights.consentStatus) || (rights.expiresAt && rights.expiresAt <= new Date()) || (rights.consentExpiresAt && rights.consentExpiresAt <= new Date())) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Localization source lacks current persisted rights')
    const syntheticOperations = input.preferredMode === 'authorized-tts' ? ['tts'] : input.preferredMode === 'lip-sync' ? ['lip-sync'] : input.preferredMode === 'regenerated-avatar' ? ['audio-avatar'] : []
    const decision = evaluateAssetUse(hydrateAssetRights(rights), { workspaceId: input.workspaceId, use: 'localization', locale: profile.targetLocale, ...(profile.market ? { market: profile.market } : {}), ...(syntheticOperations.length ? { syntheticOperations } : {}) }, new Date())
    if (decision.outcome !== 'allow') throw new DomainError('ASSET_RIGHTS_BLOCKED', `Localization source rights deny requested use: ${decision.reasonCodes.join(',')}`)
    const sourceAuthority: LocalizationSourceAuthority = { artifactId: source.id, sha256: source.sha256, rightsSnapshotId: rights.id, allowedModes: rightsAllowedModes(rights.allowedSyntheticOperationsJson) }
    return Object.freeze({ canonical: hydrateCanonical(canonicalRow), profile: hydrateProfile(profile), source: Object.freeze(sourceAuthority) })
  }

  async insertVariant(input: Parameters<LocalizationRepository['insertVariant']>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.v2LocalizationVariantAction.findFirst({ where: { workspaceId: input.variant.workspaceId, actorClientId: input.variant.createdByClientId, idempotencyKey: input.idempotencyKey } })
      if (replay) {
        if (hydrateBatchActorAudit(replay, replay.actorClientId).contextHash !== input.authenticationAudit.contextHash || replay.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Variant idempotency key belongs to another request or actor context')
        const revision = await tx.v2LocalizationVariantRevision.findFirstOrThrow({ where: { variantId: replay.variantId, revision: replay.resultRevision } })
        return Object.freeze({ variant: hydrateVariant(revision), replayed: true })
      }
      const authority = await tx.v2MediaArtifact.findFirst({ where: { id: input.source.artifactId, workspaceId: input.variant.workspaceId, sha256: input.source.sha256, status: 'available', currentRightsSnapshotId: input.source.rightsSnapshotId }, include: { currentRightsSnapshot: true } })
      if (!authority?.currentRightsSnapshot || authority.currentRightsSnapshot.status !== 'approved') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Localization source rights changed before persistence')
      await tx.v2LocalizationVariantHead.create({ data: { id: input.variant.id, workspaceId: input.variant.workspaceId, projectId: input.variant.projectId, canonicalScriptVersionId: input.variant.canonicalScriptVersionId, profileId: input.profileId, sourceArtifactId: input.source.artifactId, sourceSha256: input.source.sha256, sourceRightsSnapshotId: input.source.rightsSnapshotId, currentRevision: 1, currentVariantHash: input.variant.variantHash, status: input.variant.status, createdByClientId: input.variant.createdByClientId, createdAt: new Date(input.variant.createdAt), updatedAt: new Date(input.variant.updatedAt) } })
      await tx.v2LocalizationVariantRevision.create({ data: { id: childRowId([input.variant.workspaceId, input.variant.id, '1'], 160), workspaceId: input.variant.workspaceId, variantId: input.variant.id, revision: 1, canonicalScriptVersionId: input.variant.canonicalScriptVersionId, status: input.variant.status, stage: input.variant.stage, variantJson: stableSerialize(input.variant), variantHash: input.variant.variantHash, createdAt: new Date(input.variant.createdAt) } })
      await tx.v2LocalizationVariantAction.create({ data: { id: childRowId([input.variant.workspaceId, input.variant.id, 'create', input.idempotencyKey], 160), workspaceId: input.variant.workspaceId, variantId: input.variant.id, action: 'create', expectedRevision: 0, resultRevision: 1, resultVariantHash: input.variant.variantHash, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey, actorClientId: input.variant.createdByClientId, ...batchActorAuditData(input.authenticationAudit, input.variant.workspaceId, input.variant.createdByClientId), createdAt: new Date(input.variant.createdAt) } })
      return Object.freeze({ variant: input.variant, replayed: false })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async readVariant(input: { workspaceId: string; projectId: string; variantId: string }) {
    const head = await this.prisma.v2LocalizationVariantHead.findFirst({ where: { id: input.variantId, workspaceId: input.workspaceId, projectId: input.projectId } })
    if (!head) return null
    const revision = await this.prisma.v2LocalizationVariantRevision.findFirst({ where: { variantId: head.id, workspaceId: head.workspaceId, revision: head.currentRevision } })
    if (!revision || revision.variantHash !== head.currentVariantHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Localization head does not address its immutable revision')
    return hydrateVariant(revision)
  }

  async appendVariantRevision(record: Readonly<LocalizationMutationRecord>) {
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.v2LocalizationVariantAction.findFirst({ where: { workspaceId: record.next.workspaceId, actorClientId: record.authenticationAudit.clientId, idempotencyKey: record.idempotencyKey } })
      if (replay) {
        if (hydrateBatchActorAudit(replay, replay.actorClientId).contextHash !== record.authenticationAudit.contextHash || replay.requestFingerprint !== record.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Action idempotency key belongs to another request or actor context')
        const revision = await tx.v2LocalizationVariantRevision.findFirstOrThrow({ where: { variantId: replay.variantId, revision: replay.resultRevision } })
        return Object.freeze({ variant: hydrateVariant(revision), replayed: true })
      }
      const actor = await tx.v2ApiClient.findFirst({ where: { id: record.authenticationAudit.clientId, workspaceId: record.next.workspaceId, status: 'active' }, select: { id: true } })
      if (!actor) throw new DomainError('API_CLIENT_NOT_FOUND', 'Localization actor is inactive')
      if (record.next.status === 'approved') throw new DomainError('PRECONDITION_REQUIRED', 'Localization approval requires the durable worker evidence projection, which is not implemented in this persistence slice')
      const changed = await tx.v2LocalizationVariantHead.updateMany({ where: { id: record.previous.id, workspaceId: record.previous.workspaceId, currentRevision: record.previous.revision, currentVariantHash: record.previous.variantHash }, data: { canonicalScriptVersionId: record.next.canonicalScriptVersionId, currentRevision: record.next.revision, currentVariantHash: record.next.variantHash, status: record.next.status, updatedAt: new Date(record.next.updatedAt) } })
      if (changed.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Localization variant changed before persistence')
      await tx.v2LocalizationVariantRevision.create({ data: { id: childRowId([record.next.workspaceId, record.next.id, String(record.next.revision)], 160), workspaceId: record.next.workspaceId, variantId: record.next.id, revision: record.next.revision, canonicalScriptVersionId: record.next.canonicalScriptVersionId, localizedAudioAssetId: record.next.localizedAudioAssetId, status: record.next.status, stage: record.next.stage, variantJson: stableSerialize(record.next), variantHash: record.next.variantHash, createdAt: new Date(record.next.updatedAt) } })
      await tx.v2LocalizationVariantAction.create({ data: { id: childRowId([record.next.workspaceId, record.next.id, record.action, record.idempotencyKey], 160), workspaceId: record.next.workspaceId, variantId: record.next.id, action: record.action, expectedRevision: record.previous.revision, resultRevision: record.next.revision, resultVariantHash: record.next.variantHash, requestFingerprint: record.requestFingerprint, idempotencyKey: record.idempotencyKey, actorClientId: record.authenticationAudit.clientId, ...batchActorAuditData(record.authenticationAudit, record.next.workspaceId, record.authenticationAudit.clientId), createdAt: new Date(record.next.updatedAt) } })
      return Object.freeze({ variant: record.next, replayed: false })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

}
