import { assertDomain } from './errors.ts'
import type {
  BatchEditPreflightRun,
} from './batch-edit.ts'
import type {
  ProductionBatchStep,
} from './production-batch.ts'
import type {
  VariantPortfolioPreflightRun,
} from './variant-portfolio-preflight.ts'

export interface PreflightResult {
  schemaVersion: 'preflight-result/v1'
  eligible: boolean
  fingerprint: string
  evaluatedAt: string
  targets: readonly Readonly<{ kind: string; id: string; version?: string }>[]
  conflicts: readonly Readonly<{ code: string; target: string; message: string }>[]
  invalidations: readonly Readonly<{ kind: 'artifact' | 'analysis' | 'proxy' | 'render'; id: string; reason: string }>[]
  jobs: readonly Readonly<{ kind: string; count: number; estimatedDurationMs?: number }>[]
  cost: Readonly<{ currency: 'USD'; estimatedMinorUnits: number; maximumMinorUnits: number }>
  quota: Readonly<{ unit: string; required: number; remaining: number; allowed: boolean; resetsAt?: string }>
  warnings: readonly Readonly<{ code: string; message: string; target?: string }>[]
}

const boundedText = (value: string, label: string, maximum: number) => {
  assertDomain(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, 'INVALID_ARGUMENT', `${label} is invalid`)
  return value.trim()
}

