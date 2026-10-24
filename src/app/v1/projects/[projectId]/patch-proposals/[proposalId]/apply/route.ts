import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { applyReviewPatchService } from '@/v2/application/review-patch'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderAfterCommandService } from '@/v2/application/enqueue-project-proxy-render'
import { calculateVersionHash } from '@/v2/application/version-hash'
import { DomainError } from '@/v2/domain/errors'
import { createColorPipelineCompilationRepository, createProjectProxyRenderRepository, createPublicOperationRepository, createReviewPatchRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentReviewPatchProposal } from '@/v2/public-api/collaborative-review-presenters'
import { presentProjectVersionV2, presentSuccess } from '@/v2/public-api/presenters'
import { commandProxyRenderReplayed, presentCommandProxyRender } from '@/v2/public-api/command-proxy-render-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; proposalId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: unknown
    try { body = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'confirmed') || record.confirmed !== true) throw new DomainError('PRECONDITION_REQUIRED', 'Patch impact must be explicitly confirmed')
    const { projectId, proposalId } = await context.params
    const repository = createReviewPatchRepository()
    const result = await applyReviewPatchService({
      repository,
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      proposalId,
      confirmed: true,
      actor,
      idempotencyKey,
    })
    const render = await enqueueProjectProxyRenderAfterCommandService({
      projects: createProjectProxyRenderRepository(),
      operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      expectedProjectVersionId: result.version.id,
      actor,
      idempotencyKey: `patch-proxy:${calculateVersionHash(idempotencyKey).slice(0, 64)}`,
      traceId: requestId,
    })
    // A project with several outputs has no single proxy to attach: the patch is answered as committed and the proxies are requested per output.
    const proposal = render.status === 'enqueued'
      ? await repository.attachRenderOperation({ workspaceId: actor.workspaceId, projectId, proposalId, renderOperationId: render.operation.id })
      : await repository.readProposal({ workspaceId: actor.workspaceId, projectId, proposalId })
    if (!proposal) throw new DomainError('PROJECT_NOT_FOUND', 'Review patch proposal was not found')
    return NextResponse.json(presentSuccess({
      proposal: presentReviewPatchProposal(proposal),
      command: { id: result.command.id, type: result.command.type, baseVersionId: result.command.baseVersionId, resultVersionId: result.version.id, createdAt: result.command.createdAt },
      version: presentProjectVersionV2(
        { id: result.version.id, sequence: result.version.sequence, parentVersionId: result.version.parentVersionId, baseHash: result.version.baseHash, snapshotRefs: result.version.snapshotRefs, createdAt: result.version.createdAt },
        { current: true, previewAvailable: false },
      ),
      comparison: result.comparison,
      impact: result.impact,
      invalidations: result.invalidations,
      ...presentCommandProxyRender(render),
      replayed: result.replayed && commandProxyRenderReplayed(render),
    }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
