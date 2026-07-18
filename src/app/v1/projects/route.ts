import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createProjectService } from '@/v2/application/create-project'
import { listProjectsService } from '@/v2/application/list-projects'
import { DomainError } from '@/v2/domain/errors'
import type { OutputAspectRatio } from '@/v2/domain/output-spec'
import type { StrategicObjectiveId } from '@/v2/domain/strategic-objective'
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
  objective?: string
  format?: string
  locale?: string
  ownerId?: string
  currentVersionId?: string
  createdAt: string
}) {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    status: project.status,
    objective: project.objective,
    format: project.format,
    locale: project.locale,
    ownerId: project.ownerId,
    currentVersionId: project.currentVersionId,
    createdAt: project.createdAt,
  }
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (!['limit', 'after', 'text', 'status', 'objective', 'format', 'locale', 'createdFrom', 'createdTo', 'ownerId'].includes(name) || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported project list parameter`)
      }
    }
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
        projects: result.projects.map(presentProject),
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
      format?: unknown
      locale?: unknown
      briefing?: unknown
      destination?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body.name !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'name must be a string')
    }
    if (typeof body.objective !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'objective must be a string')
    }
    if (typeof body.format !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'format must be a string')
    }
    for (const field of ['locale', 'briefing', 'destination'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        throw new DomainError('INVALID_ARGUMENT', `${field} must be a string`)
      }
    }
    const locale = typeof body.locale === 'string' ? body.locale : undefined
    const briefing = typeof body.briefing === 'string' ? body.briefing : undefined
    const destination = typeof body.destination === 'string' ? body.destination : undefined

    const createProject = createProjectService({
      repository: createProjectCreationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })
    const result = await createProject({
      workspaceId: actor.workspaceId,
      name: body.name,
      objective: body.objective as StrategicObjectiveId,
      format: body.format as OutputAspectRatio,
      ...(locale ? { locale } : {}),
      ...(briefing ? { briefing } : {}),
      ...(destination ? { destination } : {}),
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
