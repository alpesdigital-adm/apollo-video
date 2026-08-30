import { Prisma, type PrismaClient, type V2SyntheticBlockGeneration } from '../../../../generated/prisma-v2/index.js'

import type { SyntheticBlockGenerationRepository } from '../../application/ports/synthetic-block-generation-repository.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import {
  createSyntheticBlockGeneration,
  type SyntheticBlockGeneration,
} from '../../domain/synthetic-block-generation.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function hydrate(row: V2SyntheticBlockGeneration): Readonly<SyntheticBlockGeneration> {
  return createSyntheticBlockGeneration({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planId: row.planId,
    blockId: row.blockId,
    attempt: row.attempt,
    status: row.status as SyntheticBlockGeneration['status'],
    cacheKey: row.cacheKey,
    cacheDecision: row.cacheDecision as SyntheticBlockGeneration['cacheDecision'],
    decisionReason: row.decisionReason,
    ...(row.providerJobId ? { providerJobId: row.providerJobId } : {}),
    ...(row.sourceGenerationId ? { sourceGenerationId: row.sourceGenerationId } : {}),
    profileSnapshotId: row.profileSnapshotId,
    voice: {
      adapterId: row.voiceAdapterId,
      adapterVersion: row.voiceAdapterVersion,
      voiceId: row.voiceId,
      voiceVersion: row.voiceVersion,
      modelRef: row.voiceModelRef,
      outputFormat: row.outputFormat as 'mp3' | 'wav',
      synthesisConfigHash: row.synthesisConfigHash,
    },
    scriptHash: row.scriptHash,
    ...(row.audioArtifactId ? { audioArtifactId: row.audioArtifactId } : {}),
    ...(row.alignmentArtifactId ? { alignmentArtifactId: row.alignmentArtifactId } : {}),
    ...(row.supersededByGenerationId ? { supersededByGenerationId: row.supersededByGenerationId } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    attemptBudget: row.attemptBudget,
    deadlineAt: row.deadlineAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function data(generation: Readonly<SyntheticBlockGeneration>) {
  return {
    id: generation.id,
    workspaceId: generation.workspaceId,
    projectId: generation.projectId,
    planId: generation.planId,
    blockId: generation.blockId,
    attempt: generation.attempt,
    schemaVersion: generation.schemaVersion,
    status: generation.status,
    cacheKey: generation.cacheKey,
    cacheDecision: generation.cacheDecision,
    decisionReason: generation.decisionReason,
    providerJobId: generation.providerJobId ?? null,
    sourceGenerationId: generation.sourceGenerationId ?? null,
    profileSnapshotId: generation.profileSnapshotId,
    voiceAdapterId: generation.voice.adapterId,
    voiceAdapterVersion: generation.voice.adapterVersion,
    voiceId: generation.voice.voiceId,
    voiceVersion: generation.voice.voiceVersion,
    voiceModelRef: generation.voice.modelRef,
    outputFormat: generation.voice.outputFormat,
    synthesisConfigHash: generation.voice.synthesisConfigHash,
    scriptHash: generation.scriptHash,
    audioArtifactId: generation.audioArtifactId ?? null,
    alignmentArtifactId: generation.alignmentArtifactId ?? null,
    supersededByGenerationId: generation.supersededByGenerationId ?? null,
    failureReason: generation.failureReason ?? null,
    attemptBudget: generation.attemptBudget,
    deadlineAt: new Date(generation.deadlineAt),
    createdAt: new Date(generation.createdAt),
    updatedAt: new Date(generation.updatedAt),
  }
}

export class PrismaSyntheticBlockGenerationRepository implements SyntheticBlockGenerationRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  async findEffective(input: Parameters<SyntheticBlockGenerationRepository['findEffective']>[0]) {
    const row = await this.client.v2SyntheticBlockGeneration.findFirst({
      where: { workspaceId: input.workspaceId, blockId: input.blockId },
      orderBy: { attempt: 'desc' },
    })
    return row ? hydrate(row) : null
  }

  async findByCacheKey(input: Parameters<SyntheticBlockGenerationRepository['findByCacheKey']>[0]) {
    const rows = await this.client.v2SyntheticBlockGeneration.findMany({
      where: { workspaceId: input.workspaceId, cacheKey: input.cacheKey, status: { in: [...input.statuses] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    })
    return Object.freeze(rows.map(hydrate))
  }

  async create(input: Parameters<SyntheticBlockGenerationRepository['create']>[0]) {
    try {
      const row = await this.client.$transaction(async (transaction) => {
        const created = await transaction.v2SyntheticBlockGeneration.create({ data: data(input.generation) })
        if (input.supersedes) {
          const superseded = await transaction.v2SyntheticBlockGeneration.updateMany({
            where: {
              id: input.supersedes,
              workspaceId: input.generation.workspaceId,
              blockId: input.generation.blockId,
              supersededByGenerationId: null,
            },
            data: {
              status: 'superseded',
              supersededByGenerationId: input.generation.id,
              updatedAt: new Date(input.generation.createdAt),
            },
          })
          assertDomain(superseded.count === 1, 'VERSION_CONFLICT', 'Block generation was superseded concurrently')
        }
        return created
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return hydrate(row)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Deterministic ids make a crashed ensure pass idempotent: the same
        // attempt row already exists, so return it instead of failing.
        const existing = await this.client.v2SyntheticBlockGeneration.findFirst({
          where: { id: input.generation.id, workspaceId: input.generation.workspaceId },
        })
        if (existing && existing.cacheKey === input.generation.cacheKey) return hydrate(existing)
      }
      throw error
    }
  }

  async settle(input: Parameters<SyntheticBlockGenerationRepository['settle']>[0]) {
    const updated = await this.client.v2SyntheticBlockGeneration.updateMany({
      where: { id: input.generationId, workspaceId: input.workspaceId, status: 'pending' },
      data: {
        status: input.status,
        audioArtifactId: input.audioArtifactId ?? null,
        alignmentArtifactId: input.alignmentArtifactId ?? null,
        failureReason: input.failureReason ?? null,
        updatedAt: new Date(input.updatedAt),
      },
    })
    if (updated.count === 0) return null
    const row = await this.client.v2SyntheticBlockGeneration.findFirst({
      where: { id: input.generationId, workspaceId: input.workspaceId },
    })
    if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Settled block generation disappeared')
    return hydrate(row)
  }

  async listByPlan(input: Parameters<SyntheticBlockGenerationRepository['listByPlan']>[0]) {
    const rows = await this.client.v2SyntheticBlockGeneration.findMany({
      where: {
        workspaceId: input.workspaceId,
        planId: input.planId,
        ...(input.statuses ? { status: { in: [...input.statuses] } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return Object.freeze(rows.map(hydrate))
  }
}
