import { assertDomain } from '../domain/errors.ts'
import type { WebhookSigningSecretHygieneRepository } from './ports/webhook-signing-secret-hygiene-repository.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export function runWebhookSigningSecretHygieneService(dependencies: {
  repository: WebhookSigningSecretHygieneRepository
  clock: () => Date
}) {
  return async (request: { workspaceId: string; limitPerKind: number }) => {
    const workspaceId = request.workspaceId.trim()
    assertDomain(SAFE_ID_PATTERN.test(workspaceId), 'INVALID_ARGUMENT', 'workspaceId is invalid')
    assertDomain(
      Number.isSafeInteger(request.limitPerKind) && request.limitPerKind >= 1 && request.limitPerKind <= 100,
      'INVALID_ARGUMENT',
      'limitPerKind must be an integer from 1 to 100',
    )
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'clock is invalid')
    return dependencies.repository.run({
      workspaceId,
      asOf: now.toISOString(),
      limitPerKind: request.limitPerKind,
    })
  }
}