export function createPreflightResult(input: PreflightResult): Readonly<PreflightResult> {
  assertDomain(input.schemaVersion === 'preflight-result/v1', 'INVALID_ARGUMENT', 'preflight schemaVersion is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.fingerprint), 'INVALID_ARGUMENT', 'preflight fingerprint must be SHA-256')
  assertDomain(!Number.isNaN(Date.parse(input.evaluatedAt)), 'INVALID_ARGUMENT', 'preflight evaluatedAt is invalid')
  for (const [label, values, max] of [['targets', input.targets, 1024], ['conflicts', input.conflicts, 1024], ['invalidations', input.invalidations, 4096], ['jobs', input.jobs, 256], ['warnings', input.warnings, 1024]] as const) {
    assertDomain(Array.isArray(values) && values.length <= max, 'INVALID_ARGUMENT', `preflight ${label} exceeds its limit`)
  }
  const targets = input.targets.map((target) => Object.freeze({ kind: boundedText(target.kind, 'target kind', 64), id: boundedText(target.id, 'target id', 256), ...(target.version ? { version: boundedText(target.version, 'target version', 128) } : {}) }))
  const conflicts = input.conflicts.map((conflict) => Object.freeze({ code: boundedText(conflict.code, 'conflict code', 80), target: boundedText(conflict.target, 'conflict target', 256), message: boundedText(conflict.message, 'conflict message', 1000) }))
  const invalidations = input.invalidations.map((item) => {
    assertDomain(['artifact', 'analysis', 'proxy', 'render'].includes(item.kind), 'INVALID_ARGUMENT', 'invalidation kind is invalid')
    return Object.freeze({ kind: item.kind, id: boundedText(item.id, 'invalidation id', 256), reason: boundedText(item.reason, 'invalidation reason', 500) })
  })
  const jobs = input.jobs.map((job) => {
    assertDomain(Number.isInteger(job.count) && job.count >= 1 && job.count <= 100_000, 'INVALID_ARGUMENT', 'job count is invalid')
    if (job.estimatedDurationMs !== undefined) assertDomain(Number.isInteger(job.estimatedDurationMs) && job.estimatedDurationMs >= 0 && job.estimatedDurationMs <= 604_800_000, 'INVALID_ARGUMENT', 'job duration is invalid')
    return Object.freeze({ kind: boundedText(job.kind, 'job kind', 80), count: job.count, ...(job.estimatedDurationMs === undefined ? {} : { estimatedDurationMs: job.estimatedDurationMs }) })
  })
  assertDomain(input.cost.currency === 'USD' && Number.isInteger(input.cost.estimatedMinorUnits) && Number.isInteger(input.cost.maximumMinorUnits) && input.cost.estimatedMinorUnits >= 0 && input.cost.maximumMinorUnits >= input.cost.estimatedMinorUnits && input.cost.maximumMinorUnits <= 100_000_000, 'INVALID_ARGUMENT', 'preflight cost is invalid')
  assertDomain(Number.isInteger(input.quota.required) && Number.isInteger(input.quota.remaining) && input.quota.required >= 0 && input.quota.remaining >= 0 && input.quota.allowed === (input.quota.remaining >= input.quota.required), 'INVALID_ARGUMENT', 'preflight quota is inconsistent')
  if (input.quota.resetsAt) assertDomain(!Number.isNaN(Date.parse(input.quota.resetsAt)), 'INVALID_ARGUMENT', 'quota resetsAt is invalid')
  const warnings = input.warnings.map((warning) => Object.freeze({ code: boundedText(warning.code, 'warning code', 80), message: boundedText(warning.message, 'warning message', 1000), ...(warning.target ? { target: boundedText(warning.target, 'warning target', 256) } : {}) }))
  const eligible = conflicts.length === 0 && input.quota.allowed
  assertDomain(input.eligible === eligible, 'INVALID_ARGUMENT', 'preflight eligibility is inconsistent')
  return Object.freeze({ ...input, eligible, evaluatedAt: new Date(input.evaluatedAt).toISOString(), targets: Object.freeze(targets), conflicts: Object.freeze(conflicts), invalidations: Object.freeze(invalidations), jobs: Object.freeze(jobs), cost: Object.freeze({ ...input.cost }), quota: Object.freeze({ ...input.quota, unit: boundedText(input.quota.unit, 'quota unit', 64) }), warnings: Object.freeze(warnings) })
}

const invalidationKind = (
  step: ProductionBatchStep,
): PreflightResult['invalidations'][number]['kind'] => {
  switch (step) {
    case 'planning': return 'analysis'
    case 'materializing': return 'artifact'
    case 'rendering': return 'render'
    case 'reviewing': return 'proxy'
  }
}

const warningMessage = (code: string) =>
  code.toLowerCase().replaceAll('_', ' ')

export function createBatchEditPreflightResult(input: {
  run: Readonly<BatchEditPreflightRun>
  requestFingerprint: string
}): Readonly<PreflightResult> {
  const { run } = input
  const blockingProtectedTargets = run.mode === 'all-or-nothing'
    ? run.impacts.filter((impact) => impact.protectedConflict)
    : []
  const conflicts: PreflightResult['conflicts'][number][] =
    blockingProtectedTargets.flatMap((impact) =>
      impact.conflictCodes.map((code) => Object.freeze({
        code,
        target: impact.targetRef,
        message: `Batch edit target ${impact.targetRef} is protected`,
      })))
  if (run.status === 'no-change') {
    conflicts.push(Object.freeze({
      code: 'NO_EFFECTIVE_CHANGE',
      target: run.id,
      message: 'Batch edit has no effective target change',
    }))
  }
  const invalidations = run.impacts.flatMap((impact) =>
    impact.invalidatedSteps.map((step, index) => Object.freeze({
      kind: invalidationKind(step),
      id: impact.invalidatedTargetRefs[index] ?? `${impact.targetRef}:${step}`,
      reason: `${run.operation.type} invalidates ${step}`,
    })))
  const jobCounts = new Map<ProductionBatchStep, number>()
  for (const impact of run.impacts) {
    for (const step of impact.invalidatedSteps) {
      jobCounts.set(step, (jobCounts.get(step) ?? 0) + 1)
    }
  }
  return createPreflightResult({
    schemaVersion: 'preflight-result/v1',
    eligible: conflicts.length === 0 && !run.budgetExceeded,
    fingerprint: input.requestFingerprint,
    evaluatedAt: run.createdAt,
    targets: run.impacts.map((impact) => Object.freeze({
      kind: 'batch-item',
      id: impact.itemId,
      version: String(impact.beforeStateRevision),
    })),
    conflicts,
    invalidations,
    jobs: [...jobCounts.entries()].map(([step, count]) =>
      Object.freeze({ kind: `batch-${step}`, count })),
    cost: Object.freeze({
      currency: 'USD',
      estimatedMinorUnits: run.estimatedCostMinorUnits,
      maximumMinorUnits: run.estimatedCostMinorUnits,
    }),
    quota: Object.freeze({
      unit: 'USD-minor-unit',
      required: run.estimatedCostMinorUnits,
      remaining: run.budgetRemainingMinorUnits,
      allowed: !run.budgetExceeded,
    }),
    warnings: run.warningCodes.map((code) => Object.freeze({
      code,
      message: warningMessage(code),
    })),
  })
}

export function createVariantPortfolioPreflightResult(input: {
  run: Readonly<VariantPortfolioPreflightRun>
  requestFingerprint: string
}): Readonly<PreflightResult> {
  const { run } = input
  const conflicts = run.status === 'confirmation-required'
    ? [Object.freeze({
        code: 'CONFIRMATION_REQUIRED',
        target: run.id,
        message: 'Variant portfolio expansion requires confirmation',
      })]
    : run.status === 'no-eligible-recipes'
      ? [Object.freeze({
          code: 'NO_ELIGIBLE_RECIPES',
          target: run.compatibilityGraphId,
          message: 'Variant portfolio has no eligible recipe',
        })]
      : []
  const estimatedCostMinorUnits = run.estimates.estimatedCostMinorUnits
  const quotaAllowed = estimatedCostMinorUnits <= run.budgetRemainingMinorUnits
  return createPreflightResult({
    schemaVersion: 'preflight-result/v1',
    eligible: conflicts.length === 0 && quotaAllowed,
    fingerprint: input.requestFingerprint,
    evaluatedAt: run.createdAt,
    targets: run.selected.map((candidate) => Object.freeze({
      kind: 'variant-recipe-candidate',
      id: candidate.candidateHash,
      ...(candidate.reusableRecipeRunHash
        ? { version: candidate.reusableRecipeRunHash }
        : {}),
    })),
    conflicts,
    invalidations: [],
    jobs: run.estimates.plannedJobCount === 0
      ? []
      : [Object.freeze({
          kind: 'variant-render',
          count: run.estimates.plannedJobCount,
          estimatedDurationMs:
            run.estimates.estimatedDurationSeconds * 1_000,
        })],
    cost: Object.freeze({
      currency: 'USD',
      estimatedMinorUnits: estimatedCostMinorUnits,
      maximumMinorUnits: estimatedCostMinorUnits,
    }),
    quota: Object.freeze({
      unit: 'USD-minor-unit',
      required: estimatedCostMinorUnits,
      remaining: run.budgetRemainingMinorUnits,
      allowed: quotaAllowed,
    }),
    warnings: run.warningCodes.map((code) => Object.freeze({
      code,
      message: warningMessage(code),
    })),
  })
}
