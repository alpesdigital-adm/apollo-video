import type { MaterializedRenderInputV1, RenderInputSpecV1 } from '../domain/render-input.ts'
import {
  calculateSyntheticBuildIdentityHash,
  type SyntheticBuildIdentity,
} from '../domain/synthetic-build-attestation.ts'
import {
  assertSyntheticProductionRenderCheckpoint,
  syntheticProductionRenderOutputKey,
  type SyntheticProductionRenderCheckpoint,
} from '../domain/synthetic-production-render.ts'
import { DomainError } from '../domain/errors.ts'
import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { createReconstructableMediaArtifactManifest } from '../domain/media-artifact.ts'
import {
  calculateSyntheticProductionRenderQualityHash,
  type SyntheticProductionRenderQualityReport,
} from '../domain/synthetic-production-render.ts'
import { compileSyntheticPresenterRenderInputs } from './compile-synthetic-presenter-render.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ProtectedRenderInputStore } from './ports/protected-render-input-store.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { RenderInputRenderer, CommittedRenderReceipt, StagedRender } from './ports/render-input-renderer.ts'
import type { SyntheticProductionRenderRepository } from './ports/synthetic-production-render-repository.ts'
import type { SyntheticRenderOutputInspector } from './ports/synthetic-render-output-inspector.ts'
import type { SyntheticRenderOutputPromoter } from './ports/synthetic-render-output-promoter.ts'
import type { SyntheticRuntimeIdentityReader } from './ports/synthetic-runtime-identity-reader.ts'
import { linkAbortSignal } from './worker-lifecycle.ts'

export interface SyntheticProductionRenderWorkerOutcome {
  operationId: string
  status: 'succeeded' | 'waiting-attestation' | 'lease-lost' | 'retrying' | 'failed'
}

function sameIdentity(left: Readonly<SyntheticBuildIdentity>, right: Readonly<SyntheticBuildIdentity>): boolean {
  return calculateSyntheticBuildIdentityHash(left) === calculateSyntheticBuildIdentityHash(right)
}

function safeFailure(error: unknown) {
  const nonRetryable = error instanceof DomainError && [
    'INVALID_RENDER_INPUT', 'RENDER_OUTPUT_INVALID', 'RENDER_OUTPUT_CONFLICT',
    'PERSISTENCE_CONFLICT', 'ASSET_RIGHTS_BLOCKED', 'VERSION_CONFLICT',
    'PRECONDITION_REQUIRED', 'PROJECT_NOT_FOUND', 'AUTH_INVALID',
  ].includes(error.code)
  return Object.freeze({
    code: error instanceof DomainError ? error.code.toLowerCase() : 'synthetic_render_failed',
    message: 'Synthetic production render could not be completed',
    retryable: !nonRetryable,
  })
}

