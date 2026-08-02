import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  assetRightsRevision,
  createAssetRightsSnapshot,
  evaluateAssetUse,
} from '../domain/asset-rights.ts'
import { DomainError } from '../domain/errors.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import {
  createPostCleanupReview,
} from '../domain/source-cleanup.ts'
import { calculateFileSha256 } from '../infrastructure/media/local-artifact-manifest.ts'
import type {
  AssetRightsRepository,
} from './ports/asset-rights-repository.ts'
import type {
  MediaArtifactPersistenceRepository,
} from './ports/media-artifact-repository.ts'
import type {
  MediaArtifactQueryRepository,
} from './ports/media-artifact-query-repository.ts'
import type {
  VerifiedMediaStorage,
} from './ports/media-ingest.ts'
import type {
  ProjectWorkspaceQueryRepository,
} from './ports/project-workspace-query-repository.ts'
import type {
  PublicOperationRepository,
} from './ports/public-operation-repository.ts'
import type {
  SourceCleanupProcessor,
} from './ports/source-cleanup-processor.ts'
import type { OperationTelemetrySink } from './ports/operation-telemetry.ts'
import { runPublicOperationSpan } from './public-operation-span-telemetry.ts'
import type {
  SourceCleanupRepository,
} from './ports/source-cleanup-repository.ts'
import {
  calculatePublicOperationRetryDelayMs,
  type PublicOperationWorkerOutcome,
} from './run-public-operation-worker.ts'

const NON_RETRYABLE_CODES = new Set([
  'ASSET_RIGHTS_BLOCKED',
  'INVALID_RENDER_INPUT',
  'RENDER_OUTPUT_INVALID',
  'PERSISTENCE_CONFLICT',
  'PERSISTENCE_NOT_CONFIGURED',
  'SOURCE_CLEANUP_NOT_FOUND',
])

function safeFailure(error: unknown) {
  const retryable = !(
    error instanceof DomainError &&
    NON_RETRYABLE_CODES.has(error.code)
  )
  return {
    code: error instanceof DomainError
      ? error.code.toLowerCase()
      : 'source_cleanup_failed',
    message: 'Source cleanup could not be completed',
    retryable,
  }
}

function resolveArtifactPath(rootValue: string, key: string): string {
  const root = resolve(rootValue)
  if (
    !rootValue.trim() ||
    !isAbsolute(root) ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some((part) =>
      !part || part === '.' || part === '..')
  ) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Source cleanup artifact storage is invalid',
    )
  }
  const candidate = join(root, ...key.split('/'))
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Source cleanup source escaped artifact storage',
    )
  }
  return candidate
}

