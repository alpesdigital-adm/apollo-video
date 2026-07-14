import {
  createWebhookReplayReceipt,
  createWebhookVerificationChallenge,
  hashWebhookChallengeToken,
  issueWebhookChallengeToken,
  verifyWebhookSignature,
  type SignedWebhookHeaders,
} from '../domain/webhook-security.ts'
import { assertDomain } from '../domain/errors.ts'
import type {
  WebhookChallengeRepository,
  WebhookReplayReceiptRepository,
} from './ports/webhook-security-repository.ts'

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