export function runNextSyntheticProductionRenderService(dependencies: {
  operations: PublicOperationRepository
  renders: SyntheticProductionRenderRepository
  protectedInputs: ProtectedRenderInputStore
  materialize(
    workspaceId: string,
    validUntil: string,
    input: Readonly<RenderInputSpecV1>,
    signal?: AbortSignal,
  ): Promise<Readonly<MaterializedRenderInputV1>>
  renderer: RenderInputRenderer
  inspector: SyntheticRenderOutputInspector
  promoter: SyntheticRenderOutputPromoter
  artifacts: MediaArtifactPersistenceRepository
  runtimeIdentity: SyntheticRuntimeIdentityReader
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryDelayMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  const retryDelayMs = dependencies.retryDelayMs ?? 5_000
  if (!Number.isSafeInteger(leaseDurationMs) || !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 || leaseDurationMs <= heartbeatIntervalMs ||
    !Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', 'Synthetic render worker timing is invalid')
  }
  const leaseUntil = (now: Date) => new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNextSyntheticProductionRender(
    leaseOwner: string,
    signal?: AbortSignal,
  ): Promise<Readonly<SyntheticProductionRenderWorkerOutcome> | null> {
    if (signal?.aborted) return null
    const finalizationAt = clock()
    const ready = await dependencies.renders.findReadyToFinalize({ now: finalizationAt.toISOString() })
    if (ready) {
      const resumed = await dependencies.operations.resumeWaiting({
        workspaceId: ready.workspaceId,
        operationId: ready.operationId,
        leaseOwner,
        attempt: ready.attempt,
        phase: 'persisting',
        now: finalizationAt.toISOString(),
        leaseUntil: leaseUntil(finalizationAt),
      })
      if (!resumed) return Object.freeze({ operationId: ready.operationId, status: 'lease-lost' })
      try {
        const completed = await dependencies.renders.finalizeAttested({
          operationId: ready.operationId,
          leaseOwner,
          attempt: ready.attempt,
          now: clock().toISOString(),
        })
        return Object.freeze({
          operationId: ready.operationId,
          status: completed ? 'succeeded' : 'lease-lost',
        })
      } catch (error) {
        const failure = safeFailure(error)
        const failedAt = clock()
        const result = await dependencies.operations.failOrRetry({
          operationId: ready.operationId,
          leaseOwner,
          attempt: ready.attempt,
          now: failedAt.toISOString(),
          error: failure,
          ...(failure.retryable ? { nextAttemptAt: new Date(failedAt.getTime() + retryDelayMs).toISOString() } : {}),
        })
        return Object.freeze({
          operationId: ready.operationId,
          status: result?.operation.status === 'retrying' ? 'retrying' : 'failed',
        })
      }
    }
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner,
      now: claimedAt.toISOString(),
      leaseUntil: leaseUntil(claimedAt),
      type: 'synthetic-production-render',
    })
    if (!claimed) return null
    if (claimed.context.kind !== 'synthetic-production-render') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render worker claimed an incompatible operation')
    }
    const operationId = claimed.operation.id
    const attempt = claimed.lease.attempt
    const controller = new AbortController()
    const unlink = linkAbortSignal(signal, controller)
    let stopped = false
    let leaseLost = false
    let renewal: Promise<boolean> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let staged: StagedRender | undefined
    let committed = false
    const command = (now: Date) => ({ operationId, leaseOwner, attempt, now: now.toISOString() })
    const heartbeat = async (): Promise<boolean> => {
      if (stopped || leaseLost) return false
      if (renewal) return renewal
      renewal = (async () => {
        try {
          const now = clock()
          const ok = await dependencies.operations.heartbeat({
            ...command(now),
            leaseUntil: leaseUntil(now),
          })
          if (!ok) {
            leaseLost = true
            controller.abort()
          }
          return ok
        } catch {
          leaseLost = true
          controller.abort()
          return false
        } finally {
          renewal = undefined
        }
      })()
      return renewal
    }
    const schedule = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => {
        await heartbeat()
        schedule()
      }, heartbeatIntervalMs)
      timer.unref?.()
    }
    try {
      const binding = await dependencies.renders.readBinding({ workspaceId: claimed.operation.workspaceId, operationId })
      if (!binding || binding.context.contextHash !== claimed.context.contextHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render binding is unavailable or changed')
      }
      const entered = await dependencies.operations.advancePhase({ ...command(clock()), phase: 'materializing' })
      if (!entered) return Object.freeze({ operationId, status: 'lease-lost' })
      schedule()
      const spec = await dependencies.protectedInputs.read(
        claimed.operation.workspaceId,
        binding.context.renderInputRef,
        binding.context.renderInputHash,
      )
      if (!spec || spec.inputHash !== binding.context.renderInputHash ||
        spec.composition.propsHash !== binding.context.propsHash ||
        spec.plan.hash !== binding.context.planHash ||
        spec.plan.versionId !== binding.context.projectVersionId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Protected synthetic RenderInput does not match its operation')
      }
      const recompiled = compileSyntheticPresenterRenderInputs({
        plan: binding.plan,
        renderer: spec.renderer,
        aspectRatio: binding.context.aspectRatio,
      })
      const canonical = binding.context.outputKind === 'proxy' ? recompiled.proxy : recompiled.final
      if (stableSerialize(canonical) !== stableSerialize(spec)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Protected synthetic RenderInput does not match the persisted production plan')
      }
      const runtimeBefore = await dependencies.runtimeIdentity.read({ signal: controller.signal })
      if (spec.renderer.digest !== runtimeBefore.toolchainHash) {
        throw new DomainError('VERSION_CONFLICT', 'Synthetic RenderInput renderer toolchain changed before execution')
      }
      const materialized = await dependencies.materialize(
        claimed.operation.workspaceId,
        binding.plan.authorization.expiresAt,
        spec,
        controller.signal,
      )
      if (!(await heartbeat())) return Object.freeze({ operationId, status: 'lease-lost' })
      const rendering = await dependencies.operations.advancePhase({ ...command(clock()), phase: 'rendering' })
      if (!rendering) return Object.freeze({ operationId, status: 'lease-lost' })

      let receipt: Readonly<CommittedRenderReceipt>
      if (binding.checkpoint) {
        if (!sameIdentity(binding.checkpoint.runtimeIdentity, runtimeBefore)) {
          throw new DomainError('VERSION_CONFLICT', 'Persisted render checkpoint belongs to a different runtime identity')
        }
        const recovered = await dependencies.renderer.recover(materialized, { outputKey: binding.checkpoint.outputKey })
        if (!recovered || recovered.outputSha256 !== binding.checkpoint.outputSha256 ||
          recovered.inputHash !== binding.context.renderInputHash || recovered.byteSize !== binding.checkpoint.byteSize) {
          throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Persisted render checkpoint output cannot be recovered exactly')
        }
        receipt = recovered
      } else {
        const outputKey = syntheticProductionRenderOutputKey({
          operationId,
          outputArtifactId: binding.context.outputArtifactId,
          attempt,
          outputKind: binding.context.outputKind,
        })
        staged = await dependencies.renderer.stage(materialized, { outputKey, signal: controller.signal })
        if (!(await heartbeat())) return Object.freeze({ operationId, status: 'lease-lost' })
        receipt = await staged.commit()
        committed = true
        if (receipt.inputHash !== binding.context.renderInputHash) {
          throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Renderer receipt does not match the protected RenderInput')
        }
      }
      const runtimeAfter = await dependencies.runtimeIdentity.read({ signal: controller.signal })
      if (!sameIdentity(runtimeBefore, runtimeAfter)) {
        throw new DomainError('VERSION_CONFLICT', 'Synthetic render runtime identity changed during execution')
      }
      const measured = await dependencies.inspector.inspect({
        outputKey: binding.checkpoint?.outputKey ?? syntheticProductionRenderOutputKey({
          operationId,
          outputArtifactId: binding.context.outputArtifactId,
          attempt,
          outputKind: binding.context.outputKind,
        }),
        expectedSha256: receipt.outputSha256,
        expectedByteSize: receipt.byteSize,
        signal: controller.signal,
      })
      const verifying = await dependencies.operations.advancePhase({ ...command(clock()), phase: 'verifying' })
      if (!verifying) return Object.freeze({ operationId, status: 'lease-lost' })
      if (!binding.checkpoint) {
        const recordedAt = clock().toISOString()
        const value: SyntheticProductionRenderCheckpoint = {
          operationId,
          outputArtifactId: binding.context.outputArtifactId,
          attempt,
          outputKind: binding.context.outputKind,
          renderInputHash: binding.context.renderInputHash,
          outputKey: syntheticProductionRenderOutputKey({
            operationId,
            outputArtifactId: binding.context.outputArtifactId,
            attempt,
            outputKind: binding.context.outputKind,
          }),
          outputSha256: receipt.outputSha256,
          byteSize: receipt.byteSize,
          width: measured.width,
          height: measured.height,
          fps: measured.fps,
          durationInFrames: measured.durationInFrames,
          codec: measured.codec as 'h264',
          audioCodec: measured.audioCodec as 'aac',
          container: measured.container as 'mp4',
          runtimeIdentity: runtimeAfter,
          runtimeIdentityHash: calculateSyntheticBuildIdentityHash(runtimeAfter),
          committedAt: receipt.committedAt,
          recordedAt,
        }
        assertSyntheticProductionRenderCheckpoint(value)
        if (!(await dependencies.renders.recordCheckpoint({ ...command(clock()), checkpoint: value }))) {
          leaseLost = true
          return Object.freeze({ operationId, status: 'lease-lost' })
        }
      }
      const persistedBinding = await dependencies.renders.readBinding({
        workspaceId: claimed.operation.workspaceId,
        operationId,
      })
      if (!persistedBinding?.checkpoint) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render checkpoint disappeared before persistence')
      }
      const persistedCheckpoint = persistedBinding.checkpoint
      if (!persistedBinding.qualityReport) {
        const promoted = await dependencies.promoter.promote({
          workspaceId: claimed.operation.workspaceId,
          outputKey: persistedCheckpoint.outputKey,
          sha256: persistedCheckpoint.outputSha256,
          byteSize: persistedCheckpoint.byteSize,
        })
        const manifest = createReconstructableMediaArtifactManifest({
          artifactKey: promoted.artifactKey,
          artifactSha256: promoted.sha256,
          byteSize: promoted.byteSize,
          mediaType: 'video',
          container: 'mp4',
          recipe: {
            id: 'synthetic-production-render',
            version: 'v1',
            parameters: {
              operationId,
              contextHash: persistedBinding.context.contextHash,
              outputKind: persistedBinding.context.outputKind,
              aspectRatio: persistedBinding.context.aspectRatio,
              runtimeIdentityHash: persistedCheckpoint.runtimeIdentityHash,
            },
          },
          sources: spec.assets.map((asset) => ({
            artifactKey: asset.artifactKey,
            sha256: asset.sha256,
            role: asset.role,
            execution: {
              tool: {
                id: 'remotion',
                version: spec.renderer.version,
                digest: persistedCheckpoint.runtimeIdentityHash,
              },
            },
          })),
          probe: {
            width: persistedCheckpoint.width,
            height: persistedCheckpoint.height,
            duration: persistedCheckpoint.durationInFrames / persistedCheckpoint.fps,
            fps: persistedCheckpoint.fps,
          },
          renderInput: spec,
        })
        await dependencies.artifacts.persistOrReplay({
          workspaceId: claimed.operation.workspaceId,
          artifactId: persistedBinding.context.outputArtifactId,
          manifestId: persistedBinding.context.outputManifestId,
          lineageIds: spec.assets.map((asset, ordinal) =>
            `lineage-${calculateCanonicalHash({ operationId, artifactId: asset.artifactId, ordinal }).slice(0, 64)}`),
          manifest: manifest.manifest,
          recipeParameters: manifest.recipeParameters,
          renderInput: manifest.renderInput,
          createdAt: clock().toISOString(),
        })
        const expected = Object.freeze({
          width: spec.output.width,
          height: spec.output.height,
          fps: spec.output.fps,
          durationInFrames: spec.output.durationInFrames,
          codec: 'h264' as const,
          audioCodec: 'aac' as const,
          container: 'mp4' as const,
        })
        const actual = Object.freeze({
          width: persistedBinding.checkpoint.width,
          height: persistedBinding.checkpoint.height,
          fps: persistedBinding.checkpoint.fps,
          durationInFrames: persistedBinding.checkpoint.durationInFrames,
          codec: persistedBinding.checkpoint.codec,
          audioCodec: persistedBinding.checkpoint.audioCodec,
          container: persistedBinding.checkpoint.container,
          decodable: true,
        })
        const passed = stableSerialize(expected) === stableSerialize({
          width: actual.width,
          height: actual.height,
          fps: actual.fps,
          durationInFrames: actual.durationInFrames,
          codec: actual.codec,
          audioCodec: actual.audioCodec,
          container: actual.container,
        })
        const reportBody = {
          schemaVersion: 'synthetic-production-render-quality/v1' as const,
          id: `synthetic-render-quality-${calculateCanonicalHash({ operationId }).slice(0, 48)}`,
          workspaceId: claimed.operation.workspaceId,
          projectId: persistedBinding.context.projectId,
          projectVersionId: persistedBinding.context.projectVersionId,
          productionRunId: persistedBinding.context.productionRunId,
          publicOperationId: operationId,
          editPlanSnapshotId: persistedBinding.context.editPlanSnapshotId,
          planHash: persistedBinding.context.planHash,
          renderInputHash: persistedBinding.context.renderInputHash,
          propsHash: persistedBinding.context.propsHash,
          outputKind: persistedBinding.context.outputKind,
          outputArtifactId: persistedBinding.context.outputArtifactId,
          outputManifestId: persistedBinding.context.outputManifestId,
          outputSha256: persistedBinding.checkpoint.outputSha256,
          byteSize: persistedBinding.checkpoint.byteSize,
          expected,
          measured: actual,
          runtimeIdentityHash: persistedBinding.checkpoint.runtimeIdentityHash,
          issues: passed ? Object.freeze([]) : Object.freeze([Object.freeze({
            code: 'RENDER_CONTRACT_MISMATCH',
            severity: 'error' as const,
            message: 'Decoded MP4 dimensions, timing or codecs differ from the canonical RenderInput.',
          })]),
          passed,
          evaluatedAt: clock().toISOString(),
        }
        const report: SyntheticProductionRenderQualityReport = {
          ...reportBody,
          reportHash: calculateSyntheticProductionRenderQualityHash(reportBody),
        }
        if (!(await dependencies.renders.recordQuality({ ...command(clock()), report }))) {
          leaseLost = true
          return Object.freeze({ operationId, status: 'lease-lost' })
        }
        if (!passed) throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render output differs from its canonical RenderInput')
      }
      const waiting = await dependencies.operations.wait(command(clock()))
      if (!waiting) {
        leaseLost = true
        return Object.freeze({ operationId, status: 'lease-lost' })
      }
      return Object.freeze({ operationId, status: 'waiting-attestation' })
    } catch (error) {
      if (leaseLost) return Object.freeze({ operationId, status: 'lease-lost' })
      const failure = safeFailure(error)
      const now = clock()
      const result = await dependencies.operations.failOrRetry({
        ...command(now),
        error: failure,
        ...(failure.retryable ? { nextAttemptAt: new Date(now.getTime() + retryDelayMs).toISOString() } : {}),
      })
      return Object.freeze({
        operationId,
        status: result?.operation.status === 'retrying' ? 'retrying' : 'failed',
      })
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
      if (renewal) await renewal.catch(() => false)
      unlink.dispose()
      if (staged && !committed) await staged.discard().catch(() => undefined)
    }
  }
}