export function runNextSourceCleanupOperationService(dependencies: {
  operations: PublicOperationRepository
  cleanups: SourceCleanupRepository
  mediaArtifacts: MediaArtifactQueryRepository
  artifacts: MediaArtifactPersistenceRepository
  rights: AssetRightsRepository
  projects: ProjectWorkspaceQueryRepository
  storage: VerifiedMediaStorage
  processor: SourceCleanupProcessor
  artifactRoot: string
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  telemetry?: OperationTelemetrySink
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const heartbeatIntervalMs =
    dependencies.heartbeatIntervalMs ?? 10_000
  const retryBaseDelayMs =
    dependencies.retryBaseDelayMs ?? 5_000
  const retryMaxDelayMs =
    dependencies.retryMaxDelayMs ?? 300_000
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    leaseDurationMs <= heartbeatIntervalMs ||
    !Number.isSafeInteger(retryBaseDelayMs) ||
    retryBaseDelayMs <= 0 ||
    !Number.isSafeInteger(retryMaxDelayMs) ||
    retryMaxDelayMs < retryBaseDelayMs
  ) {
    throw new DomainError(
      'INVALID_PUBLIC_OPERATION',
      'Source cleanup worker lease configuration is invalid',
    )
  }
  const leaseWindow = (now: Date) =>
    new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(
    leaseOwner: string,
  ): Promise<Readonly<PublicOperationWorkerOutcome> | null> {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner,
      now: claimedAt.toISOString(),
      leaseUntil: leaseWindow(claimedAt),
      type: 'source-cleanup',
    })
    if (!claimed) return null
    if (claimed.context.kind !== 'source-cleanup') {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Source cleanup worker claimed an incompatible operation',
      )
    }
    const { operation, context } = claimed
    const attempt = claimed.lease.attempt
    const abortController = new AbortController()
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    let leaseCommandTail: Promise<void> = Promise.resolve()
    const command = (now: Date) => ({
      operationId: operation.id,
      leaseOwner,
      attempt,
      now: now.toISOString(),
    })
    const withLeaseCommand = <T>(
      action: () => Promise<T>,
    ): Promise<T> => {
      const result = leaseCommandTail.then(action)
      leaseCommandTail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    const heartbeat = async () => {
      if (stopped || leaseLost) return false
      if (renewal) return renewal
      renewal = withLeaseCommand(async () => {
        if (stopped || leaseLost) return !leaseLost
        try {
          const now = clock()
          const renewed = await dependencies.operations.heartbeat({
            ...command(now),
            leaseUntil: leaseWindow(now),
          })
          if (!renewed) {
            leaseLost = true
            abortController.abort()
          }
          return renewed
        } catch {
          leaseLost = true
          abortController.abort()
          return false
        } finally {
          renewal = undefined
        }
      })
      return renewal
    }
    const scheduleHeartbeat = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => {
        await heartbeat()
        scheduleHeartbeat()
      }, heartbeatIntervalMs)
      timer.unref?.()
    }
    const stopHeartbeat = () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    const enter = async (
      phase: 'rendering' | 'verifying' | 'persisting',
    ) => {
      const entered = await withLeaseCommand(() =>
        dependencies.operations.advancePhase({
          ...command(clock()),
          phase,
        }))
      if (!entered) {
        leaseLost = true
        abortController.abort()
        throw new DomainError(
          'RENDER_EXECUTION_FAILED',
          'Source cleanup lease was lost',
        )
      }
    }
    try {
      scheduleHeartbeat()
      const cleanup = await dependencies.cleanups.read({
        workspaceId: operation.workspaceId,
        projectId: context.projectId,
        cleanupPlanId: context.cleanupPlanId,
      })
      if (
        !cleanup ||
        cleanup.plan.planHash !== context.cleanupPlanHash ||
        cleanup.plan.decision !== 'execute' ||
        cleanup.plan.selectedStrategy === 'reject' ||
        cleanup.plan.operationId !== operation.id
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Immutable source cleanup plan disappeared or changed',
        )
      }
      const [source, project, sourceRights] = await Promise.all([
        dependencies.mediaArtifacts.findById(
          operation.workspaceId,
          context.sourceArtifactId,
        ),
        dependencies.projects.read({
          workspaceId: operation.workspaceId,
          projectId: context.projectId,
        }),
        dependencies.rights.findCurrent(
          operation.workspaceId,
          context.sourceArtifactId,
        ),
      ])
      const sourceManifest = source?.manifests.find((manifest) =>
        manifest.id === context.sourceManifestId)
      if (
        !source ||
        source.status !== 'available' ||
        source.sha256 !== context.sourceArtifactSha256 ||
        !sourceManifest
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Source cleanup input artifact or manifest is no longer immutable and available',
        )
      }
      const locale = project?.project.locale
      if (!project || typeof locale !== 'string' || !locale) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Source cleanup project locale is unavailable',
        )
      }
      if (
        !sourceRights?.snapshot ||
        sourceRights.snapshot.id !==
          cleanup.plan.rightsSnapshotId ||
        sourceRights.snapshot.snapshotHash !==
          cleanup.plan.rightsSnapshotHash
      ) {
        throw new DomainError(
          'ASSET_RIGHTS_BLOCKED',
          'Source cleanup rights snapshot changed after planning',
        )
      }
      const sourceRightsDecision = evaluateAssetUse(
        sourceRights.snapshot,
        {
          workspaceId: operation.workspaceId,
          use: 'editing',
          locale,
        },
        clock(),
      )
      if (sourceRightsDecision.outcome !== 'allow') {
        throw new DomainError(
          'ASSET_RIGHTS_BLOCKED',
          'Source artifact no longer permits cleanup editing',
          { reasonCodes: sourceRightsDecision.reasonCodes },
        )
      }
      const sourcePath = resolveArtifactPath(
        dependencies.artifactRoot,
        source.artifactKey,
      )
      const sourceShaBefore = await calculateFileSha256(sourcePath)
      if (sourceShaBefore !== context.sourceArtifactSha256) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Source cleanup file checksum does not match the catalog',
        )
      }
      await enter('rendering')
      const processCleanup = () => dependencies.processor.process({
        operationId: operation.id,
        sourcePath,
        sourceDurationMs: cleanup.plan.sourceDurationMs,
        action: cleanup.plan.selectedAction as Exclude<
          typeof cleanup.plan.selectedAction,
          { strategy: 'reject' }
        >,
        signal: abortController.signal,
      })
      const processed = dependencies.telemetry
        ? await runPublicOperationSpan({
            telemetry: dependencies.telemetry,
            record: claimed,
            spanKind: 'renderer',
            spanName: 'ffmpeg-source-cleanup',
            clock,
            action: processCleanup,
          })
        : await processCleanup()
      await enter('verifying')
      const sourceShaAfter = await calculateFileSha256(sourcePath)
      if (
        sourceShaAfter !== sourceShaBefore ||
        sourceShaAfter !== context.sourceArtifactSha256
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Source cleanup mutated its immutable source',
        )
      }
      if (!(await heartbeat())) {
        throw new DomainError(
          'RENDER_EXECUTION_FAILED',
          'Source cleanup lease was lost',
        )
      }
      await enter('persisting')
      const stored = await dependencies.storage.promoteDerived({
        workspaceId: operation.workspaceId,
        sourcePath: processed.outputPath,
        sha256: processed.sha256,
        extension: 'mp4',
        prefix: 'cleaned',
      })
      const toolDigest = createHash('sha256')
        .update('apollo-v2-ffmpeg-source-cleanup/1.0.0')
        .digest('hex')
      const manifest = createMediaArtifactManifestV2({
        artifactKey: stored.key,
        artifactSha256: stored.sha256,
        byteSize: stored.byteSize,
        mediaType: 'video',
        container: 'mp4',
        recipe: {
          id: 'source-cleanup',
          version: '1.0.0',
          parameters: {
            cleanupPlanId: cleanup.plan.id,
            cleanupPlanHash: cleanup.plan.planHash,
            strategy: cleanup.plan.selectedStrategy,
            action: cleanup.plan.selectedAction,
            sourceImmutable: true,
          },
        },
        sources: [{
          artifactKey: source.artifactKey,
          sha256: source.sha256,
          role: 'source-master',
          execution: {
            tool: {
              id: 'ffmpeg',
              version: 'static',
              digest: toolDigest,
            },
          },
        }],
        probe: {
          width: processed.probe.width,
          height: processed.probe.height,
          duration: processed.probe.duration,
          fps: processed.probe.fps,
        },
      })
      const persisted = await dependencies.artifacts.persistOrReplay({
        workspaceId: operation.workspaceId,
        artifactId: context.outputArtifactId,
        manifestId: context.outputManifestId,
        lineageIds: [
          `lineage-${createHash('sha256')
            .update(
              `${operation.workspaceId}:${cleanup.plan.planHash}:` +
              `${source.id}:0`,
            )
            .digest('hex')}`,
        ],
        manifest,
        createdAt: clock().toISOString(),
      })
      if (
        persisted.artifactId !== context.outputArtifactId ||
        persisted.manifestId !== context.outputManifestId
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Source cleanup derivative identity did not converge',
        )
      }
      const sourceSnapshot = sourceRights.snapshot
      const outputRightsPrototype = createAssetRightsSnapshot({
        id: `rights-cleanup-${cleanup.plan.planHash.slice(0, 32)}`,
        workspaceId: operation.workspaceId,
        artifactId: context.outputArtifactId,
        sequence: 1,
        draft: {
          ...(sourceSnapshot.owner
            ? { owner: sourceSnapshot.owner }
            : {}),
          ...(sourceSnapshot.license
            ? { license: sourceSnapshot.license }
            : {}),
          status: sourceSnapshot.status,
          allowedUses: sourceSnapshot.allowedUses,
          prohibitedUses: sourceSnapshot.prohibitedUses,
          ...(sourceSnapshot.allowedMarkets
            ? { allowedMarkets: sourceSnapshot.allowedMarkets }
            : {}),
          ...(sourceSnapshot.allowedLocales
            ? { allowedLocales: sourceSnapshot.allowedLocales }
            : {}),
          ...(sourceSnapshot.allowedSyntheticOperations
            ? {
                allowedSyntheticOperations:
                  sourceSnapshot.allowedSyntheticOperations,
              }
            : {}),
          ...(sourceSnapshot.expiresAt
            ? { expiresAt: sourceSnapshot.expiresAt }
            : {}),
          consent: {
            status: sourceSnapshot.consent.status,
            allowedUses: sourceSnapshot.consent.allowedUses,
            ...(sourceSnapshot.consent.allowedMarkets
              ? {
                  allowedMarkets:
                    sourceSnapshot.consent.allowedMarkets,
                }
              : {}),
            ...(sourceSnapshot.consent.allowedLocales
              ? {
                  allowedLocales:
                    sourceSnapshot.consent.allowedLocales,
                }
              : {}),
            ...(sourceSnapshot.consent
              .allowedSyntheticOperations
              ? {
                  allowedSyntheticOperations:
                    sourceSnapshot.consent
                      .allowedSyntheticOperations,
                }
              : {}),
            ...(sourceSnapshot.consent.expiresAt
              ? { expiresAt: sourceSnapshot.consent.expiresAt }
              : {}),
            ...(sourceSnapshot.consent.documentArtifactId
              ? {
                  documentArtifactId:
                    sourceSnapshot.consent.documentArtifactId,
                }
              : {}),
          },
          ...(sourceSnapshot.sourceNote
            ? { sourceNote: sourceSnapshot.sourceNote }
            : {}),
        },
        createdBy: {
          type: 'system',
          id: 'apollo-source-cleanup',
        },
        createdAt: cleanup.plan.createdAt,
      })
      const outputRights = await dependencies.rights.setCurrent(
        outputRightsPrototype,
        assetRightsRevision(context.outputArtifactId, 0),
      )
      const outputRightsDecision = evaluateAssetUse(
        outputRights.snapshot,
        {
          workspaceId: operation.workspaceId,
          use: 'editing',
          locale,
        },
        clock(),
      )
      const review = createPostCleanupReview({
        plan: cleanup.plan,
        outputArtifactId: context.outputArtifactId,
        outputArtifactSha256: stored.sha256,
        outputManifestId: context.outputManifestId,
        outputRightsSnapshotId: outputRights.snapshot.id,
        outputRightsSnapshotHash:
          outputRights.snapshot.snapshotHash,
        visual: processed.visual,
        rightsReasonCodes:
          outputRightsDecision.outcome === 'allow'
            ? []
            : outputRightsDecision.reasonCodes,
        reviewedAt: clock(),
      })
      await dependencies.cleanups.persistReview({ review })
      if (!review.passed) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Source cleanup derivative failed mandatory post-cleanup review',
          {
            visualReasonCodes: review.visual.reasonCodes,
            rightsReasonCodes: review.rights.reasonCodes,
          },
        )
      }
      if (!(await heartbeat())) {
        throw new DomainError(
          'RENDER_EXECUTION_FAILED',
          'Source cleanup lease was lost',
        )
      }
      stopHeartbeat()
      const succeeded = await withLeaseCommand(() =>
        dependencies.operations.succeed(command(clock())))
      if (!succeeded) {
        return Object.freeze({
          operationId: operation.id,
          status: 'lease-lost' as const,
        })
      }
      await dependencies.processor.cleanup(operation.id)
        .catch(() => undefined)
      return Object.freeze({
        operationId: operation.id,
        status: 'succeeded' as const,
      })
    } catch (error) {
      stopHeartbeat()
      if (leaseLost) {
        return Object.freeze({
          operationId: operation.id,
          status: 'lease-lost' as const,
        })
      }
      const failedAt = clock()
      const failure = safeFailure(error)
      const nextAttemptAt =
        failure.retryable && attempt < operation.maxAttempts
          ? new Date(
              failedAt.getTime() +
              calculatePublicOperationRetryDelayMs({
                attempt,
                baseDelayMs: retryBaseDelayMs,
                maxDelayMs: retryMaxDelayMs,
              }),
            ).toISOString()
          : undefined
      const failed = await withLeaseCommand(() =>
        dependencies.operations.failOrRetry({
          ...command(failedAt),
          error: failure,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        }))
      if (!failed) {
        return Object.freeze({
          operationId: operation.id,
          status: 'lease-lost' as const,
        })
      }
      await dependencies.processor.cleanup(operation.id)
        .catch(() => undefined)
      return Object.freeze({
        operationId: operation.id,
        status: failed.operation.status === 'retrying'
          ? 'retrying' as const
          : 'failed' as const,
      })
    } finally {
      stopHeartbeat()
    }
  }
}
