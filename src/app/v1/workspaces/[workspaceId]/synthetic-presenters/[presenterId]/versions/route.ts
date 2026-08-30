import { NextRequest, NextResponse } from 'next/server'

import {
  createSyntheticPresenterProfileVersionService,
} from '@/v2/application/synthetic-presenter-lifecycle'
import { registerSyntheticPresenterProfileService } from '@/v2/application/synthetic-production'
import { DomainError } from '@/v2/domain/errors'
import {
  createMediaArtifactQueryRepository,
  createSyntheticProductionRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseCreatePresenterVersionBody, presentPresenterProfile } from '@/v2/public-api/synthetic-presenter-lifecycle-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string; presenterId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { workspaceId, presenterId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseCreatePresenterVersionBody(raw)
    const repository = createSyntheticProductionRepository()
    const result = await createSyntheticPresenterProfileVersionService({
      repository,
      register: registerSyntheticPresenterProfileService({
        repository, artifacts: createMediaArtifactQueryRepository(), clock: () => new Date(),
      }),
    })({
      workspaceId,
      profileId: presenterId,
      expectedVersion: body.baseRevision,
      changes: body.changes,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({ profile: presentPresenterProfile(result.profile), replayed: result.replayed }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
