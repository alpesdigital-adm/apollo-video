import { NextResponse } from 'next/server'
import { FOUNDATION_CAPABILITIES, capabilitiesForScopes } from '@/v2/public-api/capability-registry'
import { presentCapability, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export function GET() {
  const capabilities = capabilitiesForScopes(FOUNDATION_CAPABILITIES, new Set()).map(
    presentCapability,
  )

  return NextResponse.json(presentSuccess({ capabilities }), {
    headers: {
      'Apollo-API-Version': 'v1',
      'Cache-Control': 'no-store',
    },
  })
}
