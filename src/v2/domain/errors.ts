export const DOMAIN_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'INVALID_OUTPUT_SPEC',
  'INVALID_SCOPE',
  'INVALID_COMMAND',
  'INVALID_PROJECT_VERSION',
  'INVALID_WORKSPACE',
  'INVALID_PROJECT',
  'INVALID_SNAPSHOT',
  'WORKSPACE_NOT_FOUND',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'PERSISTENCE_CONFLICT',
  'PERSISTENCE_NOT_CONFIGURED',
  'INVALID_API_CLIENT',
  'API_CLIENT_NOT_FOUND',
  'API_CREDENTIAL_NOT_FOUND',
  'AUTH_INVALID',
  'AUTH_SCOPE_REQUIRED',
  'VERSION_CONFLICT',
  'DUPLICATE_CAPABILITY',
  'INVALID_CAPABILITY',
  'CAPABILITY_PARITY_MISSING',
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}
export function assertDomain(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, details)
  }
}
