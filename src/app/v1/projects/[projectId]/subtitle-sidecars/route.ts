import { NextRequest, NextResponse } from 'next/server'

import {
  exportProjectSubtitleSidecarService,
  listProjectSubtitleSidecarsService,
} from '@/v2/application/export-subtitle-sidecar'
import { DomainError } from '@/v2/domain/errors'
import { SUBTITLE_SIDECAR_FORMATS, type SubtitleSidecarFormat } from '@/v2/domain/subtitle-sidecar'
import {
  createSubtitleSidecarExportDependencies,
  createSubtitleSidecarRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { publicArtifactReference } from '@/v2/public-api/public-media-identity'

export const dynamic = 'force-dynamic'

/**
 * The permanent storage key never leaves the runtime: a client reaches the bytes
 * only through a media download grant on the opaque artifact reference.
 */
function presentSidecar(sidecar: { artifactKey: string; artifactId: string }) {
  const { artifactKey: _storageKey, ...rest } = sidecar
  return { ...rest, artifactRef: publicArtifactReference(sidecar.artifactId) }
}

function optionalText(request: NextRequest, name: string): string | undefined {
  return request.nextUrl.searchParams.get(name)?.trim() || undefined
}

function readFormat(value: unknown, required: boolean): SubtitleSidecarFormat | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DomainError('INVALID_ARGUMENT', 'format is required')
    return undefined
  }
  if (typeof value !== 'string' || !SUBTITLE_SIDECAR_FORMATS.includes(value as SubtitleSidecarFormat)) {
    throw new DomainError('INVALID_ARGUMENT', 'format must be srt or vtt')
  }
  return value as SubtitleSidecarFormat
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    const idempotencyKey = request.headers.get('idempotency-key')?.trim()
    if (!idempotencyKey) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key header is required')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new DomainError('INVALID_ARGUMENT', 'A JSON request body is required')
    }
    if (typeof body.variantId !== 'string' || !body.variantId.trim()) {
      throw new DomainError('INVALID_ARGUMENT', 'variantId is required')
    }
    const result = await exportProjectSubtitleSidecarService(
      createSubtitleSidecarExportDependencies(),
    )({
      workspaceId: actor.workspaceId,
      actor,
      projectId,
      variantId: body.variantId.trim(),
      format: readFormat(body.format, true)!,
      ...(typeof body.locale === 'string' && body.locale.trim() ? { locale: body.locale.trim() } : {}),
      ...(typeof body.projectVersionId === 'string' && body.projectVersionId.trim()
        ? { projectVersionId: body.projectVersionId.trim() }
        : {}),
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({ ...result, sidecar: presentSidecar(result.sidecar) }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
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
    const { projectId } = await context.params
    const rawLimit = request.nextUrl.searchParams.get('limit')
    const result = await listProjectSubtitleSidecarsService({
      sidecars: createSubtitleSidecarRepository(),
    })({
      workspaceId: actor.workspaceId,
      actor,
      projectId,
      ...(optionalText(request, 'projectVersionId')
        ? { projectVersionId: optionalText(request, 'projectVersionId')! }
        : {}),
      ...(optionalText(request, 'variantId') ? { variantId: optionalText(request, 'variantId')! } : {}),
      ...(readFormat(optionalText(request, 'format'), false)
        ? { format: readFormat(optionalText(request, 'format'), false)! }
        : {}),
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    })
    return NextResponse.json(
      presentSuccess({ sidecars: result.sidecars.map(presentSidecar) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
