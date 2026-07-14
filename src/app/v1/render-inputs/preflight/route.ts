import { Buffer } from 'node:buffer'

import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { preflightRenderInputService } from '@/v2/application/preflight-render-input'
import type { CreateRenderInputSpecInput } from '@/v2/domain/render-input'
import { DomainError } from '@/v2/domain/errors'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024

async function readLimitedBody(request: NextRequest): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let byteSize = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    byteSize += value.byteLength
    if (byteSize > MAX_REQUEST_BYTES) {
      await reader.cancel()
      throw new DomainError('INVALID_RENDER_INPUT', 'Render input request is too large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')

    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Render input request is too large')
    }
    const rawBody = await readLimitedBody(request)
    let body: CreateRenderInputSpecInput
    try {
      body = JSON.parse(rawBody) as CreateRenderInputSpecInput
    } catch {
      throw new DomainError('INVALID_RENDER_INPUT', 'Request body must be valid JSON')
    }

    const result = await preflightRenderInputService()(body)
    return NextResponse.json(presentSuccess(result), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
