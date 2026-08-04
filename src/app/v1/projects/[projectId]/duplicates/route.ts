import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { duplicateProjectService } from '@/v2/application/duplicate-project'
import { DomainError } from '@/v2/domain/errors'
import {
  createProjectDuplicationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentProjectV2,
  presentProjectVersionV2,
  presentSuccess,
} from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function strictBody(value: unknown): {
  expectedVersionId: string
  expectedVersionHash: string
  name?: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  }
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).some((key) =>
      !['expectedVersionId', 'expectedVersionHash', 'name'].includes(key))
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Request body contains an unsupported field',
    )
  }
  if (
    typeof body.expectedVersionId !== 'string' ||
    typeof body.expectedVersionHash !== 'string' ||
    (body.name !== undefined && typeof body.name !== 'string')
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Project duplication request is invalid',
    )
  }
  return {
    expectedVersionId: body.expectedVersionId,
    expectedVersionHash: body.expectedVersionHash,
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey =
      request.headers.get('idempotency-key')?.trim() ?? ''
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = strictBody(rawBody)
    const { projectId } = await context.params
    const result = await duplicateProjectService({
      repository: createProjectDuplicationRepository(),
      clock: () => new Date(),
      createId: (kind) =>
        kind === 'project-media-asset'
          ? randomUUID()
          : `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      expectedVersionId: body.expectedVersionId,
      expectedVersionHash: body.expectedVersionHash,
      ...(body.name ? { name: body.name } : {}),
      actor,
      idempotency: {
        clientId: actor.clientId,
        key: idempotencyKey,
      },
    })
    return NextResponse.json(
      presentSuccess({
        project: {
          ...presentProjectV2(result.project),
          duplicatedFromProjectId:
            result.project.duplicatedFromProjectId,
        },
        version: presentProjectVersionV2({
          id: result.version.id,
          sequence: result.version.sequence,
          baseHash: result.version.baseHash,
          forkedFromProjectId: result.version.forkedFromProjectId,
          forkedFromVersionId: result.version.forkedFromVersionId,
          snapshotRefs: result.version.snapshotRefs,
          createdAt: result.version.createdAt,
        }, { current: true, previewAvailable: false }),
        sharedArtifactIds: result.sharedArtifactIds,
        copiedBytes: result.copiedBytes,
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
