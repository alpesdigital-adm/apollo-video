import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { createReviewCleanupMaskService, listReviewCleanupMasksService } from '@/v2/application/review-cleanup-masks'
import { DomainError } from '@/v2/domain/errors'
import { createMediaArtifactQueryRepository, createReviewAnnotationRepository, createReviewCleanupMaskRepository, createTransformationProviderRegistryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseCreateReviewCleanupMaskBody, presentReviewCleanupMask } from '@/v2/public-api/review-cleanup-mask-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    const projectVersionId = request.nextUrl.searchParams.get('projectVersionId')?.trim() || undefined
    const masks = await listReviewCleanupMasksService({ masks: createReviewCleanupMaskRepository() })({ workspaceId: actor.workspaceId, projectId, projectVersionId, actor })
    return NextResponse.json(presentSuccess({ masks: masks.map(presentReviewCleanupMask) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const result = await createReviewCleanupMaskService({
      masks: createReviewCleanupMaskRepository(), annotations: createReviewAnnotationRepository(),
      registry: createTransformationProviderRegistryRepository(), artifacts: createMediaArtifactQueryRepository(),
      clock: () => new Date(), createMaskId: () => `review-cleanup-mask-${randomUUID()}`,
    })({ workspaceId: actor.workspaceId, projectId, ...parseCreateReviewCleanupMaskBody(raw), actor, idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '' })
    return NextResponse.json(presentSuccess({ mask: presentReviewCleanupMask(result.persisted), replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
