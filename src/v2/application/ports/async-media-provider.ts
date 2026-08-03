export const PROVIDER_OPERATIONS = [
  'tts',
  'audio-avatar',
  'text-avatar',
  'lip-sync',
  'image-to-video',
  'video-to-video',
  'background-replace',
  'camera-motion',
] as const

export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number]

export interface ProviderCapabilities {
  operations: readonly ProviderOperation[]
  inputFormats: readonly string[]
  outputFormats: readonly string[]
  locales?: readonly string[]
  aspectRatios?: readonly string[]
  duration: Readonly<{ minSeconds: number; maxSeconds: number }>
  identityReference: 'none' | 'image' | 'video' | 'profile-id'
  backgroundModes?: readonly string[]
  supportsSeed: boolean
  supportsIdempotency: boolean
  completion: 'polling' | 'webhook' | 'both'
  concurrencyLimit?: number
  regionRestrictions?: readonly string[]
  fetchedAt: string
  expiresAt: string
}

export interface ProviderEstimate {
  currency: string
  costMinorUnits: number
  estimatedLatencyMs: number
}

export interface ProviderSubmitContext {
  workspaceId: string
  projectVersionId: string
  operationId: string
  idempotencyKey: string
  signal?: AbortSignal
}

export type ProviderStatus =
  | 'queued'
  | 'processing'
  | 'retrieving'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ProviderWebhookEvent {
  eventId: string
  providerJobId: string
  status: ProviderStatus
  occurredAt: string
}

export interface AsyncMediaProviderAdapter<Input, Result> {
  readonly id: string
  readonly adapterVersion: string
  getCapabilities(signal?: AbortSignal): Promise<Readonly<ProviderCapabilities>>
  estimate(input: Readonly<Input>, signal?: AbortSignal): Promise<Readonly<ProviderEstimate>>
  submit(
    input: Readonly<Input>,
    context: Readonly<ProviderSubmitContext>,
  ): Promise<Readonly<{ providerJobId: string }>>
  getStatus(providerJobId: string, signal?: AbortSignal): Promise<ProviderStatus>
  retrieve(providerJobId: string, signal?: AbortSignal): Promise<Readonly<Result>>
  cancel?(providerJobId: string, signal?: AbortSignal): Promise<void>
  verifyWebhook?(request: unknown): Promise<Readonly<ProviderWebhookEvent>>
}
