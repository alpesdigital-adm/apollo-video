import type {
  ProviderCompletionMode,
  ProviderEstimate,
  ProviderOperation,
  ProviderStatus,
  ProviderSubmissionResult,
} from '../../domain/provider-contract.ts'

export {
  PROVIDER_COMPLETION_MODES,
  PROVIDER_OPERATIONS,
  ProviderAdapterError,
} from '../../domain/provider-contract.ts'
export type {
  ProviderCompletionMode,
  ProviderEstimate,
  ProviderObservedCost,
  ProviderOperation,
  ProviderResultBundle,
  ProviderStatus,
  ProviderSubmissionResult,
} from '../../domain/provider-contract.ts'

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
  /**
   * True only when the PROVIDER itself deduplicates repeated submissions
   * (a server-side idempotency key). Apollo's own replay/idempotency
   * protection is independent of this flag and always applies.
   */
  supportsIdempotency: boolean
  /**
   * True only when the provider officially supports cancellation and the
   * adapter implements `cancel`. Declaring cancellation that the provider
   * does not offer is a false capability.
   */
  supportsCancellation: boolean
  completion: ProviderCompletionMode
  concurrencyLimit?: number
  regionRestrictions?: readonly string[]
  fetchedAt: string
  expiresAt: string
}

export interface ProviderSubmitContext {
  workspaceId: string
  projectVersionId: string
  operationId: string
  idempotencyKey: string
  signal?: AbortSignal
}

export interface ProviderWebhookEvent {
  eventId: string
  providerJobId: string
  status: ProviderStatus
  occurredAt: string
}

/**
 * The single canonical contract for external synthetic-media providers.
 *
 * Adapters are versioned runtimes: `adapterVersion` identifies the adapter
 * code, `modelRef` identifies the provider model in use (when the provider
 * exposes one), and `configHash` is the canonical hash of the adapter's
 * non-secret runtime configuration (hosts, timeouts, limits, cost config).
 * Together they let every persisted artifact and master name the exact
 * adapter/model/config that produced it.
 *
 * Method availability must match the declared completion mode:
 * - `synchronous`: `submit` returns `{kind:'completed', bundle}`;
 *   `getStatus`/`retrieve` are never invoked by the worker.
 * - `polling`/`webhook`/`both`: `submit` returns `{kind:'accepted'}` and
 *   `getStatus` + `retrieve` are mandatory.
 */
export interface AsyncMediaProviderAdapter<Input, Result> {
  readonly id: string
  readonly adapterVersion: string
  readonly modelRef?: string
  readonly configHash: string
  getCapabilities(signal?: AbortSignal): Promise<Readonly<ProviderCapabilities>>
  estimate(input: Readonly<Input>, signal?: AbortSignal): Promise<Readonly<ProviderEstimate>>
  submit(
    input: Readonly<Input>,
    context: Readonly<ProviderSubmitContext>,
  ): Promise<Readonly<ProviderSubmissionResult<Result>>>
  getStatus?(providerJobId: string, signal?: AbortSignal): Promise<ProviderStatus>
  retrieve?(providerJobId: string, signal?: AbortSignal): Promise<Readonly<Result>>
  cancel?(providerJobId: string, signal?: AbortSignal): Promise<void>
  verifyWebhook?(request: unknown): Promise<Readonly<ProviderWebhookEvent>>
}
