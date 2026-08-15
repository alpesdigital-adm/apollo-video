import { NextRequest, NextResponse } from 'next/server'

import { DomainError } from '@/v2/domain/errors'
import { createSubtitleCssPreview, readSubtitleStyleRegistry } from '@/v2/public-api/subtitle-style-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  return NextResponse.json(presentSuccess(readSubtitleStyleRegistry()), { headers: publicApiHeaders(requestId) })
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    let body: unknown
    try { body = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    return NextResponse.json(presentSuccess(createSubtitleCssPreview(body)), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
