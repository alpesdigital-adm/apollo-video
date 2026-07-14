import type { AssetUseDecision } from './asset-rights.ts'
import { assertDomain } from './errors.ts'

export const MATERIALIZATION_ISSUE_CODES = [
  'RENDERER_UNAVAILABLE',
  'COMPOSITION_UNAVAILABLE',
  'ASSET_NOT_FOUND',
  'ASSET_UNAVAILABLE',
  'ASSET_IDENTITY_MISMATCH',
  'ASSET_KIND_UNSUPPORTED',
  'ASSET_RIGHTS_DENIED',
] as const
export type MaterializationIssueCode = (typeof MATERIALIZATION_ISSUE_CODES)[number]

export interface MaterializationAuthorizationIssue {
  code: MaterializationIssueCode
  assetOrdinal?: number
  assetKind?: string
}

export interface MaterializationAssetDecision extends AssetUseDecision {
  artifactId: string
  assetOrdinal: number
  assetKind: string
}

export interface MaterializationAuthorization {
  schemaVersion: 'materialization-authorization/v1'
  id: string
  workspaceId: string
  artifactId: string
  manifestId: string
  inputHash: string
  use: string
  market?: string
  locale: string
  syntheticOperations: readonly string[]
  status: 'authorized' | 'denied'
  issues: readonly MaterializationAuthorizationIssue[]
  decisions: readonly MaterializationAssetDecision[]
  evaluatedAt: string
  validUntil?: string
  revalidationRequired: true
  actor: { type: 'api-client'; id: string }
}

export function createMaterializationAuthorization(input: Omit<
  MaterializationAuthorization,
  'schemaVersion' | 'status' | 'validUntil' | 'revalidationRequired'
>): MaterializationAuthorization {
  const evaluatedAt = new Date(input.evaluatedAt)
  assertDomain(!Number.isNaN(evaluatedAt.getTime()), 'INVALID_ARGUMENT', 'evaluatedAt is invalid')
  const status =
    input.issues.length === 0 &&
    input.decisions.every((decision) => decision.outcome === 'allow')
      ? 'authorized'
      : 'denied'
  const validUntil =
    status === 'authorized'
      ? input.decisions
          .map((decision) => decision.validUntil)
          .reduce<string | undefined>((earliest, candidate) => {
            if (!candidate) return earliest
            if (!earliest) return candidate
            return new Date(candidate).getTime() < new Date(earliest).getTime()
              ? candidate
              : earliest
          }, new Date(evaluatedAt.getTime() + 300_000).toISOString())
      : undefined
  assertDomain(
    status === 'denied' || validUntil !== undefined,
    'INVALID_ARGUMENT',
    'Authorized materialization requires a bounded validity period',
  )

  return Object.freeze({
    schemaVersion: 'materialization-authorization/v1',
    ...input,
    syntheticOperations: Object.freeze([...input.syntheticOperations]),
    status,
    issues: Object.freeze(input.issues.map((issue) => Object.freeze({ ...issue }))),
    decisions: Object.freeze(
      input.decisions.map((decision) =>
        Object.freeze({
          ...decision,
          reasonCodes: Object.freeze([...decision.reasonCodes]),
        }),
      ),
    ),
    evaluatedAt: evaluatedAt.toISOString(),
    ...(validUntil ? { validUntil } : {}),
    revalidationRequired: true,
    actor: Object.freeze({ ...input.actor }),
  })
}
