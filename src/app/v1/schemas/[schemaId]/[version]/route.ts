import { NextRequest, NextResponse } from 'next/server'

import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { getPublicSchemaByRoute } from '@/v2/public-api/schema-registry'
import { publicSchemaDocument } from '@/v2/public-api/schema-examples'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ schemaId: string; version: string }>
}

export async function GET(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  const requestId = resolveRequestId(request)
  try {
    const definition = getPublicSchemaByRoute(params.schemaId, params.version)
    return NextResponse.json(publicSchemaDocument(definition), {
      headers: {
        ...publicApiHeaders(requestId),
        'Content-Type': 'application/schema+json; charset=utf-8',
      },
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
