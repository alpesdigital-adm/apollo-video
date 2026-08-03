import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { DomainError } from '../domain/errors.ts'
import { presentPublicDomainError } from './error-presenter.ts'
import { PUBLIC_API_VERSION } from './presenters.ts'
import { PUBLIC_ERROR_CATALOG } from './public-error-catalog.ts'

export function resolveRequestId(request: NextRequest): string {
  const candidate = request.headers.get('apollo-request-id')?.trim()
  return candidate && /^[A-Za-z0-9_-]{8,100}$/.test(candidate) ? candidate : randomUUID()
}

export function publicApiHeaders(requestId: string): Record<string, string> {
  return {
    'Apollo-API-Version': PUBLIC_API_VERSION,
    'Apollo-Request-Id': requestId,
    'Cache-Control': 'no-store',
  }
}

export function respondPublicError(error: unknown, requestId: string) {
  if (error instanceof DomainError) {
    const status = PUBLIC_ERROR_CATALOG[error.code].status
    return NextResponse.json(
      presentPublicDomainError(error, requestId),
      { status, headers: publicApiHeaders(requestId) },
    )
  }

  console.error('Apollo public API error', { requestId, error })
  const descriptor = PUBLIC_ERROR_CATALOG.INTERNAL_ERROR
  return NextResponse.json(
    {
      error: {
        code: descriptor.code,
        message: descriptor.message,
        category: descriptor.category,
        retryable: descriptor.retryable,
        requestId,
      },
    },
    { status: descriptor.status, headers: publicApiHeaders(requestId) },
  )
}
