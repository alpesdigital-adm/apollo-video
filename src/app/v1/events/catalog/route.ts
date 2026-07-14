import { NextRequest, NextResponse } from 'next/server'

import { PUBLIC_EVENT_CATALOG } from '@/v2/domain/public-event'
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
    return NextResponse.json(
      presentSuccess({
        envelopeSchemaRef: 'apollo://schemas/public-event/v1',
        events: PUBLIC_EVENT_CATALOG.map((descriptor) => ({ ...descriptor })),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
