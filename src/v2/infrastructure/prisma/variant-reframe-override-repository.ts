import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type {
  VariantReframeOverrideRepository, VariantReframeOverrideResult,
} from '../../application/ports/variant-reframe-override-repository.ts'
import { variantReframePlanRowId } from '../../application/plan-project-reframe.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { parseCommandImpact } from '../../domain/command-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { renderOutputReferences } from '../../domain/output-variant-references.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { overrideOfRow, PrismaVariantReframePlanRepository, readVariantReframeOverrideHeads, readVariantReframePlanHead } from './variant-reframe-plan-repository.ts'

const include = Prisma.validator<Prisma.V2VariantReframeOverrideInclude>()({ command: true, resultVersion: true })
type Stored = Prisma.V2VariantReframeOverrideGetPayload<{ include: typeof include }>

function parse(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

export class PrismaVariantReframeOverrideRepository implements VariantReframeOverrideRepository {
  private readonly plans: PrismaVariantReframePlanRepository

  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {
    this.plans = new PrismaVariantReframePlanRepository(client)
  }

  private async hydrate(row: Stored, replayed: boolean, reader: PrismaClient | Prisma.TransactionClient = this.client): Promise<Readonly<VariantReframeOverrideResult>> {
    const reframeOverride = overrideOfRow(row)
    const impact = parseCommandImpact(parse(row.impactJson, 'variant reframe override impact'))
    const commandRow = row.command
    const payload = parse(commandRow.payloadJson, 'variant reframe override command payload') as unknown as VariantReframeOverrideResult['command']['payload']
    const command = createEditCommand({
      id: commandRow.id, workspaceId: commandRow.workspaceId, projectId: commandRow.projectId,
      baseVersionId: commandRow.baseVersionId, baseHash: commandRow.baseHash,
      author: { type: commandRow.actorType as 'api-client', id: commandRow.actorId, ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}) },
      type: requireEditCommandType(commandRow.type),
      scope: parse(commandRow.scopeJson, 'variant reframe override command scope') as EditScope,
      payload,
      ...(commandRow.reason ? { reason: commandRow.reason } : {}),
      idempotencyKey: commandRow.idempotencyKey, createdAt: commandRow.createdAt.toISOString(),
    })
    const resultVersion = hydrateProjectVersionRowV3(row.resultVersion)
    if (commandRow.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored variant reframe override command seal is invalid')
    if (
      impact.impactHash !== row.impactHash || stableSerialize(impact) !== row.impactJson ||
      impact.commandType !== 'apply-variant-reframe-override' || command.type !== 'apply-variant-reframe-override' ||
      payload.impact.impactHash !== impact.impactHash || payload.action !== reframeOverride.action || payload.variantId !== reframeOverride.variantId ||
      payload.clipId !== reframeOverride.clipId || resultVersion.id !== reframeOverride.resultVersionId || command.id !== reframeOverride.commandId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored variant reframe override lineage is invalid')
    const plan = await readVariantReframePlanHead(reader, {
      workspaceId: row.workspaceId, projectId: row.projectId, projectVersionId: resultVersion.id, variantId: reframeOverride.variantId,
    })
    if (!plan) throw new DomainError('PERSISTENCE_CONFLICT', 'The variant reframe plan of the result version is missing')
    return Object.freeze({ command, version: resultVersion, reframeOverride, plan, impact, replayed })
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const command = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input }, select: { id: true, requestFingerprint: true, type: true },
    })
    // Another Command type reusing the key is a different request; the caller's fingerprint check answers the mismatch.
    if (!command || command.type !== 'apply-variant-reframe-override') return null
    const row = await this.client.v2VariantReframeOverride.findUnique({
      where: { commandId_workspaceId: { commandId: command.id, workspaceId: input.workspaceId } }, include,
    })
    if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent variant reframe override disappeared')
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: await this.hydrate(row, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string; variantId: string; clipId: string; startFrame: number; endFrame: number }) {
    const project = await this.client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId } })
    if (!project?.currentVersionId) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersionId })
    if (!parent) return null
    const currentVersionId = parent.version.id
    const editPlan = parse(operationalBundlePlanV3(parent).contentJson, 'variant reframe override EditPlan')
    const durationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 0) throw new DomainError('PERSISTENCE_CONFLICT', 'Variant reframe override render context is incomplete')
    // The variant must be an exact member of the sealed State BEFORE anything else about it is read (a stranger is a published refusal).
    const planContext = await this.plans.readContext({ workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId })
    if (!planContext) return null
    const [proxy, final, currentPlan, head] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputVariantId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputVariantId: true, outputAspectRatio: true },
      }),
      readVariantReframePlanHead(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, variantId: input.variantId }),
      this.client.v2VariantReframeOverrideHead.findUnique({
        where: { projectId_workspaceId_variantId_clipId_startFrame_endFrame: {
          projectId: input.projectId, workspaceId: input.workspaceId, variantId: input.variantId, clipId: input.clipId, startFrame: input.startFrame, endFrame: input.endFrame } },
      }),
    ])
    const siblingPlans = []
    for (const entry of parent.state.document.entries) {
      if (entry.variantId === input.variantId) continue
      const sibling = await readVariantReframePlanHead(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, variantId: entry.variantId })
      if (sibling) siblingPlans.push(sibling)
    }
    let currentOverride = null
    if (head) {
      const row = await this.client.v2VariantReframeOverride.findUnique({ where: { id_workspaceId: { id: head.overrideId, workspaceId: input.workspaceId } } })
      if (!row || row.projectId !== input.projectId || row.variantId !== input.variantId) throw new DomainError('PERSISTENCE_CONFLICT', 'Variant reframe override head is invalid')
      currentOverride = overrideOfRow(row)
    }
    return Object.freeze({
      parent, durationFrames, plan: planContext, currentPlan, siblingPlans: Object.freeze(siblingPlans),
      outputReferences: renderOutputReferences({ state: parent.state, sourceVersionId: currentVersionId, proxies: proxy, finals: final }),
      currentOverride,
    })
  }

  listCurrentByVariant(input: { workspaceId: string; projectId: string; variantId: string }) {
    return readVariantReframeOverrideHeads(this.client, input)
  }

  async commitOrReplay(
    input: Parameters<VariantReframeOverrideRepository['commitOrReplay']>[0],
    attempt = 1,
  ): Promise<Readonly<VariantReframeOverrideResult>> {
    const sealed = childCommandOf<VariantReframeOverrideResult['command']['payload']>(input.bundle)
    const command = sealed.command, requestFingerprint = sealed.requestFingerprint, bundleVersion = input.bundle.version
    const override = input.reframeOverride
    if (
      command.type !== 'apply-variant-reframe-override' || bundleVersion.commandId !== command.id ||
      override.commandId !== command.id || override.resultVersionId !== bundleVersion.id || override.baseVersionId !== command.baseVersionId ||
      override.workspaceId !== command.workspaceId || override.projectId !== command.projectId || bundleVersion.parentVersionId !== command.baseVersionId ||
      input.plans.filter((plan) => plan.variantId === override.variantId).length !== 1 ||
      new Set(input.plans.map((plan) => plan.variantId)).size !== input.plans.length ||
      input.plans.some((plan) => plan.record.workspaceId !== command.workspaceId || plan.record.projectId !== command.projectId || plan.record.variantId !== plan.variantId)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Variant reframe override does not belong to the Command that produced its Version')
    const headKey = {
      projectId: override.projectId, workspaceId: override.workspaceId, variantId: override.variantId,
      clipId: override.clipId, startFrame: override.startFrame, endFrame: override.endFrame,
    }
    try {
      return await this.client.$transaction(async (tx) => {
        const project = await tx.v2Project.findFirst({ where: { id: command.projectId, workspaceId: command.workspaceId }, include: { currentVersion: true } })
        if (
          !project?.currentVersion || project.currentVersion.id !== command.baseVersionId || project.currentVersion.baseHash !== command.baseHash ||
          bundleVersion.sequence !== project.currentVersion.sequence + 1 ||
          input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash
        ) throw new DomainError('VERSION_CONFLICT', 'Project changed before variant reframe override commit')
        const head = await tx.v2VariantReframeOverrideHead.findUnique({ where: { projectId_workspaceId_variantId_clipId_startFrame_endFrame: headKey } })
        if ((head?.overrideId ?? null) !== override.previousOverrideId) throw new DomainError('VERSION_CONFLICT', 'Variant reframe override head changed before commit')
        // The plan the Command decided over is still the latest of its variant: another plan request in between is a stale base.
        const stillHead = await readVariantReframePlanHead(tx, { workspaceId: command.workspaceId, projectId: command.projectId, projectVersionId: command.baseVersionId, variantId: override.variantId })
        if (!stillHead) throw new DomainError('VERSION_CONFLICT', 'The reframe plan the override was decided over is gone')
        await commitProjectVersionWithOutputState(tx, input.bundle)
        await tx.v2VariantReframeOverride.create({
          data: {
            id: override.id, workspaceId: override.workspaceId, projectId: override.projectId, commandId: override.commandId,
            baseVersionId: override.baseVersionId, resultVersionId: override.resultVersionId,
            variantId: override.variantId, clipId: override.clipId, startFrame: override.startFrame, endFrame: override.endFrame,
            action: override.action, previousOverrideId: override.previousOverrideId,
            overrideJson: stableSerialize(override), overrideHash: override.overrideHash,
            impactJson: stableSerialize(input.impact), impactHash: input.impact.impactHash, createdAt: new Date(override.createdAt),
          },
        })
        await tx.v2VariantReframeOverrideHead.upsert({
          where: { projectId_workspaceId_variantId_clipId_startFrame_endFrame: headKey },
          create: { ...headKey, overrideId: override.id, updatedAt: new Date(override.createdAt) },
          update: { overrideId: override.id, updatedAt: new Date(override.createdAt) },
        })
        for (const plan of input.plans) {
          await tx.v2VariantReframePlan.create({
            data: {
              id: variantReframePlanRowId({ projectVersionId: bundleVersion.id, variantId: plan.variantId, recordHash: plan.record.recordHash }),
              workspaceId: command.workspaceId, projectId: command.projectId, projectVersionId: bundleVersion.id, variantId: plan.variantId,
              sequence: 1, recordHash: plan.record.recordHash, disposition: plan.record.disposition,
              recordJson: stableSerialize(plan.record), previousPlanId: null, createdAt: new Date(override.createdAt),
            },
          })
        }
        const updated = await tx.v2Project.updateMany({
          where: { id: command.projectId, workspaceId: command.workspaceId, currentVersionId: command.baseVersionId },
          data: { currentVersionId: bundleVersion.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project changed during variant reframe override commit')
        await settleDeferredOutputGuards(tx)
        const row = await tx.v2VariantReframeOverride.findUniqueOrThrow({ where: { id_workspaceId: { id: override.id, workspaceId: override.workspaceId } }, include })
        return this.hydrate(row, false, tx)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({ workspaceId: command.workspaceId, projectId: command.projectId, idempotencyKey: command.idempotencyKey })
        if (replay?.requestFingerprint === requestFingerprint) return replay.result
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was reused with another variant reframe override')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) return this.commitOrReplay(input, attempt + 1)
      throw error
    }
  }
}
