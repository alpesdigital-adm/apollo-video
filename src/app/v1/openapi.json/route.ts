import { NextRequest, NextResponse } from 'next/server'

import { createOpenApiDocument } from '@/v2/public-api/openapi'
import { publicApiHeaders, resolveRequestId } from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'

export function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  return NextResponse.json(createOpenApiDocument(), {
    headers: publicApiHeaders(requestId),
  })
}
