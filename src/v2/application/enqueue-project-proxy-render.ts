import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../domain/public-operation.ts'
import type { ProjectProxyRenderRepository } from './ports/project-proxy-render-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { RenderablePlanSnapshotRepository } from './ports/renderable-plan-snapshot-repository.ts'
import { projectProxyRenderContentHash, projectProxyRenderInputHash, sourceOutputVariantId } from './project-render-sources.ts'
import { resolveRenderColorPipelineBindings } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(normalized.length >= 3 && normalized.length <= 128, 'INVALID_ARGUMENT', `${field} must contain 3 to 128 characters`)
  return normalized
}

export function enqueueRenderableSnapshotProxyRenderService(dependencies: {
  projects: ProjectProxyRenderRepository
  snapshots: RenderablePlanSnapshotRepository
  operations: PublicOperationRepository
  colorPipelines: ColorPipelineCompilationRepository
  clock: () => Date
  createId: (kind: 'operation' | 'artifact' | 'manifest') => string
}) {
  return async function enqueue(request: {
    workspaceId: string
    projectId: string
    planId: string
    planHash: string
    origin: 'localization' | 'music-led-montage'
    sourceId: string
    sourceHash: string
    variantId: string
    format: string
    /** The State variant of the plan's Version to consume (`variantId` above is the localization variant); absent means that State's only output. */
    outputVariantId?: string
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const outputVariantId = request.outputVariantId === undefined ? undefined : validateId(request.outputVariantId, 'outputVariantId')
    const planId = validateId(request.planId, 'planId')
    const sourceId = validateId(request.sourceId, 'sourceId')
    const variantId = validateId(request.variantId, 'variantId')
    assertDomain(/^[a-f0-9]{64}$/.test(request.planHash) && /^[a-f0-9]{64}$/.test(request.sourceHash), 'INVALID_ARGUMENT', 'Snapshot hashes must be SHA-256 values')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match proxy request')
    const clientId = validateId(audit.clientId, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 characters')
    const snapshot = await dependencies.snapshots.readByPlan({ workspaceId, projectId, planId, planHash: request.planHash })
    if (!snapshot || snapshot.origin !== request.origin || snapshot.sourceId !== sourceId || snapshot.sourceHash !== request.sourceHash) {
      throw new DomainError('VERSION_CONFLICT', 'Renderable snapshot authority does not match the requested source')
    }
    if (request.origin === 'localization' && !snapshot.plan.localeVariantRefs.includes(variantId as never)) {
      throw new DomainError('VERSION_CONFLICT', 'Renderable localization snapshot is not bound to the requested variant')
    }
    const requestFingerprint = calculateVersionHash({
      type: 'renderable-snapshot-proxy-request/v1', projectId,
      snapshot: { planId, planHash: request.planHash, origin: request.origin, sourceId, sourceHash: request.sourceHash, variantId, format: request.format },
      ...(outputVariantId === undefined ? {} : { outputVariantId }),
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.operations.findReplay({ workspaceId, clientId, actorContextHash: audit.contextHash, idempotencyKey, requestFingerprint })
    if (replay) return replay
    const source = await dependencies.projects.readRenderableSnapshotSource({ workspaceId, projectId, planId, planHash: request.planHash, format: request.format,
      ...(outputVariantId === undefined ? {} : { variantId: outputVariantId }) })
    if (!source) throw new DomainError('PROJECT_NOT_FOUND', 'Renderable snapshot source media was not found')
    const colorPipelineBindings = await resolveRenderColorPipelineBindings({ repository: dependencies.colorPipelines, workspaceId, projectId, sources: source.renderSources })
    const inputHash = calculateVersionHash({
      type: 'renderable-snapshot-proxy/v1',
      snapshot: { planId, planHash: request.planHash, origin: request.origin, sourceId, sourceHash: request.sourceHash, variantId, format: request.format },
      renderInputHash: projectProxyRenderInputHash({ source, colorPipelineBindings }),
    })
    const operationId = dependencies.createId('operation')
    const outputArtifactId = dependencies.createId('artifact')
    const outputManifestId = dependencies.createId('manifest')
    const now = dependencies.clock().toISOString()
    const operation = createQueuedPublicOperation({ id: operationId, workspaceId, projectId, clientId, type: 'project-proxy-render', target: { type: 'media-artifact', id: outputArtifactId, manifestId: outputManifestId }, createdAt: now })
    return dependencies.operations.createOrReplay({
      operation,
      authenticationAudit: audit,
      context: {
        kind: 'project-proxy-render', projectId, projectVersionId: source.projectVersionId,
        editPlanSnapshotId: source.editPlanSnapshotId, sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId, colorPipelineBindings, inputHash,
        outputArtifactId, outputManifestId,
        // The output the sealed consumption named (the localization variant below is a different thing).
        outputVariantId: sourceOutputVariantId(source),
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 180)}-${request.origin}-${request.format.replace(':', 'x')}.mp4`,
        renderableSnapshot: { planId, planHash: request.planHash, origin: request.origin, sourceId, sourceHash: request.sourceHash, variantId, format: request.format },
      },
      idempotencyKey, requestFingerprint, traceId: request.traceId,
    })
  }
}

export function enqueueProjectProxyRenderService(dependencies: {
  projects: ProjectProxyRenderRepository
  operations: PublicOperationRepository
  colorPipelines: ColorPipelineCompilationRepository
  clock: () => Date
  createId: (kind: 'operation' | 'artifact' | 'manifest') => string
}) {
  return async function enqueue(request: {
    workspaceId: string
    projectId: string
    expectedProjectVersionId?: string
    /**
     * The stable State variant to render. Optional ONLY when the State has exactly one output: with several, a caller that names
     * none is refused (`output-variant-required`), a stranger is refused (`output-variant-unknown`), and two outputs of one aspect
     * ratio are refused (`output-variant-ambiguous`). The persisted verdict decides; nothing here chooses an output.
     */
    variantId?: string
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const variantId = request.variantId === undefined ? undefined : validateId(request.variantId, 'variantId')
    const expectedProjectVersionId = request.expectedProjectVersionId
      ? validateId(request.expectedProjectVersionId, 'expectedProjectVersionId')
      : undefined
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match proxy request')
    const clientId = validateId(audit.clientId, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 characters')
    // The head Version, consumed for the proxy render: the persisted verdict refuses (with its published reason) what may not be
    // rendered, and the seal of what was read goes into the input hash below.
    const source = await dependencies.projects.readCurrentSource({ workspaceId, projectId, purpose: 'render',
      ...(variantId === undefined ? {} : { variantId }) })
    if (!source) throw new DomainError('PROJECT_NOT_FOUND', 'Project with a compiled EditPlan and source master was not found')
    if (expectedProjectVersionId && source.projectVersionId !== expectedProjectVersionId) {
      throw new DomainError('VERSION_CONFLICT', 'Project changed before proxy enqueue', {
        expectedProjectVersionId,
        currentProjectVersionId: source.projectVersionId,
      })
    }
    if (source.unchangedReuseRequired && !source.unchangedReuse) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Render-free project change requires a completed proxy from its base version',
      )
    }
    const colorPipelineBindings = source.unchangedReuse
      ? Object.freeze([])
      : await resolveRenderColorPipelineBindings({
          repository: dependencies.colorPipelines, workspaceId, projectId, sources: source.renderSources,
        })
    const inputHash = projectProxyRenderInputHash({ source, colorPipelineBindings })
    const requestFingerprint = calculateVersionHash({ type: 'project-proxy-render', projectId, inputHash, actorContextHash: audit.contextHash })
    const replay = await dependencies.operations.findReplay({ workspaceId, clientId, actorContextHash: audit.contextHash, idempotencyKey, requestFingerprint })
    if (replay) return replay
    // A render of exactly this Version and input already completed - one made for it, or one CARRIED to it from an earlier Version because its
    // output was untouched - is the answer: asking for it again does not start a second render of the same pixels.
    const admittedId = await dependencies.projects.findAdmittedOperationId?.({ workspaceId, projectId, projectVersionId: source.projectVersionId, inputHash })
    if (admittedId) {
      const admitted = await dependencies.operations.findById(workspaceId, admittedId)
      if (admitted?.operation.status === 'succeeded') return { ...admitted, replayed: true }
    }
    const operationId = dependencies.createId('operation')
    const outputArtifactId = source.unchangedReuse?.artifactId ?? dependencies.createId('artifact')
    const outputManifestId = source.unchangedReuse?.manifestId ?? dependencies.createId('manifest')
    const now = dependencies.clock().toISOString()
    let operation = createQueuedPublicOperation({
      id: operationId, workspaceId, projectId, clientId, type: 'project-proxy-render',
      target: { type: 'media-artifact', id: outputArtifactId, manifestId: outputManifestId }, createdAt: now,
    })
    if (source.unchangedReuse) {
      operation = startPublicOperationAttempt(operation, now)
      operation = advancePublicOperationPhase(operation, 'persisting', now)
      operation = succeedPublicOperation(operation, now)
    }
    return dependencies.operations.createOrReplay({
      operation,
      authenticationAudit: audit,
      context: source.unchangedReuse ? {
        kind: 'project-proxy-reuse', projectId, projectVersionId: source.projectVersionId,
        editPlanSnapshotId: source.editPlanSnapshotId,
        commandId: source.unchangedReuse.commandId,
        impactHash: source.unchangedReuse.impactHash,
        baseVersionId: source.unchangedReuse.baseVersionId,
        reusedFromOperationId: source.unchangedReuse.operationId,
        sourceArtifactId: source.sourceArtifactId, sourceManifestId: source.sourceManifestId,
        inputHash, outputArtifactId, outputManifestId, outputVariantId: sourceOutputVariantId(source),
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 200)}-editorial.mp4`,
      } : {
        kind: 'project-proxy-render', projectId, projectVersionId: source.projectVersionId,
        editPlanSnapshotId: source.editPlanSnapshotId, sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId, inputHash, outputArtifactId, outputManifestId,
        outputVariantId: sourceOutputVariantId(source),
        // The Version-independent content address of this render's identity: what lets a later Version carry this render untouched.
        renderContentHash: projectProxyRenderContentHash({ source, colorPipelineBindings }),
        colorPipelineBindings,
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 200)}-editorial.mp4`,
      },
      idempotencyKey,
      requestFingerprint,
      traceId: request.traceId,
    })
  }
}

/**
 * Why the proxy of a Command's result is not enqueued by the Command itself: the Version has several outputs, a proxy is rendered for
 * ONE output, and no Command chooses which (`output-variant-required`). Not an error - the Command committed and its answer says
 * which proxies remain to be requested, one `apollo.projects.proxy-renders.enqueue` per listed output.
 */
export const PROXY_RENDERS_PER_OUTPUT_REASON = 'output-variant-required' as const
export type CommandProxyRender =
  | Readonly<{ status: 'enqueued'; operation: Awaited<ReturnType<ReturnType<typeof enqueueProjectProxyRenderService>>>['operation']; replayed: boolean }>
  | Readonly<{
      status: 'per-output-request-required'
      reason: typeof PROXY_RENDERS_PER_OUTPUT_REASON
      outputs: readonly Readonly<{ variantId: string; aspectRatio: string | null }>[]
    }>

/**
 * The proxy render a Command that has ALREADY COMMITTED asks for. A project-wide Command (Director, spoken-content removal, LUT, ColorPlan,
 * review patch...) changes every output at once, so a Version with exactly one output (or none yet) gets that output's proxy, as always.
 * A Version with several outputs gets no render and no refusal: the committed Command must not answer `428 output-variant-required`
 * after its Version exists. The outputs are read from the State the Command sealed, before anything is written here, so a deferral
 * writes nothing and asking again answers the same. A caller that names the output (`variantId`, e.g. the view of a manual edit)
 * is enqueued for that output.
 */
export function enqueueProjectProxyRenderAfterCommandService(dependencies: Parameters<typeof enqueueProjectProxyRenderService>[0]) {
  const enqueue = enqueueProjectProxyRenderService(dependencies)
  return async function enqueueAfterCommand(request: Parameters<typeof enqueue>[0] & { expectedProjectVersionId: string }): Promise<CommandProxyRender> {
    if (request.variantId === undefined && dependencies.projects.listVersionOutputs !== undefined) {
      const outputs = await dependencies.projects.listVersionOutputs({
        workspaceId: validateId(request.workspaceId, 'workspaceId'), projectId: validateId(request.projectId, 'projectId'),
        projectVersionId: validateId(request.expectedProjectVersionId, 'expectedProjectVersionId'),
      })
      if (outputs.length > 1) {
        return Object.freeze({ status: 'per-output-request-required', reason: PROXY_RENDERS_PER_OUTPUT_REASON,
          outputs: Object.freeze(outputs.map((output) => Object.freeze({ variantId: output.variantId, aspectRatio: output.aspectRatio }))) })
      }
    }
    const queued = await enqueue(request)
    return Object.freeze({ status: 'enqueued', operation: queued.operation, replayed: queued.replayed })
  }
}
