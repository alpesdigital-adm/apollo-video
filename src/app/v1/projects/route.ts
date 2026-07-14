import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createProjectService } from '@/v2/application/create-project'
import { DomainError } from '@/v2/domain/errors'
import {
  createProjectCreationRepository,
  createProjectQueryRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function presentProject(project: {
  id: string
  workspaceId: string
  name: string
  status: string
  currentVersionId?: string
  createdAt: string
}) {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    status: project.status,
    currentVersionId: project.currentVersionId,
    createdAt: project.createdAt,
  }
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const rawLimit = request.nextUrl.searchParams.get('limit') ?? '20'
    const limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100')
    }

    const projects = await createProjectQueryRepository().listByWorkspace(
      actor.workspaceId,
      limit,
    )
    return NextResponse.json(
      presentSuccess({ projects: projects.map(presentProject) }),
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
    let body: { name?: unknown }
    try {
      body = (await request.json()) as { name?: unknown }
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body.name !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'name must be a string')
    }

    const createProject = createProjectService({
      repository: createProjectCreationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })
    const result = await createProject({
      workspaceId: actor.workspaceId,
      name: body.name,
      actor: { type: 'api-client', id: actor.clientId },
      idempotency: { clientId: actor.clientId, key: idempotencyKey },
    })

    return NextResponse.json(
      presentSuccess({
        project: presentProject(result.project),
        version: {
          id: result.version.id,
          sequence: result.version.sequence,
          baseHash: result.version.baseHash,
          snapshotRefs: result.version.snapshotRefs,
          createdAt: result.version.createdAt,
        },
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
