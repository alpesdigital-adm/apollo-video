import type {
  WebhookReplayReceipt,
  WebhookVerificationChallenge,
} from '../../domain/webhook-security.ts'

export interface VerifyWebhookChallengeCommand {
  workspaceId: string
  endpointId: string
  challengeId: string
  responseHash: string
  verifiedAt: string
}

export interface VerifyWebhookChallengeResult {
  challenge: Readonly<WebhookVerificationChallenge>
  activatedSubscriptions: number
}

export interface WebhookChallengeRepository {
  issue(challenge: Readonly<WebhookVerificationChallenge>): Promise<WebhookVerificationChallenge>
  verify(command: VerifyWebhookChallengeCommand): Promise<VerifyWebhookChallengeResult>
}

export interface WebhookReplayReceiptRepository {
  consume(receipt: Readonly<WebhookReplayReceipt>): Promise<WebhookReplayReceipt>
}
