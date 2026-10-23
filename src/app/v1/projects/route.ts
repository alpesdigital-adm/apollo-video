import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createProjectService } from '@/v2/application/create-project'
import { listProjectsService } from '@/v2/application/list-projects'
import { DomainError } from '@/v2/domain/errors'
import {
  parseDesiredActionInput,
  type DesiredActionInput,
} from '@/v2/domain/desired-action'
import type { StrategicObjectiveId } from '@/v2/domain/strategic-objective'
import {
  createProjectCreationRepository,
  createProjectQueryRepository,
} from '@/v2/infrastructure/repository-factory'
import { createInterpretBrief } from '@/v2/infrastructure/brief/create-interpret-brief'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentProjectDashboard,
  presentProjectV2,
  presentSuccess,
} from '@/v2/public-api/presenters'
import { presentOutputBoundVersion } from '@/v2/public-api/project-output-variant-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    assertAllowlistedPublicQuery(params, new Set([
      'limit', 'after', 'text', 'status', 'objective', 'format', 'locale',
      'createdFrom', 'createdTo', 'ownerId',
    ]))
    const result = await listProjectsService({ projects: createProjectQueryRepository() })({
      workspaceId: actor.workspaceId,
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      ...(params.has('after') ? { after: params.get('after') ?? '' } : {}),
      ...(params.has('text') ? { text: params.get('text') ?? '' } : {}),
      ...(params.has('status') ? { status: params.get('status') ?? '' } : {}),
      ...(params.has('objective') ? { objective: params.get('objective') ?? '' } : {}),
      ...(params.has('format') ? { format: params.get('format') ?? '' } : {}),
      ...(params.has('locale') ? { locale: params.get('locale') ?? '' } : {}),
      ...(params.has('createdFrom') ? { createdFrom: params.get('createdFrom') ?? '' } : {}),
      ...(params.has('createdTo') ? { createdTo: params.get('createdTo') ?? '' } : {}),
      ...(params.has('ownerId') ? { ownerId: params.get('ownerId') ?? '' } : {}),
    })
    return NextResponse.json(
      presentSuccess({
        projects: result.projects.map(presentProjectDashboard),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: {
      name?: unknown
      objective?: unknown
      locale?: unknown
      briefing?: unknown
      desiredAction?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    }
    if (!Object.keys(body).every((key) => [
      'name', 'objective', 'locale', 'briefing', 'desiredAction',
    ].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (typeof body.name !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'name must be a string')
    }
    if (typeof body.objective !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'objective must be a string')
    }
    for (const field of ['locale', 'briefing'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        throw new DomainError('INVALID_ARGUMENT', `${field} must be a string`)
      }
    }
    const locale = typeof body.locale === 'string' ? body.locale : undefined
    const briefing = typeof body.briefing === 'string' ? body.briefing : undefined
    let desiredAction: DesiredActionInput | undefined
    if (body.desiredAction !== undefined) {
      desiredAction = parseDesiredActionInput(body.desiredAction)
    }

    const createProject = createProjectService({
      repository: createProjectCreationRepository(),
      // The briefing is read when the project is created (the reading is a property of the text); no interpreter, or a refused reading, keeps it unread.
      interpretBrief: createInterpretBrief(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })
    const result = await createProject({
      workspaceId: actor.workspaceId,
      name: body.name,
      objective: body.objective as StrategicObjectiveId,
      ...(locale ? { locale } : {}),
      ...(briefing ? { briefing } : {}),
      ...(desiredAction ? { desiredAction } : {}),
      actor,
      idempotencyKey,
    })

    return NextResponse.json(
      presentSuccess({
        projectAtCreation: presentProjectV2(result.projectAtCreation),
        creationVersion: presentOutputBoundVersion(result.creationVersion),
        outputState: { id: result.bundle.state.document.id, hash: result.bundle.state.stateHash,
          entryCount: result.bundle.state.document.entries.length, consumption: result.bundle.state.document.consumption },
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
