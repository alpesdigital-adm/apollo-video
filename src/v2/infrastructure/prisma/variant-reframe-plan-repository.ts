import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type {
  StoredVariantReframePlan, VariantReframePlanContext, VariantReframePlanRepository,
} from '../../application/ports/variant-reframe-plan-repository.ts'
import { reframeSpecOf, reframeTimelineOf } from '../../application/project-reframe-facts.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { parseVariantReframeOverride, type VariantReframeOverrideV2 } from '../../domain/variant-reframe-overrides.ts'
import { parseVariantReframePlanRecord, type VariantReframePlanRecordV1 } from '../../domain/variant-reframe-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { hydrateProxySource, queryProxySourceProject } from './proxy-source-authority.ts'
import { requirePersistedOutputConsumptionV3 } from './output-state-consumption.ts'

type Reader = PrismaClient | Prisma.TransactionClient

const conflict = (message: string) => new DomainError('PERSISTENCE_CONFLICT', message)

function parseStored(json: string, field: string): unknown {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || stableSerialize(parsed) !== json) throw new Error('not canonical')
    return parsed
  } catch {
    throw conflict(`Stored ${field} is invalid`)
  }
}

/** Rebuilds a stored override through its own parser and checks the row's columns against the document. */
export function overrideOfRow(row: Readonly<{
  workspaceId: string; projectId: string; variantId: string; clipId: string; startFrame: number; endFrame: number; action: string
  previousOverrideId: string | null; overrideJson: string; overrideHash: string; resultVersionId: string; baseVersionId: string; commandId: string
}>): Readonly<VariantReframeOverrideV2> {
  const override = parseVariantReframeOverride(parseStored(row.overrideJson, 'variant reframe override'))
  if (
    override.overrideHash !== row.overrideHash || stableSerialize(override) !== row.overrideJson ||
    override.workspaceId !== row.workspaceId || override.projectId !== row.projectId || override.variantId !== row.variantId ||
    override.clipId !== row.clipId || override.startFrame !== row.startFrame || override.endFrame !== row.endFrame ||
    override.action !== row.action || override.previousOverrideId !== row.previousOverrideId ||
    override.resultVersionId !== row.resultVersionId || override.baseVersionId !== row.baseVersionId || override.commandId !== row.commandId
  ) throw conflict('Stored variant reframe override lineage is invalid')
  return override
}

/** Every current override (head) of one variant of a project. */
export async function readVariantReframeOverrideHeads(client: Reader, input: Readonly<{ workspaceId: string; projectId: string; variantId: string }>): Promise<readonly Readonly<VariantReframeOverrideV2>[]> {
  const heads = await client.v2VariantReframeOverrideHead.findMany({
    where: { workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId },
    select: { overrideId: true },
  })
  if (heads.length === 0) return Object.freeze([])
  const rows = await client.v2VariantReframeOverride.findMany({
    where: { workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId, id: { in: heads.map((head) => head.overrideId) } },
    orderBy: [{ clipId: 'asc' }, { startFrame: 'asc' }],
  })
  if (rows.length !== heads.length) throw conflict('A variant reframe override head names an override that is not stored')
  return Object.freeze(rows.map((row) => overrideOfRow(row)))
}

function storedOf(row: Readonly<{ id: string; sequence: number; projectVersionId: string; workspaceId: string; projectId: string; variantId: string
  recordHash: string; disposition: string; recordJson: string; createdAt: Date }>): Readonly<StoredVariantReframePlan> {
  const record = parseVariantReframePlanRecord(parseStored(row.recordJson, 'variant reframe plan'))
  if (
    stableSerialize(record) !== row.recordJson || record.recordHash !== row.recordHash || record.disposition !== row.disposition ||
    record.workspaceId !== row.workspaceId || record.projectId !== row.projectId || record.variantId !== row.variantId
  ) throw conflict('Stored variant reframe plan differs from its columns')
  return Object.freeze({ id: row.id, sequence: row.sequence, projectVersionId: row.projectVersionId, record, createdAt: row.createdAt.toISOString() })
}

/** The latest plan record persisted for one Version and variant. Used by the planner and by the render repository. */
export async function readVariantReframePlanHead(client: Reader, input: Readonly<{ workspaceId: string; projectId: string; projectVersionId: string; variantId: string }>): Promise<Readonly<StoredVariantReframePlan> | null> {
  const row = await client.v2VariantReframePlan.findFirst({
    where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, variantId: input.variantId },
    orderBy: { sequence: 'desc' },
  })
  return row ? storedOf(row) : null
}

export class PrismaVariantReframePlanRepository implements VariantReframePlanRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async readContext(input: { workspaceId: string; projectId: string; variantId: string }): Promise<Readonly<VariantReframePlanContext> | null> {
    const head = await this.client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { currentVersionId: true } })
    if (!head?.currentVersionId) return null
    const versionId = head.currentVersionId
    // The one consumption verdict: an unknown variant, an aspect ratio spelled as a variant, a copy without authority and an output
    // that carries no canvas are refused here with their published reasons, never reinterpreted.
    const consumption = await requirePersistedOutputConsumptionV3(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId, versionId, variantId: input.variantId, purpose: 'render',
    })
    const project = await queryProxySourceProject(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: versionId, variantId: input.variantId, purpose: 'render' })
    const source = hydrateProxySource(project)
    if (!source) return null
    const facts = reframeTimelineOf(source)
    return Object.freeze({
      workspaceId: input.workspaceId, projectId: input.projectId,
      version: Object.freeze({ id: consumption.version.id, baseHash: consumption.version.baseHash }),
      variantId: input.variantId, spec: reframeSpecOf(consumption.entry), timeline: facts.timeline, source: facts.source, clips: facts.clips,
      overrideHeads: await readVariantReframeOverrideHeads(this.client, input),
    })
  }

  readHead(input: { workspaceId: string; projectId: string; projectVersionId: string; variantId: string }) {
    return readVariantReframePlanHead(this.client, input)
  }

  async persistOrReplay(input: Parameters<VariantReframePlanRepository['persistOrReplay']>[0], attempt = 1): Promise<Readonly<{ stored: Readonly<StoredVariantReframePlan>; replayed: boolean }>> {
    const record: Readonly<VariantReframePlanRecordV1> = parseVariantReframePlanRecord(JSON.parse(stableSerialize(input.record)))
    if (record.workspaceId !== input.workspaceId || record.projectId !== input.projectId || record.variantId !== input.variantId) {
      throw conflict('The reframe plan record belongs to another workspace, project or variant')
    }
    try {
      return await this.client.$transaction(async (tx) => {
        const head = await tx.v2VariantReframePlan.findFirst({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, variantId: input.variantId },
          orderBy: { sequence: 'desc' },
        })
        if (head?.recordHash === record.recordHash) return { stored: storedOf(head), replayed: true }
        const created = await tx.v2VariantReframePlan.create({
          data: {
            id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, variantId: input.variantId,
            sequence: (head?.sequence ?? 0) + 1, recordHash: record.recordHash, disposition: record.disposition,
            recordJson: stableSerialize(record), previousPlanId: head?.id ?? null, createdAt: new Date(input.createdAt),
          },
        })
        return { stored: storedOf(created), replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      // Another writer extended the chain first (or wrote this very record): read again, replay it or append after it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034') && attempt < 4) {
        return this.persistOrReplay(input, attempt + 1)
      }
      throw error
    }
  }
}
