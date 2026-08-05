import { assertDomain } from '../domain/errors.ts'
import { validatePreflightCommitTokenService } from './validate-preflight-commit-token.ts'
import type { PreflightCommitTokenIssuer } from './ports/preflight-commit-token.ts'

export const PREFLIGHT_REQUIRED_ACTION_CLASSES = ['batch', 'final-matrix', 'variable-generation', 'destructive'] as const
export type PreflightActionClass = (typeof PREFLIGHT_REQUIRED_ACTION_CLASSES)[number] | 'bounded'

export const PREFLIGHT_ACTION_POLICIES = Object.freeze({
  'batch-edit.commit': Object.freeze({
    actionClass: 'batch' as const,
    reason: 'Commits one explicit batch-wide edit and its invalidations',
  }),
  'variant-portfolio.confirm': Object.freeze({
    actionClass: 'variable-generation' as const,
    reason: 'Confirms expansion beyond the bounded variant portfolio default',
  }),
  'final-export-matrix.commit': Object.freeze({
    actionClass: 'final-matrix' as const,
    reason: 'Commits a multi-format final render or export matrix',
  }),
  'destructive-command.commit': Object.freeze({
    actionClass: 'destructive' as const,
    reason: 'Commits an explicitly preflighted destructive command',
  }),
  'project-final-export.enqueue': Object.freeze({
    actionClass: 'bounded' as const,
    reason: 'Enqueues one approved format; a multi-format final matrix is a distinct action',
  }),
})

export type PreflightActionId = keyof typeof PREFLIGHT_ACTION_POLICIES

export function requirePreflightForActionService(dependencies: {
  issuer?: PreflightCommitTokenIssuer
  clock?: () => Date
} = {}) {
  return function requirePreflight(input: {
    actionId: string
    token?: string
    clientId?: string
    workspaceId?: string
    fingerprint?: string
    snapshot?: string
    costFingerprint?: string
  }) {
    const policy = PREFLIGHT_ACTION_POLICIES[
      input.actionId as PreflightActionId
    ]
    assertDomain(
      Boolean(policy),
      'PRECONDITION_REQUIRED',
      'Preflight action is not explicitly classified',
    )
    if (policy.actionClass === 'bounded') {
      return Object.freeze({
        required: false as const,
        actionId: input.actionId as PreflightActionId,
        actionClass: policy.actionClass,
        reason: policy.reason,
      })
    }
    assertDomain(
      PREFLIGHT_REQUIRED_ACTION_CLASSES.includes(policy.actionClass),
      'PRECONDITION_REQUIRED',
      'Preflight action policy is invalid',
    )
    assertDomain(
      Boolean(dependencies.issuer),
      'PERSISTENCE_NOT_CONFIGURED',
      'Preflight commit token verifier is not configured',
    )
    assertDomain(
      typeof input.token === 'string' && input.token.length > 0,
      'PRECONDITION_REQUIRED',
      'Trusted preflight commit token is required',
    )
    assertDomain(
      typeof input.clientId === 'string' &&
        typeof input.workspaceId === 'string' &&
        typeof input.fingerprint === 'string' &&
        typeof input.snapshot === 'string' &&
        typeof input.costFingerprint === 'string',
      'PRECONDITION_REQUIRED',
      'Trusted preflight binding is incomplete',
    )
    const evidence = validatePreflightCommitTokenService({
      issuer: dependencies.issuer!,
      clock: dependencies.clock,
    })({
      token: input.token,
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      costFingerprint: input.costFingerprint,
    })
    return Object.freeze({
      required: true as const,
      actionId: input.actionId as PreflightActionId,
      actionClass: policy.actionClass,
      reason: policy.reason,
      ...evidence,
    })
  }
}
