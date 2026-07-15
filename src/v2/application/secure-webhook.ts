import {
  createWebhookReplayReceipt,
  createWebhookVerificationChallenge,
  hashWebhookChallengeToken,
  issueWebhookChallengeToken,
  verifyWebhookSignature,
  type SignedWebhookHeaders,
} from '../domain/webhook-security.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type {
  WebhookChallengeRepository,
  WebhookChallengeTargetRepository,
  WebhookEndpointActivationStateRepository,
  WebhookReplayReceiptRepository,
} from './ports/webhook-security-repository.ts'
import type { WebhookChallengeTransport } from './ports/webhook-challenge-transport.ts'

export interface IssueWebhookChallengeDependencies {
  repository: WebhookChallengeRepository
  clock: () => Date
  createId: () => string
  issueToken?: () => Readonly<{ token: string; tokenHash: string }>
}

export function issueWebhookChallengeService(
  dependencies: IssueWebhookChallengeDependencies,
) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    ttlSeconds?: number
    maxAttempts?: number
  }) {
    const ttlSeconds = request.ttlSeconds ?? 10 * 60
    const maxAttempts = request.maxAttempts ?? 5
    assertDomain(
      Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 15 * 60,
      'INVALID_WEBHOOK',
      'Webhook challenge ttlSeconds must be between 60 and 900',
    )
    assertDomain(
      Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10,
      'INVALID_WEBHOOK',
      'Webhook challenge maxAttempts must be between 1 and 10',
    )
    const now = dependencies.clock()
    const issued = (dependencies.issueToken ?? issueWebhookChallengeToken)()
    const challenge = createWebhookVerificationChallenge({
      id: dependencies.createId(),
      workspaceId: request.workspaceId,
      endpointId: request.endpointId,
      tokenHash: issued.tokenHash,
      status: 'pending',
      attemptCount: 0,
      maxAttempts,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    })
    const persisted = await dependencies.repository.issue(challenge)
    return Object.freeze({ challenge: persisted, token: issued.token })
  }
}

export function verifyWebhookChallengeService(dependencies: {
  repository: WebhookChallengeRepository
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    challengeId: string
    echoedToken: string
  }) {
    return dependencies.repository.verify({
      workspaceId: request.workspaceId,
      endpointId: request.endpointId,
      challengeId: request.challengeId,
      responseHash: hashWebhookChallengeToken(request.echoedToken),
      verifiedAt: dependencies.clock().toISOString(),
    })
  }
}

export function activateWebhookEndpointService(dependencies: {
  repository: WebhookChallengeRepository & WebhookChallengeTargetRepository
  transport: WebhookChallengeTransport
  clock: () => Date
  createId: () => string
  issueToken?: () => Readonly<{ token: string; tokenHash: string }>
}) {
  const issue = issueWebhookChallengeService(dependencies)
  const verify = verifyWebhookChallengeService(dependencies)

  return async function execute(request: {
    workspaceId: string
    endpointId: string
    ttlSeconds?: number
    maxAttempts?: number
  }) {
    const target = await dependencies.repository.getPendingTarget(
      request.workspaceId,
      request.endpointId,
    )
    const issued = await issue(request)
    const response = await dependencies.transport.send({
      url: target.url,
      challengeId: issued.challenge.id,
      token: issued.token,
      expiresAt: issued.challenge.expiresAt,
    })
    return verify({
      workspaceId: request.workspaceId,
      endpointId: request.endpointId,
      challengeId: issued.challenge.id,
      echoedToken: response.echoedToken,
    })
  }
}

export function activateWebhookEndpointConvergentlyService(dependencies: {
  repository: WebhookChallengeRepository & WebhookEndpointActivationStateRepository
  transport: WebhookChallengeTransport
  clock: () => Date
  createId: () => string
  issueToken?: () => Readonly<{ token: string; tokenHash: string }>
}) {
  const issue = issueWebhookChallengeService(dependencies)
  const verify = verifyWebhookChallengeService(dependencies)

  return async function execute(request: {
    workspaceId: string
    endpointId: string
    ttlSeconds?: number
    maxAttempts?: number
  }) {
    const activate = async () => {
      const state = await dependencies.repository.getActivationState(
        request.workspaceId,
        request.endpointId,
      )
      if (state.status === 'active') {
        return Object.freeze({ activatedSubscriptions: 0, replayed: true })
      }
      assertDomain(
        state.status === 'pending',
        'WEBHOOK_CHALLENGE_REJECTED',
        'Webhook endpoint cannot be activated from its current state',
      )
      const issued = await issue(request)
      const response = await dependencies.transport.send({
        url: state.url,
        challengeId: issued.challenge.id,
        token: issued.token,
        expiresAt: issued.challenge.expiresAt,
      })
      const verified = await verify({
        workspaceId: request.workspaceId,
        endpointId: request.endpointId,
        challengeId: issued.challenge.id,
        echoedToken: response.echoedToken,
      })
      return Object.freeze({
        activatedSubscriptions: verified.activatedSubscriptions,
        replayed: false,
      })
    }

    try {
      return await activate()
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['WEBHOOK_CHALLENGE_NOT_FOUND', 'WEBHOOK_CHALLENGE_REJECTED'].includes(error.code)
      ) {
        const current = await dependencies.repository.getActivationState(
          request.workspaceId,
          request.endpointId,
        )
        if (current.status === 'active') {
          return Object.freeze({ activatedSubscriptions: 0, replayed: true })
        }
      }
      throw error
    }
  }
}

export function verifyWebhookRequestService(dependencies: {
  replayReceipts: WebhookReplayReceiptRepository
  clock: () => Date
  createId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    endpointId: string
    secret: Uint8Array
    rawBody: Uint8Array
    headers: SignedWebhookHeaders
    toleranceSeconds?: number
  }) {
    const now = dependencies.clock()
    const toleranceSeconds = request.toleranceSeconds ?? 300
    const verified = verifyWebhookSignature({
      secret: request.secret,
      rawBody: request.rawBody,
      headers: request.headers,
      now,
      toleranceSeconds,
    })
    const retentionSeconds = Math.max(10 * 60, toleranceSeconds * 2)
    const receipt = createWebhookReplayReceipt({
      id: dependencies.createId(),
      workspaceId: request.workspaceId,
      endpointId: request.endpointId,
      eventId: verified.eventId,
      signatureTimestamp: verified.timestamp,
      receivedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + retentionSeconds * 1_000).toISOString(),
    })
    await dependencies.replayReceipts.consume(receipt)
    return verified
  }
}
