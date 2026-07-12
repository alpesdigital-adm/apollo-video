import { NextResponse } from 'next/server'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    presentSuccess({
      service: 'apollo-video',
      status: 'ok',
    }),
    {
      headers: {
        'Apollo-API-Version': 'v1',
        'Cache-Control': 'no-store',
      },
    },
  )
}
