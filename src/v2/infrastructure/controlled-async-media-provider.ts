import type {
  AsyncMediaProviderAdapter,
  ProviderCapabilities,
  ProviderEstimate,
  ProviderStatus,
  ProviderSubmitContext,
  ProviderSubmissionResult,
} from '../application/ports/async-media-provider.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { ProviderAdapterError } from '../domain/provider-contract.ts'

export class ControlledProviderError extends ProviderAdapterError {
  constructor(
    code: string,
    retryable: boolean,
    retryAfterMs?: number,
  ) {
    super(code, retryable, retryAfterMs, code)
    this.name = 'ControlledProviderError'
  }
}

export interface ControlledProviderScenario<Result> {
  capabilities: Readonly<ProviderCapabilities>
  estimate: Readonly<ProviderEstimate>
  statuses: readonly ProviderStatus[]
  result: Readonly<Result>
  submitFailure?: Readonly<{ code: string; retryable: boolean; retryAfterMs?: number }>
  completedAt?: string
  observedCost?: Readonly<{ currency: string; costMinorUnits: number }>
}

export class ControlledAsyncMediaProviderAdapter<Result>
implements AsyncMediaProviderAdapter<Readonly<Record<string, unknown>>, Result> {
  readonly id: string
  readonly adapterVersion: string
  readonly modelRef = 'controlled-model'
  readonly configHash: string
  private readonly scenario: Readonly<ControlledProviderScenario<Result>>
  private readonly jobs = new Map<string, { cursor: number; result: Readonly<Result> }>()
  readonly calls: string[] = []

  constructor(
    id: string,
    adapterVersion: string,
    scenario: Readonly<ControlledProviderScenario<Result>>,
  ) {
    this.id = id
    this.adapterVersion = adapterVersion
    this.scenario = scenario
    this.configHash = calculateCanonicalHash({
      id,
      adapterVersion,
      capabilities: scenario.capabilities,
      estimate: scenario.estimate,
    })
  }

  async getCapabilities() {
    this.calls.push('capabilities')
    return this.scenario.capabilities
  }

  async estimate(_input: Readonly<Record<string, unknown>>) {
    this.calls.push('estimate')
    return this.scenario.estimate
  }

  async submit(_input: Readonly<Record<string, unknown>>, context: Readonly<ProviderSubmitContext>): Promise<Readonly<ProviderSubmissionResult<Result>>> {
    this.calls.push('submit')
    if (this.scenario.submitFailure) {
      throw new ControlledProviderError(this.scenario.submitFailure.code, this.scenario.submitFailure.retryable, this.scenario.submitFailure.retryAfterMs)
    }
    const providerJobId = `${this.id}:${context.idempotencyKey}`
    if (this.scenario.capabilities.completion === 'synchronous') {
      return Object.freeze({
        kind: 'completed' as const,
        bundle: Object.freeze({
          providerJobRef: providerJobId,
          result: this.scenario.result,
          completedAt: this.scenario.completedAt ?? '1970-01-01T00:00:00.000Z',
          ...(this.scenario.observedCost ? { observedCost: this.scenario.observedCost } : {}),
        }),
      })
    }
    if (!this.jobs.has(providerJobId)) this.jobs.set(providerJobId, { cursor: 0, result: this.scenario.result })
    return Object.freeze({ kind: 'accepted' as const, providerJobId })
  }

  async getStatus(providerJobId: string) {
    this.calls.push('status')
    const job = this.jobs.get(providerJobId)
    if (!job) throw new ControlledProviderError('JOB_NOT_FOUND', false)
    const status = this.scenario.statuses[Math.min(job.cursor, this.scenario.statuses.length - 1)] ?? 'failed'
    job.cursor += 1
    return status
  }

  async retrieve(providerJobId: string) {
    this.calls.push('retrieve')
    const job = this.jobs.get(providerJobId)
    if (!job) throw new ControlledProviderError('JOB_NOT_FOUND', false)
    return job.result
  }

  async cancel(providerJobId: string) {
    this.calls.push('cancel')
    if (!this.jobs.has(providerJobId)) throw new ControlledProviderError('JOB_NOT_FOUND', false)
  }
}
