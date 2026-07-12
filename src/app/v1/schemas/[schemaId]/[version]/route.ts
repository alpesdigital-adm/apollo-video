import { NextRequest, NextResponse } from 'next/server'

import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { getPublicSchemaByRoute } from '@/v2/public-api/schema-registry'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: { schemaId: string; version: string }
}

export function GET(request: NextRequest, { params }: RouteContext) {
  const requestId = resolveRequestId(request)
  try {
    const definition = getPublicSchemaByRoute(params.schemaId, params.version)
    return NextResponse.json(definition.schema, {
      headers: {
        ...publicApiHeaders(requestId),
        'Content-Type': 'application/schema+json; charset=utf-8',
      },
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
