import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readProjectPolicyOverridesService,
  setProjectPolicyOverridesService,
} from '@/v2/application/project-policy-overrides'
import { createProjectPolicyOverridesRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseSetProjectPolicyOverridesBody,
  presentCurrentProjectPolicyOverrides,
  presentProjectPolicyOverridesResult,
} from '@/v2/public-api/project-policy-overrides-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const value = await readProjectPolicyOverridesService({ repository: createProjectPolicyOverridesRepository() })({
      workspaceId: actor.workspaceId,
      projectId,
    })
    return NextResponse.json(
      presentSuccess(presentCurrentProjectPolicyOverrides(value)),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    const body = parseSetProjectPolicyOverridesBody(await request.json())
    const result = await setProjectPolicyOverridesService({
      repository: createProjectPolicyOverridesRepository(),
      createId: (kind) => `project-policy-${kind}-${randomUUID()}`,
      createEventId: () => randomUUID(),
    })({
      ...body,
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess(presentProjectPolicyOverridesResult(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
