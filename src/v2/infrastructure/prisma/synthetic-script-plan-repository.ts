import { Prisma, type PrismaClient, type V2SyntheticScriptBlock, type V2SyntheticScriptPlan, type V2SyntheticScriptPlanVersion } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSyntheticScriptPlan,
  SyntheticScriptPlanRepository,
} from '../../application/ports/synthetic-script-plan-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticScriptBlock,
  assertSyntheticScriptPlanVersion,
  createSyntheticScriptPlanHead,
  createSyntheticScriptPlanImpact,
  type SyntheticScriptBlock,
  type SyntheticScriptPlanHead,
  type SyntheticScriptPlanImpact,
  type SyntheticScriptPlanVersion,
} from '../../domain/synthetic-script-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function hydrateBlock(row: V2SyntheticScriptBlock): Readonly<SyntheticScriptBlock> {
  const block: SyntheticScriptBlock = Object.freeze({
    schemaVersion: 'synthetic-script-block/v1',
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planId: row.planId,
    exactText: row.exactText,
    normalizedText: row.exactText.normalize('NFC').replace(/\s+/g, ' ').trim(),
    normalizedTextHash: row.normalizedTextHash,
    locale: row.locale,
    occurrence: row.occurrence,
    createdInVersionId: row.createdInVersionId,
    origin: Object.freeze({
      kind: row.originKind as SyntheticScriptBlock['origin']['kind'],
      ...(row.originBlockId ? { originBlockId: row.originBlockId } : {}),
    }),
    blockHash: row.blockHash,
    createdAt: row.createdAt.toISOString(),
  })
  assertSyntheticScriptBlock(block)
  return block
}

function hydrateImpact(json: string): Readonly<SyntheticScriptPlanImpact> {
  let parsed: SyntheticScriptPlanImpact
  try {
    parsed = JSON.parse(json) as SyntheticScriptPlanImpact
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan impact JSON is invalid')
  }
  const impact = createSyntheticScriptPlanImpact({
    commandType: parsed.commandType,
    baseVersionId: parsed.baseVersionId,
    resultVersionId: parsed.resultVersionId,
    createdBlockIds: parsed.createdBlockIds,
    reusedBlockIds: parsed.reusedBlockIds,
    retiredBlockIds: parsed.retiredBlockIds,
    invalidatedArtifactIds: parsed.invalidatedArtifactIds,
    renderSemantics: parsed.renderSemantics,
    cacheDecisions: parsed.cacheDecisions,
  })
  if (impact.impactHash !== parsed.impactHash || stableSerialize(impact) !== stableSerialize(parsed)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan impact failed integrity validation')
  }
  return impact
}

function hydrateVersion(
  row: V2SyntheticScriptPlanVersion,
  blocksInSequence: readonly Readonly<SyntheticScriptBlock>[],
): Readonly<SyntheticScriptPlanVersion> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  let sequence: string[]
  try {
    sequence = JSON.parse(row.blockSequenceJson) as string[]
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan sequence JSON is invalid')
  }
  const impact = hydrateImpact(row.impactJson)
  const version: SyntheticScriptPlanVersion = Object.freeze({
    schemaVersion: 'synthetic-script-plan-version/v1',
    id: row.id,
    planId: row.planId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sequence: row.sequence,
    ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
    projectVersionId: row.projectVersionId,
    profileSnapshotId: row.profileSnapshotId,
    locale: row.locale,
    segmentationVersion: 'synthetic-script-segmentation/v1',
    scriptHash: row.scriptHash,
    commandType: row.commandType as SyntheticScriptPlanVersion['commandType'],
    blockSequence: Object.freeze(sequence),
    impact,
    planVersionHash: row.planVersionHash,
    createdAt: row.createdAt.toISOString(),
  })
  assertDomain(
    blocksInSequence.length === sequence.length &&
      blocksInSequence.every((block, index) => block.id === sequence[index]),
    'PERSISTENCE_CONFLICT',
    'Stored synthetic script plan blocks do not match the version sequence',
  )
  assertSyntheticScriptPlanVersion(version, blocksInSequence.map(({ normalizedTextHash }) => normalizedTextHash))
  assertDomain(
    impact.impactHash === row.commandImpactHash,
    'PERSISTENCE_CONFLICT',
    'Stored synthetic script plan command impact hash mismatch',
  )
  return version
}

