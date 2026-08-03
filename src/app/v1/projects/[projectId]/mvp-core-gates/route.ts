import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  listMvpCoreGatesService,
  runMvpCoreGateService,
} from '@/v2/application/run-mvp-core-gate'
import { DomainError } from '@/v2/domain/errors'
import {
  createMvpCoreGateRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const BODY_FIELDS = new Set([
  'primaryVersionId',
  'primaryVersionHash',
  'companionProjectId',
  'companionVersionId',
  'companionVersionHash',
  'duplicateProjectId',
])

function strictBody(value: unknown): {
  primaryVersionId: string
  primaryVersionHash: string
  companionProjectId: string
  companionVersionId: string
  companionVersionHash: string
  duplicateProjectId: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  }
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((field) => !BODY_FIELDS.has(field))) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Request body contains an unsupported field',
    )
  }
  for (const field of BODY_FIELDS) {
    if (typeof body[field] !== 'string') {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `${field} must be a string`,
      )
    }
  }
  return body as ReturnType<typeof strictBody>
}

function presentGate(gate: Awaited<
  ReturnType<ReturnType<typeof runMvpCoreGateService>>
>['gate']) {
  return {
    schemaVersion: gate.schemaVersion,
    id: gate.id,
    workspaceId: gate.workspaceId,
    primaryProjectId: gate.primaryProjectId,
    companionProjectId: gate.companionProjectId,
    primaryVersionId: gate.primaryVersionId,
    companionVersionId: gate.companionVersionId,
    primaryVersionHash: gate.primaryVersionHash,
    companionVersionHash: gate.companionVersionHash,
    report: gate.report,
    reportFingerprint: gate.reportFingerprint,
    createdBy: gate.createdBy,
    createdAt: gate.createdAt,
    recordHash: gate.recordHash,
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
    const result = await runMvpCoreGateService({
      repository: createMvpCoreGateRepository(),
      clock: () => new Date(),
      createId: () => `mvp-core-gate-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      primaryProjectId: projectId,
      primaryVersionId: body.primaryVersionId,
      primaryVersionHash: body.primaryVersionHash,
      companionProjectId: body.companionProjectId,
      companionVersionId: body.companionVersionId,
      companionVersionHash: body.companionVersionHash,
      duplicateProjectId: body.duplicateProjectId,
      actor: actor.auditContext.actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        gate: presentGate(result.gate),
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'limit' || params.getAll(name).length > 1) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `${name} is not a supported MVP gate list parameter`,
        )
      }
    }
    const { projectId } = await context.params
    const gates = await listMvpCoreGatesService({
      repository: createMvpCoreGateRepository(),
    })({
      workspaceId: actor.workspaceId,
      primaryProjectId: projectId,
      ...(params.has('limit')
        ? { limit: Number(params.get('limit')) }
        : {}),
    })
    return NextResponse.json(
      presentSuccess({ gates: gates.map(presentGate) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
