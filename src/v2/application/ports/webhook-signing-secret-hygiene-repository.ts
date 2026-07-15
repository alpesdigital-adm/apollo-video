export interface WebhookSigningSecretHygieneCommand {
  workspaceId: string
  asOf: string
  limitPerKind: number
}

export interface WebhookSigningSecretHygieneResult {
  asOf: string
  expiredRotations: number
  destroyedRotationEnvelopes: number
  destroyedSigningSecretPayloads: number
  hasMore: boolean
}

export interface WebhookSigningSecretHygieneRepository {
  run(
    command: Readonly<WebhookSigningSecretHygieneCommand>,
  ): Promise<Readonly<WebhookSigningSecretHygieneResult>>
}
