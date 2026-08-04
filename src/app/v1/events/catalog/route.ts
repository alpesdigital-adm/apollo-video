import { NextRequest, NextResponse } from 'next/server'

import { readPublicEventCatalogService } from '@/v2/application/read-public-event-catalog'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const readCatalog = readPublicEventCatalogService()
    return NextResponse.json(
      presentSuccess(readCatalog()),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
