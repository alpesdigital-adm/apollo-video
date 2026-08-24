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

export interface ProviderEstimate {
  currency: string
  costMinorUnits: number
  estimatedLatencyMs: number
}

export type ProviderStatus =
  | 'queued'
  | 'processing'
  | 'retrieving'
  | 'completed'
  | 'failed'
  | 'cancelled'
