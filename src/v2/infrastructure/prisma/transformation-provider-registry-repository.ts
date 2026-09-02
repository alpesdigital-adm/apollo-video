import {
  Prisma,
  type PrismaClient,
  type V2TransformationBrief,
  type V2TransformationProviderCapability,
  type V2TransformationProviderDefinition,
  type V2TransformationProviderHealth,
  type V2TransformationProviderSelection,
} from '../../../../generated/prisma-v2/index.js'

import type { TransformationProviderRegistryRepository } from '../../application/ports/transformation-provider-registry-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { assertTransformationBrief, type TransformationBrief } from '../../domain/transformation-brief.ts'
import {
  createTransformationProviderDefinition,
  createTransformationProviderHealth,
  type TransformationProviderDefinition,
  type TransformationProviderSelection,
} from '../../domain/transformation-provider-registry.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type ProviderRow = V2TransformationProviderDefinition & { capabilities: V2TransformationProviderCapability[] }

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `${field} contains invalid JSON`)
  }
}

function hydrateProvider(row: ProviderRow): Readonly<TransformationProviderDefinition> {
  return createTransformationProviderDefinition({
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    adapterId: row.adapterId,
    adapterVersion: row.adapterVersion,
    transport: row.transport as TransformationProviderDefinition['transport'],
    credentialRef: row.credentialRef,
    enabled: row.enabled,
    capabilities: row.capabilities.map((item) => ({
      id: item.id,
      operation: item.operation,
      capabilityVersion: item.capabilityVersion,
      modes: parseJson(item.modesJson, 'provider capability modes'),
      regions: parseJson(item.regionsJson, 'provider capability regions'),
      maximumDurationFrames: item.maximumDurationFrames,
      maximumWidth: item.maximumWidth,
      maximumHeight: item.maximumHeight,
      supportsAudio: item.supportsAudio,
      price: { currency: item.priceCurrency, fixedMinorUnits: item.fixedMinorUnits, perSecondMinorUnits: item.perSecondMinorUnits },
      qualityScoreBps: item.qualityScoreBps,
      dataRetention: item.dataRetention as 'none' | 'transient' | 'provider-policy',
      capabilityHash: item.capabilityHash,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    definitionHash: row.definitionHash,
  })
}

function hydrateHealth(row: V2TransformationProviderHealth) {
  return createTransformationProviderHealth({
    providerId: row.providerId,
    workspaceId: row.workspaceId,
    status: row.status as 'healthy' | 'degraded' | 'unavailable',
    circuitState: row.circuitState as 'closed' | 'open' | 'half-open',
    consecutiveFailures: row.consecutiveFailures,
    observedLatencyMs: row.observedLatencyMs,
    observedAt: row.observedAt.toISOString(),
    ...(row.cooldownUntil ? { cooldownUntil: row.cooldownUntil.toISOString() } : {}),
    healthHash: row.healthHash,
  })
}

function hydrateBrief(row: V2TransformationBrief): Readonly<TransformationBrief> {
  const brief = parseJson<TransformationBrief>(row.briefJson, 'transformation brief')
  const hydrated = assertTransformationBrief(brief)
  if (
    hydrated.id !== row.id || hydrated.workspaceId !== row.workspaceId || hydrated.projectId !== row.projectId ||
    hydrated.projectVersionId !== row.projectVersionId || hydrated.briefHash !== row.briefHash ||
    hydrated.sourceRange.startFrame !== row.sourceStartFrame || hydrated.sourceRange.endFrame !== row.sourceEndFrame
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'TransformationBrief columns disagree with its content-addressed body')
  return hydrated
}

function hydrateSelection(row: V2TransformationProviderSelection): Readonly<TransformationProviderSelection> {
  const body = {
    schemaVersion: row.schemaVersion as TransformationProviderSelection['schemaVersion'],
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    briefId: row.briefId,
    briefHash: row.briefHash,
    ...(row.selectedProviderId ? { selectedProviderId: row.selectedProviderId } : {}),
    ...(row.selectedCapabilityId ? { selectedCapabilityId: row.selectedCapabilityId } : {}),
    candidates: parseJson<TransformationProviderSelection['candidates']>(row.candidatesJson, 'provider selection candidates'),
    policy: parseJson<TransformationProviderSelection['policy']>(row.policyJson, 'provider selection policy'),
    selectedReason: row.selectedReason,
    createdAt: row.createdAt.toISOString(),
    selectionHash: row.selectionHash,
  }
  const { id: _id, selectionHash: _hash, ...hashedBody } = body
  const expected = calculateCanonicalHash(hashedBody)
  if (expected !== row.selectionHash || row.id !== `transformation-provider-selection-${expected.slice(0, 32)}`) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Provider selection failed integrity validation')
  }
  return Object.freeze(body)
}

function isUnique(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export class PrismaTransformationProviderRegistryRepository implements TransformationProviderRegistryRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async persistProvider(input: Parameters<TransformationProviderRegistryRepository['persistProvider']>[0]) {
    const provider = createTransformationProviderDefinition(input.provider)
    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2TransformationProviderDefinition.create({ data: {
          id: provider.id, workspaceId: provider.workspaceId, schemaVersion: provider.schemaVersion, displayName: provider.displayName,
          adapterId: provider.adapterId, adapterVersion: provider.adapterVersion, transport: provider.transport, credentialRef: provider.credentialRef,
          enabled: provider.enabled, definitionHash: provider.definitionHash, createdAt: new Date(provider.createdAt), updatedAt: new Date(provider.updatedAt),
        } })
        await transaction.v2TransformationProviderCapability.createMany({ data: provider.capabilities.map((item) => ({
          id: item.id, workspaceId: provider.workspaceId, providerId: provider.id, operation: item.operation, capabilityVersion: item.capabilityVersion,
          modesJson: stableSerialize(item.modes), regionsJson: stableSerialize(item.regions), maximumDurationFrames: item.maximumDurationFrames,
          maximumWidth: item.maximumWidth, maximumHeight: item.maximumHeight, supportsAudio: item.supportsAudio, priceCurrency: item.price.currency,
          fixedMinorUnits: item.price.fixedMinorUnits, perSecondMinorUnits: item.price.perSecondMinorUnits, qualityScoreBps: item.qualityScoreBps,
          dataRetention: item.dataRetention, capabilityHash: item.capabilityHash,
        })) })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ provider, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const existing = await this.client.v2TransformationProviderDefinition.findFirst({ where: { id: provider.id, workspaceId: provider.workspaceId }, include: { capabilities: true } })
      if (!existing) throw error
      const hydrated = hydrateProvider(existing)
      if (hydrated.definitionHash !== provider.definitionHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Provider id was replayed with different content')
      return Object.freeze({ provider: hydrated, replayed: true })
    }
  }

  async listProviders(input: Parameters<TransformationProviderRegistryRepository['listProviders']>[0]) {
    const rows = await this.client.v2TransformationProviderDefinition.findMany({ where: { workspaceId: input.workspaceId }, include: { capabilities: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })
    return Object.freeze(rows.map(hydrateProvider))
  }

  async persistHealth(input: Parameters<TransformationProviderRegistryRepository['persistHealth']>[0]) {
    const health = createTransformationProviderHealth(input.health)
    const id = `transformation-provider-health-${health.healthHash.slice(0, 32)}`
    try {
      await this.client.v2TransformationProviderHealth.create({ data: {
        id, workspaceId: health.workspaceId, providerId: health.providerId, schemaVersion: health.schemaVersion, status: health.status,
        circuitState: health.circuitState, consecutiveFailures: health.consecutiveFailures, observedLatencyMs: health.observedLatencyMs,
        cooldownUntil: health.cooldownUntil ? new Date(health.cooldownUntil) : null, observedAt: new Date(health.observedAt), healthHash: health.healthHash,
      } })
      return Object.freeze({ health, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const existing = await this.client.v2TransformationProviderHealth.findFirst({ where: { providerId: health.providerId, observedAt: new Date(health.observedAt) } })
      if (!existing || existing.healthHash !== health.healthHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Health observation was replayed with different content')
      return Object.freeze({ health: hydrateHealth(existing), replayed: true })
    }
  }

  async readLatestHealth(input: Parameters<TransformationProviderRegistryRepository['readLatestHealth']>[0]) {
    if (input.providerIds.length === 0) return Object.freeze([])
    const rows = await this.client.v2TransformationProviderHealth.findMany({ where: { workspaceId: input.workspaceId, providerId: { in: [...input.providerIds] } }, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }] })
    const seen = new Set<string>()
    return Object.freeze(rows.filter((row) => !seen.has(row.providerId) && Boolean(seen.add(row.providerId))).map(hydrateHealth))
  }

  async persistBrief(input: Parameters<TransformationProviderRegistryRepository['persistBrief']>[0]) {
    const brief = assertTransformationBrief(input.brief)
    try {
      await this.client.v2TransformationBrief.create({ data: {
        id: brief.id, workspaceId: brief.workspaceId, projectId: brief.projectId, projectVersionId: brief.projectVersionId,
        schemaVersion: brief.schemaVersion, storyPlanId: brief.storyPlanId, storyPlanHash: brief.storyPlanHash, sourceArtifactId: brief.sourceArtifactId,
        sourceArtifactHash: brief.sourceArtifactHash, sourceStartFrame: brief.sourceRange.startFrame, sourceEndFrame: brief.sourceRange.endFrame,
        mode: brief.mode, intent: brief.intent, rightsSnapshotId: brief.rightsSnapshotId, rightsSnapshotHash: brief.rightsSnapshotHash,
        identitySnapshotId: brief.identitySnapshotId ?? null, identitySnapshotHash: brief.identitySnapshotHash ?? null,
        briefJson: stableSerialize(brief), briefHash: brief.briefHash, createdAt: new Date(brief.createdAt),
      } })
      return Object.freeze({ brief, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const existing = await this.client.v2TransformationBrief.findFirst({ where: { id: brief.id, workspaceId: brief.workspaceId } })
      if (!existing) throw error
      const hydrated = hydrateBrief(existing)
      if (hydrated.briefHash !== brief.briefHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Brief id was replayed with different content')
      return Object.freeze({ brief: hydrated, replayed: true })
    }
  }

  async readBrief(input: Parameters<TransformationProviderRegistryRepository['readBrief']>[0]) {
    const row = await this.client.v2TransformationBrief.findFirst({ where: { id: input.briefId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrateBrief(row) : null
  }

  async listBriefs(input: Parameters<TransformationProviderRegistryRepository['listBriefs']>[0]) {
    const rows = await this.client.v2TransformationBrief.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(input.limit ?? 100, 1), 500),
    })
    return Object.freeze(rows.map(hydrateBrief))
  }

  async persistSelection(input: Parameters<TransformationProviderRegistryRepository['persistSelection']>[0]) {
    const selection = input.selection
    try {
      await this.client.v2TransformationProviderSelection.create({ data: {
        id: selection.id, workspaceId: selection.workspaceId, projectId: selection.projectId, projectVersionId: selection.projectVersionId,
        briefId: selection.briefId, schemaVersion: selection.schemaVersion, briefHash: selection.briefHash,
        selectedProviderId: selection.selectedProviderId ?? null, selectedCapabilityId: selection.selectedCapabilityId ?? null,
        policyJson: stableSerialize(selection.policy), candidatesJson: stableSerialize(selection.candidates), selectedReason: selection.selectedReason,
        selectionHash: selection.selectionHash, createdAt: new Date(selection.createdAt),
      } })
      return Object.freeze({ selection, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const existing = await this.client.v2TransformationProviderSelection.findFirst({ where: { id: selection.id, workspaceId: selection.workspaceId } })
      if (!existing) throw error
      const hydrated = hydrateSelection(existing)
      if (hydrated.selectionHash !== selection.selectionHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Selection id was replayed with different content')
      return Object.freeze({ selection: hydrated, replayed: true })
    }
  }

  async listSelections(input: Parameters<TransformationProviderRegistryRepository['listSelections']>[0]) {
    const rows = await this.client.v2TransformationProviderSelection.findMany({ where: { workspaceId: input.workspaceId, projectId: input.projectId, ...(input.briefId ? { briefId: input.briefId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    return Object.freeze(rows.map(hydrateSelection))
  }
}
