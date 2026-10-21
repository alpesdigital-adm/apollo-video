import { randomUUID } from 'node:crypto'

import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { FaceSourceWindowEvidenceReader } from './ports/face-source-window-evidence-reader.ts'
import type { ProjectProxyRenderRepository } from './ports/project-proxy-render-repository.ts'
import type { ProxyCarryOverRepository, ProxyCarryOverResult } from './ports/proxy-carry-over-repository.ts'
import { projectProxyRenderContentHash, projectProxyRenderInputHash } from './project-render-sources.ts'
import { deriveProxyRenderGeometry, proxyDirectorCriticIssuesDigest } from './proxy-render-evidence.ts'
import { resolveRenderColorPipelineBindings } from './resolve-render-color-pipelines.ts'
import { assertDomain } from '../domain/errors.ts'

/**
 * W70 prep ("invalidar so o necessario"). A Command aimed at ONE output creates a new ProjectVersion, and the other output of the project
 * would lose its render and its approval although nothing it is drawn from changed. This carries that render, its review and its approval
 * to the head Version - only when the content address of the output's pre-render identity at the head (`projectProxyRenderContentHash`: the
 * EditPlan content without its Version identity, the sources, the colour bindings, the output spec revision, the reframe record, the subtitle
 * exceptions, the subtitle preset, the recipe and renderer versions) is exactly the one the earlier render was written with.
 *
 * Nothing is assumed from the Command's scope: an output whose inputs moved in any way has another address and is not carried, and a render
 * written before the address existed has none and is never a source. A carry is recorded on the operation it writes (`reusedFrom*`) and, for
 * an approved review, by a `carry-over-approval` decision that names the review it carries and the actor who triggered it.
 *
 * W70 readiness (R2). The address cannot see what a render READS when it runs: the face windows of its caption placement and the Director's
 * issues of its review. They are read here for the head exactly as the render worker reads them (`deriveProxyRenderGeometry`, with the same
 * face evidence reader the worker is wired with) and handed to the repository as digests; a source render that read other ones is not carried.
 */
export function carryOverUntouchedOutputService(dependencies: {
  projects: ProjectProxyRenderRepository
  carryOvers: ProxyCarryOverRepository
  colorPipelines: ColorPipelineCompilationRepository
  clock: () => Date
  createId?: () => string
  /** The sealed face windows reader the proxy render worker is wired with (absent: as absent as it is for the worker). */
  faceEvidence?: FaceSourceWindowEvidenceReader
}) {
  const createId = dependencies.createId ?? randomUUID
  return async function carryOver(request: Readonly<{
    workspaceId: string
    projectId: string
    variantId: string
    actor: AuthenticatedExternalActor
    commandId?: string
    traceId?: string
  }>): Promise<Readonly<ProxyCarryOverResult>> {
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === request.workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match the carry-over')
    const source = await dependencies.projects.readCurrentSource({ workspaceId: request.workspaceId, projectId: request.projectId, purpose: 'render', variantId: request.variantId })
    if (!source) return { status: 'not-eligible', reason: 'no-source-render' }
    // A reuse or a partial-range render of the head is a different render input: the carry is for an output that would be rendered whole.
    if (source.unchangedReuse || source.rangeReuse || source.unchangedReuseRequired) return { status: 'not-eligible', reason: 'no-source-render' }
    const colorPipelineBindings = await resolveRenderColorPipelineBindings({
      repository: dependencies.colorPipelines, workspaceId: request.workspaceId, projectId: request.projectId, sources: source.renderSources,
    })
    // What the content address cannot see, as a render of the head would read it now.
    const { faceEvidenceDigest } = await deriveProxyRenderGeometry({
      source, workspaceId: request.workspaceId, projectId: request.projectId, clock: dependencies.clock,
      ...(dependencies.faceEvidence ? { faceEvidence: dependencies.faceEvidence } : {}),
    })
    const stamp = createId()
    return dependencies.carryOvers.carry({
      workspaceId: request.workspaceId, projectId: request.projectId, toProjectVersionId: source.projectVersionId, variantId: request.variantId,
      renderContentHash: projectProxyRenderContentHash({ source, colorPipelineBindings }),
      faceEvidenceDigest, criticIssuesDigest: proxyDirectorCriticIssuesDigest(source.criticIssues),
      inputHash: projectProxyRenderInputHash({ source, colorPipelineBindings }),
      editPlanSnapshotId: source.editPlanSnapshotId, sourceArtifactId: source.sourceArtifactId, sourceManifestId: source.sourceManifestId,
      originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 200)}-editorial.mp4`,
      rangeCache: { sourceSha256: source.sourceSha256, editPlanHash: source.editPlanHash, format: source.format },
      actor: request.actor,
      ...(request.commandId ? { commandId: request.commandId } : {}),
      ...(request.traceId ? { traceId: request.traceId } : {}),
      now: dependencies.clock().toISOString(),
      ids: { operation: `operation-${stamp}`, review: `proxy-review-carry-${stamp}`, decision: `proxy-decision-carry-${stamp}`, map: stamp },
    })
  }
}

/**
 * After a Command aimed at some outputs committed: carry every OTHER output of the head Version. Best effort by design - the Command has
 * committed and answers regardless; an output that could not be carried simply keeps the render it had and is rendered on request. A failure
 * is returned, never thrown, so the caller can log it.
 */
export async function carryOverUntouchedOutputs(input: Readonly<{
  carry: (request: Readonly<{ variantId: string }>) => Promise<Readonly<ProxyCarryOverResult>>
  outputVariantIds: readonly string[]
  affectedVariantIds: readonly string[]
}>): Promise<readonly Readonly<{ variantId: string; result: Readonly<ProxyCarryOverResult> | null; error: string | null }>[]> {
  const affected = new Set(input.affectedVariantIds)
  const outcomes: { variantId: string; result: Readonly<ProxyCarryOverResult> | null; error: string | null }[] = []
  for (const variantId of input.outputVariantIds) {
    if (affected.has(variantId)) continue
    try {
      outcomes.push({ variantId, result: await input.carry({ variantId }), error: null })
    } catch (error) {
      outcomes.push({ variantId, result: null, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return Object.freeze(outcomes)
}
