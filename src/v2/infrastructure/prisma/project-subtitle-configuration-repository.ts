import { Prisma, type PrismaClient, type V2ProjectVersion } from '../../../../generated/prisma-v2/index.js'
import type { ProjectSubtitleConfigurationRepository, ProjectSubtitleConfigurationResult } from '../../application/ports/project-subtitle-configuration-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProjectSubtitleConfiguration, parseProjectSubtitleConfigurationImpact, type ProjectSubtitleConfiguration } from '../../domain/project-subtitle-configuration.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { renderOutputReferences } from '../../domain/output-variant-references.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import { SUBTITLE_PRESETS, validateSubtitlePreset, type SubtitleModeRequest, type SubtitlePresetId } from '../../domain/subtitle-system.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { reconcileAfterConflict } from './idempotency-record-persistence.ts'

const include = Prisma.validator<Prisma.V2ProjectSubtitleConfigurationInclude>()({ command: true, resultVersion: true })
type Stored = Prisma.V2ProjectSubtitleConfigurationGetPayload<{ include: typeof include }>

function parse(value: string, field: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error(); return parsed as Record<string, unknown> }
  catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`) }
}
function version(row: V2ProjectVersion) {
  return hydrateProjectVersionRowV3(row)
}

/** Rebuilds the stored configuration through its own constructor: a hand-edited row cannot survive. */
function configurationOf(row: Pick<Stored, 'configurationJson' | 'configurationHash' | 'workspaceId' | 'projectId' | 'variantId' | 'requestedMode' | 'resolvedPresetId' | 'resolvedPresetHash' | 'origin' | 'transcriptHash' | 'workspaceDefaultRevision' | 'action' | 'previousConfigurationId'>): Readonly<ProjectSubtitleConfiguration> {
  const raw = parse(row.configurationJson, 'subtitle configuration') as unknown as ProjectSubtitleConfiguration
  const configuration = createProjectSubtitleConfiguration({ id: raw.id, workspaceId: raw.workspaceId, projectId: raw.projectId, baseVersionId: raw.baseVersionId, resultVersionId: raw.resultVersionId, commandId: raw.commandId, variantId: raw.variantId, action: raw.action, previousConfigurationId: raw.previousConfigurationId, requested: raw.requested, resolved: raw.resolved, origin: raw.origin, transcriptHash: raw.transcriptHash, ...(raw.workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision: raw.workspaceDefaultRevision } : {}), createdAt: raw.createdAt })
  if (
    configuration.configurationHash !== row.configurationHash
    || stableSerialize(configuration) !== row.configurationJson
    || configuration.workspaceId !== row.workspaceId
    || configuration.projectId !== row.projectId
    || configuration.variantId !== row.variantId
    || configuration.action !== row.action
    || configuration.previousConfigurationId !== row.previousConfigurationId
    || row.requestedMode !== configuration.requested.mode
    || row.resolvedPresetId !== (configuration.resolved.enabled ? configuration.resolved.presetId : null)
    || row.resolvedPresetHash !== (configuration.resolved.enabled ? configuration.resolved.presetHash : null)
    || row.origin !== configuration.origin
    || row.transcriptHash !== configuration.transcriptHash
    || row.workspaceDefaultRevision !== (configuration.workspaceDefaultRevision ?? null)
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle configuration lineage is invalid')
  return configuration
}

function hydrate(row: Stored, replayed: boolean): Readonly<ProjectSubtitleConfigurationResult> {
  const configuration = configurationOf(row)
  const impact = parseProjectSubtitleConfigurationImpact(parse(row.impactJson, 'subtitle configuration impact'))
  const commandRow = row.command
  const payload = parse(commandRow.payloadJson, 'subtitle command payload') as unknown as ProjectSubtitleConfigurationResult['command']['payload']
  const command = createEditCommand({ id: commandRow.id, workspaceId: commandRow.workspaceId, projectId: commandRow.projectId, baseVersionId: commandRow.baseVersionId, baseHash: commandRow.baseHash, author: { type: commandRow.actorType as 'api-client', id: commandRow.actorId, ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}) }, type: requireEditCommandType(commandRow.type), scope: parse(commandRow.scopeJson, 'subtitle command scope') as EditScope, payload, ...(commandRow.reason ? { reason: commandRow.reason } : {}), idempotencyKey: commandRow.idempotencyKey, createdAt: commandRow.createdAt.toISOString() })
  const resultVersion = version(row.resultVersion)
  if (commandRow.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle command seal is invalid')
  if (
    impact.impactHash !== row.impactHash
    || stableSerialize(impact) !== row.impactJson
    || impact.configurationHash !== configuration.configurationHash
    || impact.transcriptHash !== configuration.transcriptHash
    || command.type !== 'set-project-subtitle-mode'
    || payload.impact.impactHash !== impact.impactHash
    || payload.action !== configuration.action
    || resultVersion.id !== configuration.resultVersionId
    || command.id !== configuration.commandId
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle configuration lineage is invalid')
  return Object.freeze({ command, version: resultVersion, configuration, impact, replayed })
}

function readWorkspaceDefault(policies: Record<string, unknown>): { presetId: SubtitlePresetId; revision: number } | undefined {
  const raw = policies.subtitleDefault
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace subtitle default reference is invalid')
  const value = raw as Record<string, unknown>
  if (value.presetVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.presetId !== 'string') throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace subtitle default reference is invalid')
  validateSubtitlePreset(SUBTITLE_PRESETS[value.presetId as SubtitlePresetId])
  return { presetId: value.presetId as SubtitlePresetId, revision: Number(value.revision) }
}

export class PrismaProjectSubtitleConfigurationRepository implements ProjectSubtitleConfigurationRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}
  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const command = await this.client.v2EditCommand.findUnique({ where: { workspaceId_projectId_idempotencyKey: input }, select: { id: true, requestFingerprint: true } })
    if (!command) return null
    const row = await this.client.v2ProjectSubtitleConfiguration.findUnique({ where: { commandId_workspaceId: { commandId: command.id, workspaceId: input.workspaceId } }, include })
    if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent subtitle configuration disappeared')
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrate(row, true) })
  }
  /** Head configuration of one variant plus the configuration it replaced. Both queries carry workspaceId. */
  private async readHeadChain(input: { workspaceId: string; projectId: string; variantId: string }) {
    const head = await this.client.v2ProjectSubtitleConfigurationHead.findUnique({ where: { projectId_workspaceId_variantId: input } })
    if (!head) return { currentConfiguration: null, previousConfiguration: null, currentRow: null }
    const currentRow = await this.client.v2ProjectSubtitleConfiguration.findUnique({ where: { id_workspaceId: { id: head.configurationId, workspaceId: input.workspaceId } }, include })
    if (!currentRow || currentRow.projectId !== input.projectId || currentRow.variantId !== input.variantId) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle configuration head is invalid')
    const currentConfiguration = configurationOf(currentRow)
    if (!currentConfiguration.previousConfigurationId) return { currentConfiguration, previousConfiguration: null, currentRow }
    const previousRow = await this.client.v2ProjectSubtitleConfiguration.findUnique({ where: { id_workspaceId: { id: currentConfiguration.previousConfigurationId, workspaceId: input.workspaceId } } })
    if (!previousRow || previousRow.projectId !== input.projectId || previousRow.variantId !== input.variantId) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle configuration lineage is broken')
    return { currentConfiguration, previousConfiguration: configurationOf(previousRow), currentRow }
  }
  async readContext(input: { workspaceId: string; projectId: string; variantId: string; requested?: SubtitleModeRequest }) {
    const project = await this.client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, include: { currentVersion: { include: { policiesSnapshot: true } } } })
    if (!project?.currentVersion) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersion.id })
    if (!parent) return null
    const currentVersionId = parent.version.id
    const editPlan = parse(operationalBundlePlanV3(parent).contentJson, 'subtitle EditPlan')
    const policies = parse(project.currentVersion.policiesSnapshot.contentJson, 'subtitle policies')
    const transcript = editPlan.retimedTranscript ?? editPlan.transcript
    const tracks = editPlan.subtitleTracks
    const directorPresetId = Array.isArray(tracks) && typeof (tracks[0] as Record<string, unknown> | undefined)?.presetId === 'string' ? String((tracks[0] as Record<string, unknown>).presetId) : 'clean-color'
    validateSubtitlePreset(SUBTITLE_PRESETS[directorPresetId as SubtitlePresetId])
    const durationFrames = Number(editPlan.durationFrames)
    if (transcript === undefined || !Number.isSafeInteger(durationFrames) || durationFrames < 0) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle render context is incomplete')
    const [proxy, final, chain] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({ where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded', phase: 'completed' } }, select: { outputArtifactId: true, outputVariantId: true } }),
      this.client.v2ProjectFinalExportOperation.findMany({ where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded', phase: 'completed' } }, select: { outputArtifactId: true, outputVariantId: true, outputAspectRatio: true } }),
      this.readHeadChain({ workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId }),
    ])
    const workspaceDefault = readWorkspaceDefault(policies)
    if (input.requested?.mode === 'workspace-default' && !workspaceDefault) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace subtitle default is not configured with an immutable version')
    return Object.freeze({ parent, transcript, directorPresetId: directorPresetId as SubtitlePresetId, ...(workspaceDefault ? { workspaceDefault } : {}), durationFrames, outputReferences: renderOutputReferences({ state: parent.state, sourceVersionId: currentVersionId, proxies: proxy, finals: final }), currentConfiguration: chain.currentConfiguration, previousConfiguration: chain.previousConfiguration })
  }
  async readCurrent(input: { workspaceId: string; projectId: string; variantId: string }) {
    const chain = await this.readHeadChain(input)
    return chain.currentRow ? hydrate(chain.currentRow, false) : null
  }
  async commitOrReplay(input: Parameters<ProjectSubtitleConfigurationRepository['commitOrReplay']>[0], attempt = 1): Promise<Readonly<ProjectSubtitleConfigurationResult>> {
    const sealed = childCommandOf<ProjectSubtitleConfigurationResult['command']['payload']>(input.bundle)
    const command = sealed.command, requestFingerprint = sealed.requestFingerprint, version = input.bundle.version
    if (
      command.type !== 'set-project-subtitle-mode' || version.commandId !== command.id || input.configuration.commandId !== command.id ||
      input.configuration.resultVersionId !== version.id || input.configuration.baseVersionId !== command.baseVersionId ||
      input.configuration.workspaceId !== command.workspaceId || input.configuration.projectId !== command.projectId ||
      version.parentVersionId !== command.baseVersionId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle configuration does not belong to the Command that produced its Version')
    try {
      return await this.client.$transaction(async tx => {
        const project = await tx.v2Project.findFirst({ where: { id: command.projectId, workspaceId: command.workspaceId }, include: { currentVersion: true } })
        if (!project?.currentVersion || project.currentVersion.id !== command.baseVersionId || project.currentVersion.baseHash !== command.baseHash || version.sequence !== project.currentVersion.sequence + 1 || input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash) throw new DomainError('VERSION_CONFLICT', 'Project changed before subtitle configuration commit')
        const head = await tx.v2ProjectSubtitleConfigurationHead.findUnique({ where: { projectId_workspaceId_variantId: { projectId: input.configuration.projectId, workspaceId: input.configuration.workspaceId, variantId: input.configuration.variantId } } })
        if ((head?.configurationId ?? null) !== input.configuration.previousConfigurationId) throw new DomainError('VERSION_CONFLICT', 'Subtitle configuration head changed before commit')
        await commitProjectVersionWithOutputState(tx, input.bundle)
        await tx.v2ProjectSubtitleConfiguration.create({ data: { id: input.configuration.id, workspaceId: input.configuration.workspaceId, projectId: input.configuration.projectId, commandId: input.configuration.commandId, baseVersionId: input.configuration.baseVersionId, resultVersionId: input.configuration.resultVersionId, variantId: input.configuration.variantId, action: input.configuration.action, previousConfigurationId: input.configuration.previousConfigurationId, requestedMode: input.configuration.requested.mode, resolvedPresetId: input.configuration.resolved.enabled ? input.configuration.resolved.presetId : null, resolvedPresetHash: input.configuration.resolved.enabled ? input.configuration.resolved.presetHash : null, origin: input.configuration.origin, transcriptHash: input.configuration.transcriptHash, workspaceDefaultRevision: input.configuration.workspaceDefaultRevision, configurationJson: stableSerialize(input.configuration), configurationHash: input.configuration.configurationHash, impactJson: stableSerialize(input.impact), impactHash: input.impact.impactHash, createdAt: new Date(input.configuration.createdAt) } })
        await tx.v2ProjectSubtitleConfigurationHead.upsert({ where: { projectId_workspaceId_variantId: { projectId: input.configuration.projectId, workspaceId: input.configuration.workspaceId, variantId: input.configuration.variantId } }, create: { projectId: input.configuration.projectId, workspaceId: input.configuration.workspaceId, variantId: input.configuration.variantId, configurationId: input.configuration.id, updatedAt: new Date(input.configuration.createdAt) }, update: { configurationId: input.configuration.id, updatedAt: new Date(input.configuration.createdAt) } })
        const updated = await tx.v2Project.updateMany({ where: { id: command.projectId, workspaceId: command.workspaceId, currentVersionId: command.baseVersionId }, data: { currentVersionId: version.id } }); if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project changed during subtitle configuration commit')
        await settleDeferredOutputGuards(tx)
        return hydrate(await tx.v2ProjectSubtitleConfiguration.findUniqueOrThrow({ where: { id_workspaceId: { id: input.configuration.id, workspaceId: input.configuration.workspaceId } }, include }), false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) return this.commitOrReplay(input, attempt + 1)
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) { const replay = await reconcileAfterConflict(error, () => this.findIdempotent({ workspaceId: command.workspaceId, projectId: command.projectId, idempotencyKey: command.idempotencyKey })); if (replay?.requestFingerprint === requestFingerprint) return replay.result; if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was reused with another subtitle configuration') }
      throw error
    }
  }
}
