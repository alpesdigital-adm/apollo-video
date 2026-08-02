import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { transitionMediaArtifactLifecycleService } from '@/v2/application/transition-media-artifact-lifecycle'
import { createMediaArtifactLifecycleRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseMediaArtifactLifecycleTransitionBody,
  presentMediaArtifactLifecycleTransition,
} from '@/v2/public-api/media-artifact-lifecycle-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:write')
    const { artifactId } = await context.params
    const body = parseMediaArtifactLifecycleTransitionBody(await request.json())
    const result = await transitionMediaArtifactLifecycleService({
      repository: createMediaArtifactLifecycleRepository(),
      clock: () => new Date(),
      createId: randomUUID,
    })({
      ...body,
      workspaceId: actor.workspaceId,
      artifactId,
      actorClientId: actor.clientId,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        transition: presentMediaArtifactLifecycleTransition(result.transition),
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
