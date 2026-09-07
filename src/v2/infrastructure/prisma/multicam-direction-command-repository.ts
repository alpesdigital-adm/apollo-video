import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import type { DirectMulticamSessionPayload } from '../../application/direct-multicam-session.ts'
import type {
  MulticamDirectionCommandCommit,
  MulticamDirectionCommandContext,
  MulticamDirectionCommandRepository,
  MulticamDirectionCommandResult,
  MulticamProjectMediaLink,
} from '../../application/ports/multicam-direction-command-repository.ts'
import { calculateVersionHash, stableSerialize } from '../../application/version-hash.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { validateDirectedEditPlan, type DirectedEditPlan } from '../../domain/director-run.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createMulticamDirectionInvalidations,
  parseMulticamDirectionImpact,
} from '../../domain/multicam-direction-impact.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { rational, type Rational } from '../../domain/session-time.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from './edit-command-actor-audit.ts'

/**
 * The project side of `direct-multicam-session` against PostgreSQL (F4.012).
 *
 * The twin of `editorial-command-repository.ts`, and deliberately its twin:
 * MAP.md §3.1 says the compile step follows `applyEditorialCutCommandService`,
 * so the Command, the `edit-plan` snapshot, the version, the invalidations, the
 * project's `currentVersionId` move and the outbox event are written in one
 * serializable transaction whose predicates re-check the fence the service
 * already checked. Two differences, both forced by what a direction is:
 *
 * - `readContext` returns the media links the compiled clips will point at,
 *   with the cadence each file was probed at. A direction cuts several
 *   recordings; `hydrateSource` refuses a render whose clips name an artifact
 *   the project does not link as available
 *   (`prisma/project-proxy-render-repository.ts:111-141`), and the service is where an
 *   operator can still act on that.
 * - the commit re-reads the stored direction and refuses if it is no longer the
 *   one the Command names. The direction lives in its own chain, so a Command
 *   could otherwise be committed against a cut that was replaced between the
 *   service deriving it and the transaction opening.
 */

