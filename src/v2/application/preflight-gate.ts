import { assertDomain } from '../domain/errors.ts'
import { validatePreflightCommitTokenService } from './validate-preflight-commit-token.ts'
import type { PreflightCommitTokenIssuer } from './ports/preflight-commit-token.ts'

export const PREFLIGHT_REQUIRED_ACTION_CLASSES = ['batch', 'final-matrix', 'variable-generation', 'destructive'] as const
export type PreflightActionClass = (typeof PREFLIGHT_REQUIRED_ACTION_CLASSES)[number] | 'bounded'

export function requirePreflightForActionService(dependencies: { issuer: PreflightCommitTokenIssuer; clock?: () => Date }) {
  const validate = validatePreflightCommitTokenService(dependencies)
  return function requirePreflight(input: { actionClass: PreflightActionClass; token?: string; clientId: string; workspaceId: string; fingerprint: string; snapshot: string; costFingerprint: string }) {
    if (input.actionClass === 'bounded') return Object.freeze({ required: false as const })
    assertDomain(PREFLIGHT_REQUIRED_ACTION_CLASSES.includes(input.actionClass), 'INVALID_ARGUMENT', 'Preflight action class is invalid')
    assertDomain(typeof input.token === 'string' && input.token.length > 0, 'PRECONDITION_REQUIRED', 'Trusted preflight commit token is required')
    const evidence = validate({ ...input, token: input.token })
    return Object.freeze({ required: true as const, ...evidence })
  }
}