function versionData(
  version: Readonly<SyntheticScriptPlanVersion>,
  input: { requestFingerprint: string; idempotencyKey: string; authenticationAudit: Parameters<typeof externalActorAuditData>[0] },
) {
  return {
    id: version.id,
    planId: version.planId,
    workspaceId: version.workspaceId,
    projectId: version.projectId,
    sequence: version.sequence,
    parentVersionId: version.parentVersionId ?? null,
    projectVersionId: version.projectVersionId,
    profileSnapshotId: version.profileSnapshotId,
    schemaVersion: version.schemaVersion,
    locale: version.locale,
    segmentationVersion: version.segmentationVersion,
    scriptHash: version.scriptHash,
    commandType: version.commandType,
    blockSequenceJson: JSON.stringify(version.blockSequence),
    impactJson: stableSerialize(version.impact),
    commandImpactHash: version.impact.impactHash,
    planVersionHash: version.planVersionHash,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    createdByClientId: input.authenticationAudit.clientId,
    ...externalActorAuditData(input.authenticationAudit, version.workspaceId, input.authenticationAudit.clientId),
    createdAt: new Date(version.createdAt),
  }
}

function blockData(block: Readonly<SyntheticScriptBlock>) {
  return {
    id: block.id,
    workspaceId: block.workspaceId,
    projectId: block.projectId,
    planId: block.planId,
    schemaVersion: block.schemaVersion,
    exactText: block.exactText,
    normalizedTextHash: block.normalizedTextHash,
    locale: block.locale,
    occurrence: block.occurrence,
    createdInVersionId: block.createdInVersionId,
    retiredInVersionId: null,
    originKind: block.origin.kind,
    originBlockId: block.origin.originBlockId ?? null,
    blockHash: block.blockHash,
    createdAt: new Date(block.createdAt),
  }
}

