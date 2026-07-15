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

export interface WebhookChallengeTarget {
  workspaceId: string
  endpointId: string
  url: string
}

export interface WebhookChallengeTargetRepository {
  getPendingTarget(
    workspaceId: string,
    endpointId: string,
  ): Promise<Readonly<WebhookChallengeTarget>>
}

export type WebhookEndpointActivationState =
  | Readonly<{ status: 'pending'; workspaceId: string; endpointId: string; url: string }>
  | Readonly<{ status: 'active'; workspaceId: string; endpointId: string }>
  | Readonly<{ status: 'blocked'; workspaceId: string; endpointId: string }>

export interface WebhookEndpointActivationStateRepository {
  getActivationState(
    workspaceId: string,
    endpointId: string,
  ): Promise<Readonly<WebhookEndpointActivationState>>
}
