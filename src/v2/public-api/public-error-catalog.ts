import {
  DOMAIN_ERROR_CODES,
  assertDomain,
} from '../domain/errors.ts'

export const PUBLIC_ERROR_CODES = [...DOMAIN_ERROR_CODES, 'INTERNAL_ERROR'] as const
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number]

export type PublicErrorCategory =
  | 'validation'
  | 'auth'
  | 'policy'
  | 'conflict'
  | 'quota'
  | 'provider'
  | 'internal'

export interface PublicErrorDescriptor {
  code: PublicErrorCode
  status: number
  category: PublicErrorCategory
  retryable: boolean
  message: string
}

interface PublicErrorGroup {
  codes: readonly PublicErrorCode[]
  status: number
  category: PublicErrorCategory
  retryable?: boolean
  message?: string
}

function safePublicMessage(code: PublicErrorCode, group: PublicErrorGroup): string {
  if (group.message) return group.message
  const words = code.toLowerCase().replaceAll('_', ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

export function definePublicErrorCatalog(
  groups: readonly PublicErrorGroup[],
): Readonly<Record<PublicErrorCode, Readonly<PublicErrorDescriptor>>> {
  const known = new Set<PublicErrorCode>(PUBLIC_ERROR_CODES)
  const entries = new Map<PublicErrorCode, Readonly<PublicErrorDescriptor>>()
  for (const group of groups) {
    assertDomain(
      Number.isInteger(group.status) && group.status >= 400 && group.status <= 599,
      'INVALID_PUBLIC_SCHEMA',
      'Public error status must be an HTTP error status',
    )
    for (const code of group.codes) {
      assertDomain(
        known.has(code) && !entries.has(code),
        'INVALID_PUBLIC_SCHEMA',
        'Public error code must be known and classified exactly once',
        { code },
      )
      entries.set(code, Object.freeze({
        code,
        status: group.status,
        category: group.category,
        retryable: group.retryable ?? false,
        message: safePublicMessage(code, group),
      }))
    }
  }
  const missing = PUBLIC_ERROR_CODES.filter((code) => !entries.has(code))
  assertDomain(
    missing.length === 0,
    'INVALID_PUBLIC_SCHEMA',
    'Every public error code requires an explicit public classification',
    { missing },
  )
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<PublicErrorCode, Readonly<PublicErrorDescriptor>>
  >
}

export const PUBLIC_ERROR_CATALOG = definePublicErrorCatalog([
  {
    status: 401, category: 'auth', codes: ['AUTH_INVALID'],
  },
  {
    status: 403, category: 'auth', codes: ['AUTH_SCOPE_REQUIRED'],
  },
  {
    status: 403, category: 'policy', codes: ['PREFLIGHT_TOKEN_INVALID'],
  },
  {
    status: 404, category: 'validation', codes: [
      'MEDIA_UPLOAD_NOT_FOUND', 'MEDIA_DOWNLOAD_GRANT_NOT_FOUND',
      'MEDIA_ARTIFACT_NOT_FOUND', 'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
      'MEDIA_TRANSCRIPT_NOT_FOUND', 'MATERIALIZATION_AUTHORIZATION_NOT_FOUND',
      'RENDER_ELEMENT_MAP_NOT_FOUND', 'WEBHOOK_CHALLENGE_NOT_FOUND',
      'WEBHOOK_ENDPOINT_NOT_FOUND', 'WEBHOOK_SIGNING_SECRET_ROTATION_NOT_FOUND',
      'WEBHOOK_SUBSCRIPTION_NOT_FOUND', 'WEBHOOK_DELIVERY_NOT_FOUND',
      'WEBHOOK_EVENT_NOT_FOUND', 'PUBLIC_OPERATION_NOT_FOUND', 'WORKSPACE_NOT_FOUND',
      'PROJECT_NOT_FOUND', 'PRODUCTION_BATCH_NOT_FOUND',
      'PRODUCTION_BATCH_ITEM_NOT_FOUND', 'PRODUCTION_BATCH_PARTIAL_RETRY_NOT_FOUND',
      'SOURCE_DECONSTRUCTION_NOT_FOUND', 'SOURCE_DECONSTRUCTION_SOURCE_NOT_FOUND',
      'CONTAMINATION_REPORT_NOT_FOUND', 'SOURCE_CLEANUP_NOT_FOUND',
      'VALIDATION_ENVELOPE_NOT_FOUND', 'PROOF_NEED_RUN_NOT_FOUND',
      'PROOF_INTEGRITY_RUN_NOT_FOUND', 'PROOF_MODE_RUN_NOT_FOUND',
      'LONG_FORM_INDEX_WORKFLOW_NOT_FOUND', 'SPEAKER_DIARIZATION_NOT_FOUND',
      'SCRIPT_ALIGNMENT_NOT_FOUND', 'TAKE_LIBRARY_NOT_FOUND',
      'COMPATIBILITY_GRAPH_NOT_FOUND', 'VARIANT_RECIPE_NOT_FOUND',
      'VARIANT_PORTFOLIO_PREFLIGHT_NOT_FOUND', 'BATCH_EDIT_PREFLIGHT_NOT_FOUND',
      'BATCH_EDIT_COMMAND_NOT_FOUND', 'API_CLIENT_NOT_FOUND', 'API_CREDENTIAL_NOT_FOUND',
      'PUBLIC_SCHEMA_NOT_FOUND',
    ],
  },
  {
    status: 409, category: 'conflict', codes: [
      'PROJECT_TRANSITION_REJECTED', 'MEDIA_UPLOAD_TRANSITION_REJECTED',
      'MEDIA_DOWNLOAD_GRANT_REJECTED', 'MEDIA_ARTIFACT_TRANSITION_REJECTED',
      'MATERIALIZATION_AUTHORIZATION_REJECTED', 'MATERIALIZATION_AUTHORIZATION_EXPIRED',
      'MATERIALIZATION_REVALIDATION_FAILED', 'WEBHOOK_CHALLENGE_REJECTED',
      'WEBHOOK_ENDPOINT_ALREADY_EXISTS', 'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
      'WEBHOOK_ENDPOINT_REVISION_MISMATCH', 'WEBHOOK_SUBSCRIPTION_ALREADY_EXISTS',
      'WEBHOOK_SUBSCRIPTION_CREATE_REJECTED', 'WEBHOOK_SUBSCRIPTION_TRANSITION_REJECTED',
      'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH', 'WEBHOOK_DELIVERY_REPLAY_REJECTED',
      'WEBHOOK_EVENT_REPLAY_REJECTED', 'WEBHOOK_EVENT_REPLAY_LIMIT_EXCEEDED',
      'PUBLIC_OPERATION_RETRY_REJECTED', 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'PERSISTENCE_CONFLICT', 'VERSION_CONFLICT', 'TOOL_CONFIRMATION_REQUIRED',
      'TOOL_CONFIRMATION_INVALID',
    ],
  },
  {
    status: 409, category: 'policy', codes: ['PREFLIGHT_TOKEN_EXPIRED', 'PREFLIGHT_TOKEN_STALE'],
  },
  {
    status: 412, category: 'conflict', codes: [
      'MEDIA_ARTIFACT_LIFECYCLE_REVISION_MISMATCH',
      'ASSET_RIGHTS_REVISION_MISMATCH',
      'CONTAMINATION_REPORT_REVISION_MISMATCH',
    ],
  },
  {
    status: 416, category: 'validation', codes: ['MEDIA_RANGE_NOT_SATISFIABLE'],
  },
  {
    status: 422, category: 'policy', codes: [
      'ASSET_NOT_USABLE', 'ASSET_RIGHTS_BLOCKED', 'EDITORIAL_ACCEPTANCE_FAILED',
    ],
  },
  {
    status: 422, category: 'provider', codes: [
      'RENDER_EXECUTION_FAILED', 'RENDER_OUTPUT_INVALID', 'RENDER_OUTPUT_CONFLICT',
      'RENDER_OUTPUT_PROMOTION_FAILED', 'RENDER_OUTPUT_CLEANUP_FAILED',
      'WEBHOOK_NETWORK_REJECTED', 'WEBHOOK_DELIVERY_TRANSPORT_FAILED',
      'WEBHOOK_SECRET_UNAVAILABLE', 'WEBHOOK_SIGNATURE_INVALID',
    ],
  },
  {
    status: 422, category: 'validation', codes: [
      'INVALID_ARGUMENT', 'INVALID_OUTPUT_SPEC', 'INVALID_SCOPE', 'INVALID_COMMAND',
      'INVALID_PROJECT_VERSION', 'INVALID_WORKSPACE', 'INVALID_PROJECT',
      'INVALID_SNAPSHOT', 'INVALID_MEDIA_ARTIFACT', 'INVALID_RENDER_INPUT',
      'MEDIA_ARTIFACT_SOURCE_NOT_FOUND', 'INVALID_CURSOR', 'ASSET_NOT_FOUND',
      'INVALID_PUBLIC_OPERATION', 'INVALID_PUBLIC_EVENT', 'INVALID_WEBHOOK',
      'WEBHOOK_SHARD_COORDINATION_REJECTED', 'WEBHOOK_FANOUT_LIMIT_EXCEEDED',
      'WEBHOOK_LEASE_REJECTED', 'WEBHOOK_REPLAY_DETECTED',
      'SOURCE_DECONSTRUCTION_NO_CLEAN_RANGE', 'INVALID_API_CLIENT',
      'DUPLICATE_CAPABILITY', 'INVALID_CAPABILITY', 'INVALID_PUBLIC_SCHEMA',
      'CAPABILITY_PARITY_MISSING',
    ],
  },
  {
    status: 428, category: 'policy', codes: ['PRECONDITION_REQUIRED'],
  },
  {
    status: 500, category: 'internal', retryable: true,
    message: 'The request could not be completed',
    codes: ['INTERNAL_ERROR'],
  },
  {
    status: 502, category: 'provider', retryable: true,
    message: 'An external provider request could not be completed',
    codes: ['WEBHOOK_CHALLENGE_TRANSPORT_FAILED'],
  },
  {
    status: 503, category: 'internal', retryable: true,
    message: 'The request could not be completed',
    codes: ['AUTH_NOT_CONFIGURED', 'PERSISTENCE_NOT_CONFIGURED', 'INVALID_CAPABILITY_POLICY'],
  },
  {
    status: 429, category: 'quota', retryable: true,
    codes: ['GOVERNANCE_LIMIT_EXCEEDED'],
  },
  {
    status: 503, category: 'policy', retryable: true,
    codes: ['OPERATIONAL_KILL_SWITCH_ACTIVE'],
  },
])