type StoredCommand = Prisma.V2EditCommandGetPayload<{
  include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true }
}>

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseArray(value: string, field: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

/**
 * A snapshot's bytes, proved against the `contentHash` stored beside them.
 *
 * Both readers of the EditPlan snapshot needed this and neither had it: the
 * direction is derived on top of the plan `readContext` returns, and a retry
 * hands the plan back out of `hydrateStoredCommand`, so an edited snapshot
 * would have produced a direction — and a replayed answer — over bytes whose
 * hash nobody checked. The authority reader of the same snapshot does check it
 * (`prisma/project-proxy-render-repository.ts:99`), and CONTRACT §4 asks hydration to
 * re-verify every hash. `calculateVersionHash` is canonical over the parsed
 * object, so a re-serialization with different key order still reproduces it.
 */
function assertSnapshotHash(plan: unknown, contentHash: string, what: string): void {
  if (calculateVersionHash(plan) !== contentHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `${what} does not hash to the contentHash stored beside it`,
    )
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/**
 * A probed frame rate as an exact rational, or null when nothing probed it.
 *
 * `r_frame_rate` arrives as `"30000/1001"` from ffprobe and as a float from an
 * older manifest. Null rather than the plan's fps when neither is present: the
 * domain records the fallback on every clip as `sourceFrameRate` so the
 * assumption is visible, and inventing 30/1 here would hide it.
 */
function probedFrameRate(probe: Record<string, unknown>): Rational | null {
  const raw = probe.rFrameRate ?? probe.r_frame_rate ?? probe.fps
  if (typeof raw === 'string' && /^[0-9]{1,9}\/[1-9][0-9]{0,8}$/.test(raw)) {
    const [numerator, denominator] = raw.split('/')
    return rational(BigInt(numerator!), BigInt(denominator!))
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  const thousandths = Math.round(value * 1_000)
  return rational(BigInt(thousandths), BigInt(1_000))
}

function hydrateStoredCommand(row: StoredCommand, replayed: boolean): MulticamDirectionCommandResult {
  hydrateEditCommandExternalActorAudit(row)
  if (!row.resultVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Multicam direction result version is missing')
  const scope = parseRecord(row.scopeJson, 'multicam direction command scope') as EditScope
  const payload = parseRecord(row.payloadJson, 'multicam direction command payload') as unknown as DirectMulticamSessionPayload
  const impact = parseMulticamDirectionImpact(payload.impact)
  if (
    row.type !== 'direct-multicam-session' || payload.schemaVersion !== 1 ||
    impact.commandId !== row.id || impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.resultVersion.id ||
    impact.sessionId !== payload.sessionId ||
    impact.directionHash !== payload.directionHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored multicam direction impact is inconsistent')
  const command = createEditCommand<DirectMulticamSessionPayload>({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    baseVersionId: row.baseVersionId,
    baseHash: row.baseHash,
    author: {
      type: row.actorType as 'user' | 'director' | 'system' | 'api-client',
      id: row.actorId,
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    },
    type: row.type,
    scope,
    payload,
    ...(row.reason ? { reason: row.reason } : {}),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  })
  const versionRow = row.resultVersion
  const version = createProjectVersion({
    id: versionRow.id,
    workspaceId: versionRow.workspaceId,
    projectId: versionRow.projectId,
    sequence: versionRow.sequence,
    parentVersionId: versionRow.parentVersionId ?? undefined,
    snapshotRefs: {
      brief: versionRow.briefSnapshotId,
      editPlan: versionRow.editPlanSnapshotId,
      policies: versionRow.policiesSnapshotId,
    },
    baseHash: versionRow.baseHash,
    createdBy: versionRow.createdBy,
    commandId: versionRow.commandId ?? undefined,
    createdAt: versionRow.createdAt.toISOString(),
  })
  const editPlan = parseRecord(versionRow.editPlanSnapshot.contentJson, 'multicam EditPlan') as unknown as DirectedEditPlan
  assertSnapshotHash(editPlan, versionRow.editPlanSnapshot.contentHash, 'the multicam EditPlan a retry hands back')
  if (editPlan.projectVersionId !== version.id) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored multicam EditPlan names another project version')
  }
  // Re-validated on the way out, not merely parsed: a plan whose transitions or
  // timeline were edited underneath the snapshot would otherwise be handed to a
  // renderer as an authored cut.
  validateDirectedEditPlan(editPlan)
  const expectedInvalidations = createMulticamDirectionInvalidations({ impact, createdAt: row.createdAt.toISOString() })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status,
    commandId: item.commandId, baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId, artifactId: item.artifactId,
    kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'multicam invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'multicam invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored multicam direction invalidations are inconsistent')
  }
  return Object.freeze({
    command,
    version,
    editPlan: Object.freeze(editPlan),
    impact,
    invalidations: Object.freeze(invalidations),
    replayed,
  })
}

export class PrismaMulticamDirectionCommandRepository implements MulticamDirectionCommandRepository {
  private readonly client: PrismaClient

  // No parameter property: the strip-only TypeScript plain `node` runs refuses
  // `constructor(private readonly …)`, and this class is reachable from suites
  // that run under it.
  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
    })
    if (!row) return null
    if (hydrateEditCommandExternalActorAudit(row).contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Multicam direction replay belongs to another authentication context')
    }
    return Object.freeze({
      requestFingerprint: row.requestFingerprint,
      result: hydrateStoredCommand(row, true),
    })
  }

  async readContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<MulticamDirectionCommandContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { editPlanSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const versionRow = project.currentVersion
    const [assets, proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectMediaAsset.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId },
        include: {
          artifact: {
            include: { manifests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 4 } },
          },
        },
      }),
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: versionRow.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: versionRow.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    const mediaLinks: Readonly<MulticamProjectMediaLink>[] = assets.map((asset) => {
      const probe = asset.artifact.manifests
        .map((manifest) => parseRecord(manifest.manifestJson, `media manifest ${manifest.id}`).probe)
        .find((entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry))
      return Object.freeze({
        artifactId: asset.artifactId,
        role: asset.role,
        status: asset.artifact.status,
        mediaType: asset.artifact.mediaType,
        frameRate: probe ? probedFrameRate(probe) : null,
      })
    })
    const currentPlan = parseRecord(versionRow.editPlanSnapshot.contentJson, 'current project EditPlan') as unknown as
      EditorialCutEditPlan | DirectedEditPlan
    assertSnapshotHash(currentPlan, versionRow.editPlanSnapshot.contentHash, 'the project EditPlan this direction is derived on top of')
    const currentDurationFrames = Number(currentPlan.durationFrames)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames <= 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan duration is invalid')
    }
    return Object.freeze({
      workspaceId: project.workspaceId,
      projectId: project.id,
      objective: project.objective as MulticamDirectionCommandContext['objective'],
      currentVersion: createProjectVersion({
        id: versionRow.id,
        workspaceId: versionRow.workspaceId,
        projectId: versionRow.projectId,
        sequence: versionRow.sequence,
        parentVersionId: versionRow.parentVersionId ?? undefined,
        snapshotRefs: {
          brief: versionRow.briefSnapshotId,
          editPlan: versionRow.editPlanSnapshotId,
          policies: versionRow.policiesSnapshotId,
        },
        baseHash: versionRow.baseHash,
        createdBy: versionRow.createdBy,
        commandId: versionRow.commandId ?? undefined,
        createdAt: versionRow.createdAt.toISOString(),
      }),
      currentPlan: Object.freeze(currentPlan),
      currentDurationFrames,
      proxyVariantId: project.format ?? '9:16',
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({
          artifactId: output.outputArtifactId, kind: 'proxy' as const,
          sourceVersionId: versionRow.id, variantId: project.format ?? '9:16',
        })),
        ...finalOutputs.map((output) => Object.freeze({
          artifactId: output.outputArtifactId, kind: 'final' as const,
          sourceVersionId: versionRow.id, variantId: output.outputAspectRatio,
        })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
      mediaLinks: Object.freeze(mediaLinks),
    })
  }

  async commitOrReplay(
    bundle: MulticamDirectionCommandCommit,
    serializationAttempt = 1,
  ): Promise<Readonly<MulticamDirectionCommandResult>> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2EditCommand.findUnique({
          where: {
            workspaceId_projectId_idempotencyKey: {
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              idempotencyKey: bundle.command.idempotencyKey,
            },
          },
          include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different multicam direction')
          }
          if (hydrateEditCommandExternalActorAudit(existing).contextHash !== bundle.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Multicam direction replay belongs to another authentication context')
          }
          return hydrateStoredCommand(existing, true)
        }
        const project = await transaction.v2Project.findFirst({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
          include: { currentVersion: true },
        })
        if (!project?.currentVersion) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Multicam direction project disappeared before commit')
        }
        if (
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1
        ) {
          throw new DomainError('VERSION_CONFLICT', 'Project version changed before multicam direction commit', {
            currentVersionId: project.currentVersion.id,
            currentBaseHash: project.currentVersion.baseHash,
          })
        }
        // The direction lives in its own chain, so it can move between the
        // service deriving it and this transaction opening. A Command that
        // named a cut which is no longer stored would point at nothing.
        const storedDirection = await transaction.v2MulticamDirection.findFirst({
          where: {
            workspaceId: bundle.command.workspaceId,
            sessionId: bundle.directionEvidence.sessionId,
            version: bundle.directionEvidence.directionVersion,
          },
          select: { directionHash: true, sessionVersion: true },
        })
        if (
          !storedDirection ||
          storedDirection.directionHash !== bundle.directionEvidence.directionHash ||
          storedDirection.sessionVersion !== bundle.directionEvidence.sessionVersion
        ) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'The direction this Command was compiled from is not the one stored', {
            sessionId: bundle.directionEvidence.sessionId,
            expectedDirectionHash: bundle.directionEvidence.directionHash,
            storedDirectionHash: storedDirection?.directionHash ?? null,
          })
        }
        const currentOutputs = [
          ...(await transaction.v2ProjectProxyRenderOperation.findMany({
            where: {
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              projectVersionId: bundle.command.baseVersionId,
              operation: { status: 'succeeded', phase: 'completed' },
            },
            select: { outputArtifactId: true },
          })).map((output) => ({
            artifactId: output.outputArtifactId, kind: 'proxy' as const,
            sourceVersionId: bundle.command.baseVersionId, variantId: project.format ?? '9:16',
          })),
          ...(await transaction.v2ProjectFinalExportOperation.findMany({
            where: {
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              projectVersionId: bundle.command.baseVersionId,
              operation: { status: 'succeeded', phase: 'completed' },
            },
            select: { outputArtifactId: true, outputAspectRatio: true },
          })).map((output) => ({
            artifactId: output.outputArtifactId, kind: 'final' as const,
            sourceVersionId: bundle.command.baseVersionId, variantId: output.outputAspectRatio,
          })),
        ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
        if (stableSerialize(currentOutputs) !== stableSerialize(bundle.command.payload.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before multicam direction commit')
        }
        await transaction.v2EditCommand.create({
          data: {
            id: bundle.command.id,
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            baseVersionId: bundle.command.baseVersionId,
            baseHash: bundle.command.baseHash,
            type: bundle.command.type,
            scopeJson: stableSerialize(bundle.command.scope),
            payloadJson: stableSerialize(bundle.command.payload),
            reason: bundle.command.reason,
            actorType: bundle.command.author.type,
            actorId: bundle.command.author.id,
            delegatedUserId: bundle.command.author.delegatedUserId,
            ...editCommandExternalActorAuditData(
              bundle.authenticationAudit,
              bundle.command.workspaceId,
              bundle.command.author,
            ),
            idempotencyKey: bundle.command.idempotencyKey,
            requestFingerprint: bundle.requestFingerprint,
            createdAt: new Date(bundle.command.createdAt),
          },
        })
        await transaction.v2ProjectSnapshot.create({
          data: {
            id: bundle.snapshot.id,
            workspaceId: bundle.snapshot.workspaceId,
            projectId: bundle.snapshot.projectId,
            kind: bundle.snapshot.kind,
            schemaVersion: bundle.snapshot.contentSchemaVersion,
            contentJson: bundle.snapshot.contentJson,
            contentHash: bundle.snapshot.contentHash,
            createdAt: new Date(bundle.snapshot.createdAt),
          },
        })
        await transaction.v2ProjectVersion.create({
          data: {
            id: bundle.version.id,
            workspaceId: bundle.version.workspaceId,
            projectId: bundle.version.projectId,
            sequence: bundle.version.sequence,
            parentVersionId: bundle.version.parentVersionId,
            briefSnapshotId: bundle.version.snapshotRefs.brief!,
            editPlanSnapshotId: bundle.version.snapshotRefs.editPlan,
            policiesSnapshotId: bundle.version.snapshotRefs.policies,
            baseHash: bundle.version.baseHash,
            createdBy: bundle.version.createdBy,
            commandId: bundle.command.id,
            createdAt: new Date(bundle.version.createdAt),
          },
        })
        const invalidations = createMulticamDirectionInvalidations({
          impact: bundle.command.payload.impact,
          createdAt: bundle.command.createdAt,
        })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({
            data: invalidations.map((item) => ({
              id: item.id,
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              commandId: item.commandId,
              baseVersionId: item.baseVersionId,
              resultVersionId: item.resultVersionId,
              artifactId: item.artifactId,
              kind: item.kind,
              variantId: item.variantId,
              status: item.status,
              dependencyTypesJson: stableSerialize(item.dependencyTypes),
              affectedRangesJson: stableSerialize(item.affectedRanges),
              impactHash: item.impactHash,
              createdAt: new Date(item.createdAt),
            })),
          })
        }
        // The `currentVersionId` predicate is defence in depth and, under
        // SERIALIZABLE, provably unreachable: the project was read inside this
        // same transaction and a concurrent move would abort the transaction
        // (P2034, retried above) rather than slip between the read and this
        // UPDATE. It is kept because the isolation level is a line of
        // configuration and this is a line of the write itself, but no test
        // reaches it — deleting it leaves the E2E green, which is a statement
        // about the isolation level and not about the fence.
        const updated = await transaction.v2Project.updateMany({
          where: {
            id: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
            currentVersionId: bundle.command.baseVersionId,
          },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) {
          throw new DomainError('VERSION_CONFLICT', 'Project current version changed during multicam direction commit')
        }
        await transaction.v2PublicEventOutbox.create({
          data: {
            id: bundle.event.id,
            workspaceId: bundle.event.workspaceId,
            type: bundle.event.type,
            version: bundle.event.version,
            occurredAt: new Date(bundle.event.occurredAt),
            sequence: bundle.event.sequence,
            actorClientId: bundle.event.actor?.clientId,
            actorUserId: bundle.event.actor?.userId,
            resourceType: bundle.event.resource.type,
            resourceId: bundle.event.resource.id,
            dataJson: stableSerialize(bundle.event.data),
          },
        })
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({
          where: { id: bundle.command.id },
          include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
        })
        return hydrateStoredCommand(stored, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.commitOrReplay(bundle, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotentResult({
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          idempotencyKey: bundle.command.idempotencyKey,
          actorContextHash: bundle.authenticationAudit.contextHash,
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different multicam direction')
          }
          return Object.freeze({ ...existing.result, replayed: true })
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Multicam direction collided with persisted immutable state')
      }
      throw error
    }
  }
}
