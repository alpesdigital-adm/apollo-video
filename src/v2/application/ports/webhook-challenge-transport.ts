export interface WebhookChallengeTransportRequest {
  url: string
  challengeId: string
  token: string
  expiresAt: string
}

export interface WebhookChallengeTransportResponse {
  echoedToken: string
}

export interface WebhookChallengeTransport {
  send(
    request: Readonly<WebhookChallengeTransportRequest>,
  ): Promise<Readonly<WebhookChallengeTransportResponse>>
}
