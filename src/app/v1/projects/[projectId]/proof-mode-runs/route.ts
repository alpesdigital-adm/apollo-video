import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createProofModeRunService,
  listProofModeRunsService,
} from '@/v2/application/proof-mode'
import { DomainError } from '@/v2/domain/errors'
import {
  createEvidenceSegmentRepository,
  createProofIntegrityRepository,
  createProofModeRepository,
  createProofNeedRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseCreateProofModeBody,
  presentProofModeRun,
  presentProofModeRunPage,
} from '@/v2/public-api/proof-mode-contract'

export const dynamic = 'force-dynamic'

function optionalBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new DomainError(
    'INVALID_ARGUMENT',
    'manualOverride must be true or false',
  )
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const limitValue = request.nextUrl.searchParams.get('limit')
    const page = await listProofModeRunsService({
      repository: createProofModeRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      proofIntegrityRunId:
        request.nextUrl.searchParams.get('proofIntegrityRunId') ??
        undefined,
      format:
        request.nextUrl.searchParams.get('format') as
          | '9:16'
          | '16:9'
          | '4:5'
          | '1:1'
          | '21:9'
          | null ??
        undefined,
      mode:
        request.nextUrl.searchParams.get('mode') as
          | 'cutaway'
          | 'split-screen'
          | 'proof-card'
          | null ??
        undefined,
      manualOverride: optionalBoolean(
        request.nextUrl.searchParams.get('manualOverride'),
      ),
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor:
        request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentProofModeRunPage(page)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
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
    const { projectId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCreateProofModeBody(rawBody)
    const result = await createProofModeRunService({
      repository: createProofModeRepository(),
      proofIntegrity: createProofIntegrityRepository(),
      proofNeeds: createProofNeedRepository(),
      evidenceSegments: createEvidenceSegmentRepository(),
      clock: () => new Date(),
      createRunId: () => `proof-mode-run-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        run: presentProofModeRun(result.run),
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
