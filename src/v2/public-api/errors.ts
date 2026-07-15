import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { DomainError, type DomainErrorCode } from '../domain/errors.ts'
import { PUBLIC_API_VERSION } from './presenters.ts'

const STATUS_BY_CODE: Partial<Record<DomainErrorCode, number>> = {
  AUTH_INVALID: 401,
  AUTH_SCOPE_REQUIRED: 403,
  WORKSPACE_NOT_FOUND: 404,
  API_CLIENT_NOT_FOUND: 404,
  API_CREDENTIAL_NOT_FOUND: 404,
  MEDIA_ARTIFACT_NOT_FOUND: 404,
  MEDIA_ARTIFACT_MANIFEST_NOT_FOUND: 404,
  MATERIALIZATION_AUTHORIZATION_NOT_FOUND: 404,
  PUBLIC_OPERATION_NOT_FOUND: 404,
  WEBHOOK_DELIVERY_NOT_FOUND: 404,
  PUBLIC_OPERATION_RETRY_REJECTED: 409,
  PUBLIC_SCHEMA_NOT_FOUND: 404,
  INVALID_ARGUMENT: 422,
  INVALID_PROJECT: 422,
  INVALID_WORKSPACE: 422,
  INVALID_API_CLIENT: 422,
  IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
  PERSISTENCE_CONFLICT: 409,
  MATERIALIZATION_AUTHORIZATION_REJECTED: 409,
  MATERIALIZATION_AUTHORIZATION_EXPIRED: 409,
  MATERIALIZATION_REVALIDATION_FAILED: 409,
  PERSISTENCE_NOT_CONFIGURED: 503,
  VERSION_CONFLICT: 409,
}

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
    const status = STATUS_BY_CODE[error.code] ?? 422
    const details =
      error.code === 'AUTH_SCOPE_REQUIRED'
        ? { requiredScope: error.details.requiredScope }
        : undefined
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          category:
            status === 401 || status === 403
              ? 'auth'
              : status === 409
                ? 'conflict'
                : 'validation',
          retryable: false,
          requestId,
          details,
        },
      },
      { status, headers: publicApiHeaders(requestId) },
    )
  }

  console.error('Apollo public API error', { requestId, error })
  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed',
        category: 'internal',
        retryable: true,
        requestId,
      },
    },
    { status: 500, headers: publicApiHeaders(requestId) },
  )
}
