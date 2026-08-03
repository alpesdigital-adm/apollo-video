import { assertDomain } from '../domain/errors.ts'

export const PUBLIC_API_VERSION = 'v1' as const
export const PUBLIC_API_BASE_PATH = '/v1' as const

export const PUBLIC_ID_SCHEMA = Object.freeze({
  type: 'string', minLength: 3, maxLength: 128,
} as const)
export const PUBLIC_DATE_TIME_SCHEMA = Object.freeze({
  type: 'string', format: 'date-time',
} as const)
export const PUBLIC_FRAME_SCHEMA = Object.freeze({
  type: 'integer', minimum: 0,
} as const)
export const PUBLIC_CURSOR_SCHEMA = Object.freeze({
  type: 'string', minLength: 8, maxLength: 1024,
} as const)

export const PUBLIC_API_CONVENTIONS = Object.freeze({
  version: PUBLIC_API_VERSION,
  basePath: PUBLIC_API_BASE_PATH,
  json: Object.freeze({
    mediaType: 'application/json',
    charset: 'utf-8',
    unknownFields: 'reject',
    nonFiniteNumbers: 'reject',
  }),
  id: Object.freeze({
    representation: 'opaque-string',
    minLength: PUBLIC_ID_SCHEMA.minLength,
    maxLength: PUBLIC_ID_SCHEMA.maxLength,
  }),
  dateTime: Object.freeze({
    input: 'RFC3339-UTC',
    output: 'YYYY-MM-DDTHH:mm:ss.sssZ',
  }),
  frame: Object.freeze({
    representation: 'non-negative-safe-integer',
    interval: 'half-open',
    secondsForEditorialTiming: false,
  }),
  pagination: Object.freeze({
    representation: 'stable-opaque-cursor',
    requestCursorParameters: Object.freeze(['after', 'cursor'] as const),
    responseCursorProperty: 'nextCursor',
    minimumLimit: 1,
    maximumLimit: 100,
    boundTo: Object.freeze(['workspace', 'filters', 'sort', 'snapshot'] as const),
  }),
  filters: Object.freeze({
    declaration: 'PublicCapability.queryParameters',
    unknown: 'reject',
    duplicates: 'reject',
    freeFormExpressions: false,
  }),
})

export function publicIdentifier(value: unknown, field = 'id'): string {
  assertDomain(
    typeof value === 'string' &&
      value === value.trim() &&
      value.length >= PUBLIC_ID_SCHEMA.minLength &&
      value.length <= PUBLIC_ID_SCHEMA.maxLength &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),
    'INVALID_ARGUMENT',
    `${field} must be an opaque public identifier`,
  )
  return value
}

export function publicDateTime(value: unknown, field = 'dateTime'): string {
  assertDomain(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'INVALID_ARGUMENT',
    `${field} must be an RFC 3339 UTC date-time`,
  )
  return value
}

export function publicFrame(value: unknown, field = 'frame'): number {
  assertDomain(
    Number.isSafeInteger(value) && Number(value) >= 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-negative safe integer frame index`,
  )
  return Number(value)
}

export function assertPublicJsonValue(value: unknown, path = '$', depth = 0): void {
  assertDomain(depth <= 64, 'INVALID_ARGUMENT', `${path} exceeds the public JSON depth limit`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assertDomain(Number.isFinite(value), 'INVALID_ARGUMENT', `${path} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicJsonValue(item, `${path}[${index}]`, depth + 1))
    return
  }
  assertDomain(
    typeof value === 'object' && value !== undefined &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
    'INVALID_ARGUMENT',
    `${path} must contain only JSON values`,
  )
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assertDomain(nested !== undefined, 'INVALID_ARGUMENT', `${path}.${key} cannot be undefined`)
    assertPublicJsonValue(nested, `${path}.${key}`, depth + 1)
  }
}

export function assertAllowlistedPublicQuery(
  parameters: URLSearchParams,
  allowedNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null)
  for (const name of new Set(parameters.keys())) {
    const values = parameters.getAll(name)
    assertDomain(
      allowedNames.has(name),
      'INVALID_ARGUMENT',
      `Query parameter ${name} is not allowlisted`,
    )
    assertDomain(
      values.length === 1,
      'INVALID_ARGUMENT',
      `Query parameter ${name} cannot be repeated`,
    )
    result[name] = values[0]
  }
  return Object.freeze(result)
}
