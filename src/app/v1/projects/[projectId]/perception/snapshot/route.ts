import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { PERCEPTION_KINDS, type PerceptionKind } from '@/v2/domain/perception-timeline'
import { createServerPerceptionSnapshotService } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function integer(value: string | null, field: string) {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new DomainError('INVALID_ARGUMENT', `${field} is outside the safe integer range`)
  return parsed
}

function kinds(value: string | null): readonly PerceptionKind[] | undefined {
  if (value === null) return undefined
  const parsed = value.split(',')
  if (
    parsed.length < 1 || new Set(parsed).size !== parsed.length ||
    parsed.some((kind) => !PERCEPTION_KINDS.includes(kind as PerceptionKind))
  ) throw new DomainError('INVALID_ARGUMENT', 'kinds contains an unsupported perception kind')
  return Object.freeze(parsed as PerceptionKind[])
}

/**
 * The server-owned perception snapshot of one ProjectVersion (W63a). It is assembled by the server from its own sealed evidence and
 * contains no caller-supplied timeline; the manual timeline of `PUT /perception` stays at `GET /perception`.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const unsupported = [...request.nextUrl.searchParams.keys()].filter((key) => !['versionId', 'fromMs', 'toMs', 'kinds'].includes(key))
    if (unsupported.length) throw new DomainError('INVALID_ARGUMENT', 'Query contains an unsupported parameter')
    for (const key of request.nextUrl.searchParams.keys()) {
      if (request.nextUrl.searchParams.getAll(key).length !== 1) {
        throw new DomainError('INVALID_ARGUMENT', `Query parameter ${key} must be supplied once`)
      }
    }
    const { projectId } = await context.params
    const requestedKinds = kinds(request.nextUrl.searchParams.get('kinds'))
    const search = request.nextUrl.searchParams
    const result = await createServerPerceptionSnapshotService()({
      workspaceId: actor.workspaceId,
      projectId,
      ...(search.has('versionId') ? { projectVersionId: search.get('versionId') ?? '' } : {}),
      ...(search.has('fromMs') ? { fromMs: integer(search.get('fromMs'), 'fromMs') } : {}),
      ...(search.has('toMs') ? { toMs: integer(search.get('toMs'), 'toMs') } : {}),
      ...(requestedKinds ? { kinds: requestedKinds } : {}),
    })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