export class PrismaSyntheticScriptPlanRepository implements SyntheticScriptPlanRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  private async blocksFor(
    version: Pick<V2SyntheticScriptPlanVersion, 'workspaceId' | 'planId' | 'blockSequenceJson'>,
  ): Promise<readonly Readonly<SyntheticScriptBlock>[]> {
    let sequence: string[]
    try {
      sequence = JSON.parse(version.blockSequenceJson) as string[]
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan sequence JSON is invalid')
    }
    const rows = await this.client.v2SyntheticScriptBlock.findMany({
      where: { workspaceId: version.workspaceId, planId: version.planId, id: { in: [...sequence] } },
    })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return sequence.map((blockId) => {
      const row = byId.get(blockId)
      if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic script plan sequence references a missing block')
      return hydrateBlock(row)
    })
  }

  private async hydratePlanFromVersion(row: V2SyntheticScriptPlanVersion): Promise<Readonly<PersistedSyntheticScriptPlan>> {
    const head = await this.client.v2SyntheticScriptPlan.findFirst({
      where: { id: row.planId, workspaceId: row.workspaceId },
    })
    if (!head?.currentVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic script plan head is missing its current version')
    const blocks = await this.blocksFor(row)
    return Object.freeze({
      head: this.hydrateHead(head),
      version: hydrateVersion(row, blocks),
      blocks,
      requestFingerprint: row.requestFingerprint,
      idempotencyKey: row.idempotencyKey,
    })
  }

  private hydrateHead(row: V2SyntheticScriptPlan): Readonly<SyntheticScriptPlanHead> {
    hydrateExternalActorAudit(row, row.createdByClientId)
    assertDomain(Boolean(row.currentVersionId), 'PERSISTENCE_CONFLICT', 'Synthetic script plan head is missing its current version')
    return createSyntheticScriptPlanHead({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      currentVersionId: row.currentVersionId!,
      createdAt: row.createdAt.toISOString(),
    })
  }

  async findPlanReplay(input: Parameters<SyntheticScriptPlanRepository['findPlanReplay']>[0]) {
    const row = await this.client.v2SyntheticScriptPlan.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
    })
    if (!row) return null
    const version = await this.client.v2SyntheticScriptPlanVersion.findFirst({
      where: { workspaceId: row.workspaceId, planId: row.id, sequence: 1 },
    })
    if (!version) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic script plan is missing its first version')
    const blocks = await this.blocksFor(version)
    return Object.freeze({
      head: this.hydrateHead(row),
      version: hydrateVersion(version, blocks),
      blocks,
      requestFingerprint: row.requestFingerprint,
      idempotencyKey: row.idempotencyKey,
    })
  }

  async createPlan(input: Parameters<SyntheticScriptPlanRepository['createPlan']>[0]) {
    try {
      const created = await this.client.$transaction(async (transaction) => {
        await transaction.v2SyntheticScriptPlan.create({
          data: {
            id: input.head.id,
            workspaceId: input.head.workspaceId,
            projectId: input.head.projectId,
            schemaVersion: input.head.schemaVersion,
            currentVersionId: null,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
            createdByClientId: input.authenticationAudit.clientId,
            ...externalActorAuditData(input.authenticationAudit, input.head.workspaceId, input.authenticationAudit.clientId),
            createdAt: new Date(input.head.createdAt),
            updatedAt: new Date(input.head.createdAt),
          },
        })
        await transaction.v2SyntheticScriptPlanVersion.create({
          data: versionData(input.version, input),
        })
        if (input.blocks.length > 0) {
          await transaction.v2SyntheticScriptBlock.createMany({ data: input.blocks.map(blockData) })
        }
        await transaction.v2SyntheticScriptPlan.update({
          where: { id: input.head.id },
          data: { currentVersionId: input.version.id },
        })
        return transaction.v2SyntheticScriptPlanVersion.findUniqueOrThrow({ where: { id: input.version.id } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ plan: await this.hydratePlanFromVersion(created), replayed: false })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findPlanReplay({
          workspaceId: input.head.workspaceId,
          actorClientId: input.authenticationAudit.clientId,
          actorContextHash: input.authenticationAudit.contextHash,
          idempotencyKey: input.idempotencyKey,
        })
        if (replay && replay.requestFingerprint === input.requestFingerprint) {
          return Object.freeze({ plan: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async findCommandReplay(input: Parameters<SyntheticScriptPlanRepository['findCommandReplay']>[0]) {
    const row = await this.client.v2SyntheticScriptPlanVersion.findFirst({
      where: {
        workspaceId: input.workspaceId,
        planId: input.planId,
        createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row ? this.hydratePlanFromVersion(row) : null
  }

  async applyCommand(input: Parameters<SyntheticScriptPlanRepository['applyCommand']>[0]) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.client.$transaction(async (transaction) => {
          await transaction.v2SyntheticScriptPlanVersion.create({
            data: versionData(input.version, input),
          })
          if (input.createdBlocks.length > 0) {
            await transaction.v2SyntheticScriptBlock.createMany({ data: input.createdBlocks.map(blockData) })
          }
          if (input.retiredBlockIds.length > 0) {
            const retired = await transaction.v2SyntheticScriptBlock.updateMany({
              where: {
                id: { in: [...input.retiredBlockIds] },
                workspaceId: input.workspaceId,
                planId: input.planId,
                retiredInVersionId: null,
              },
              data: { retiredInVersionId: input.version.id },
            })
            assertDomain(
              retired.count === input.retiredBlockIds.length,
              'VERSION_CONFLICT',
              'A retired block no longer belongs to the current plan version',
            )
          }
          const swapped = await transaction.v2SyntheticScriptPlan.updateMany({
            where: {
              id: input.planId,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              currentVersionId: input.baseVersionId,
            },
            data: { currentVersionId: input.version.id, updatedAt: new Date(input.version.createdAt) },
          })
          assertDomain(swapped.count === 1, 'VERSION_CONFLICT', 'Synthetic script plan advanced concurrently')
          return transaction.v2SyntheticScriptPlanVersion.findUniqueOrThrow({ where: { id: input.version.id } })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        return Object.freeze({ plan: await this.hydratePlanFromVersion(created), replayed: false })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const replay = await this.findCommandReplay({
            workspaceId: input.workspaceId,
            planId: input.planId,
            actorClientId: input.authenticationAudit.clientId,
            actorContextHash: input.authenticationAudit.contextHash,
            idempotencyKey: input.idempotencyKey,
          })
          if (replay && replay.requestFingerprint === input.requestFingerprint) {
            return Object.freeze({ plan: replay, replayed: true })
          }
          // Not a replay: two commands raced for the same version sequence.
          // That is a concurrency conflict the caller can act on, not an
          // internal failure, so it must not escape as a raw driver error.
          throw new DomainError('VERSION_CONFLICT', 'Synthetic script plan advanced concurrently')
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) continue
        throw error
      }
    }
  }

  async readPlan(input: Parameters<SyntheticScriptPlanRepository['readPlan']>[0]) {
    const head = await this.client.v2SyntheticScriptPlan.findFirst({
      where: { id: input.planId, workspaceId: input.workspaceId, projectId: input.projectId },
    })
    if (!head?.currentVersionId) return null
    const version = await this.client.v2SyntheticScriptPlanVersion.findFirst({
      where: { id: head.currentVersionId, workspaceId: input.workspaceId, planId: input.planId },
    })
    if (!version) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic script plan head points at a missing version')
    const blocks = await this.blocksFor(version)
    return Object.freeze({
      head: this.hydrateHead(head),
      version: hydrateVersion(version, blocks),
      blocks,
      requestFingerprint: version.requestFingerprint,
      idempotencyKey: version.idempotencyKey,
    })
  }

  async readVersion(input: Parameters<SyntheticScriptPlanRepository['readVersion']>[0]) {
    const row = await this.client.v2SyntheticScriptPlanVersion.findFirst({
      where: { id: input.versionId, workspaceId: input.workspaceId, planId: input.planId },
    })
    if (!row) return null
    const blocks = await this.blocksFor(row)
    return Object.freeze({ version: hydrateVersion(row, blocks), blocks })
  }
}
