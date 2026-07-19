import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import type { PersistedReviewAnnotation } from '@/v2/application/ports/review-annotation-repository'
import {
  createProjectReviewAnnotationService,
  readProjectReviewService,
} from '@/v2/application/review-project'
import { DomainError } from '@/v2/domain/errors'
import type { ReviewAnnotationScope } from '@/v2/domain/review-system'
import { createReviewAnnotationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function annotationView(annotation: PersistedReviewAnnotation) {
  return {
    id: annotation.id,
    projectVersionId: annotation.projectVersionId,
    proxyArtifactId: annotation.proxyArtifactId,
    proxyHash: annotation.proxyHash,
    frame: annotation.frame,
    timeRangeMs: annotation.timeRangeMs,
    screenshotRef: annotation.screenshotRef,
    scope: annotation.scope,
    ...(annotation.region ? { region: annotation.region } : {}),
    targetIds: annotation.targetIds,
    text: annotation.text,
    author: annotation.author,
    status: annotation.status,
    createdAt: annotation.createdAt,
  }
}

function parseRegion(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'region must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['x', 'y', 'width', 'height'].includes(key))) {
    throw new DomainError('INVALID_ARGUMENT', 'region contains an unsupported field')
  }
  if (![record.x, record.y, record.width, record.height].every((item) => typeof item === 'number')) {
    throw new DomainError('INVALID_ARGUMENT', 'region coordinates must be numbers')
  }
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const rawLimit = request.nextUrl.searchParams.get('limit')
    const limit = rawLimit === null ? 50 : Number(rawLimit)
    const { projectId } = await context.params
    const result = await readProjectReviewService({ repository: createReviewAnnotationRepository() })({
      workspaceId: actor.workspaceId,
      projectId,
      limit,
    })
    return NextResponse.json(presentSuccess({
      session: result.session,
      scenes: result.scenes,
      annotations: result.annotations.map(annotationView),
    }), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
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
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    }
    const record = body as Record<string, unknown>
    const allowed = ['projectVersionId', 'proxyArtifactId', 'proxyHash', 'frame', 'timeRangeMs', 'scope', 'region', 'targetIds', 'screenshotRef', 'text']
    if (Object.keys(record).some((key) => !allowed.includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (
      typeof record.projectVersionId !== 'string' || typeof record.proxyArtifactId !== 'string' ||
      typeof record.proxyHash !== 'string' || !Number.isInteger(record.frame) ||
      !Array.isArray(record.timeRangeMs) || record.timeRangeMs.length !== 2 ||
      !record.timeRangeMs.every((item) => Number.isInteger(item)) ||
      !['point', 'region', 'scene'].includes(record.scope as string) ||
      !Array.isArray(record.targetIds) || !record.targetIds.every((item) => typeof item === 'string') ||
      typeof record.screenshotRef !== 'string' || typeof record.text !== 'string'
    ) throw new DomainError('INVALID_ARGUMENT', 'Review annotation body is invalid')
    const region = parseRegion(record.region)
    const { projectId } = await context.params
    const result = await createProjectReviewAnnotationService({
      repository: createReviewAnnotationRepository(),
      clock: () => new Date(),
      createId: randomUUID,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: record.projectVersionId,
      proxyArtifactId: record.proxyArtifactId,
      proxyHash: record.proxyHash,
      frame: record.frame as number,
      timeRangeMs: record.timeRangeMs as [number, number],
      scope: record.scope as ReviewAnnotationScope,
      ...(region ? { region } : {}),
      targetIds: record.targetIds as string[],
      screenshotRef: record.screenshotRef,
      text: record.text,
      author: { id: actor.clientId, name: actor.clientId, type: 'api-client' },
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({ annotation: annotationView(result.annotation), replayed: result.replayed }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
