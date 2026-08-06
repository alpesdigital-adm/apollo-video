import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  GOVERNANCE_ANOMALY_REASONS,
  type GovernanceAnomalyReason,
} from './governance-anomaly.ts'
import type { GovernanceDecisionReason } from './governance-admission.ts'
import { GOVERNANCE_LIMIT_REASONS } from './governance-limits.ts'

export const GOVERNANCE_ALERT_SCHEMA_VERSION =
  'governance-alert/v1' as const
export const GOVERNANCE_ALERT_SCHEMA_VERSION_V2 =
  'governance-alert/v2' as const

export interface GovernanceAlert {
  schemaVersion:
    | typeof GOVERNANCE_ALERT_SCHEMA_VERSION
    | typeof GOVERNANCE_ALERT_SCHEMA_VERSION_V2
  alertHash: string
  workspaceId: string
  clientId: string
  admissionId: string
  admissionHash: string
  scopeType: 'workspace' | 'client'
  reasonCode: GovernanceDecisionReason
  observed: number
  threshold: number
  policyHash?: string
  anomalyRecoveryBypassed?: boolean
  windowStartedAt?: string
  windowEndedAt?: string
  createdAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA = /^[a-f0-9]{64}$/
const MAX_COUNTER = 2_000_000_000
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

function instant(value: string, field: string) {
  const timestamp = Date.parse(value)
  assertDomain(
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

export function createGovernanceAlert(
  input: Omit<GovernanceAlert, 'schemaVersion' | 'alertHash'> & {
    schemaVersion?: GovernanceAlert['schemaVersion']
    alertHash?: string
  },
): Readonly<GovernanceAlert> {
  const schemaVersion = input.schemaVersion ?? GOVERNANCE_ALERT_SCHEMA_VERSION
  assertDomain(
    schemaVersion === GOVERNANCE_ALERT_SCHEMA_VERSION ||
      schemaVersion === GOVERNANCE_ALERT_SCHEMA_VERSION_V2,
    'INVALID_ARGUMENT',
    'governance alert schema version is invalid',
  )
  assertDomain(
    ID.test(input.workspaceId) && ID.test(input.clientId) &&
      ID.test(input.admissionId) && SHA.test(input.admissionHash) &&
      (input.scopeType === 'workspace' || input.scopeType === 'client') &&
      [...GOVERNANCE_LIMIT_REASONS, ...GOVERNANCE_ANOMALY_REASONS]
        .includes(input.reasonCode as never) &&
      Number.isSafeInteger(input.observed) && input.observed >= 0 &&
      input.observed <= MAX_COUNTER &&
      Number.isSafeInteger(input.threshold) && input.threshold >= 0 &&
      input.threshold <= MAX_COUNTER,
    'INVALID_ARGUMENT',
    'governance alert evidence is invalid',
  )
  const createdAt = instant(input.createdAt, 'governance alert timestamp')
  const common = Object.freeze({
    workspaceId: input.workspaceId,
    clientId: input.clientId,
    admissionId: input.admissionId,
    admissionHash: input.admissionHash,
    scopeType: input.scopeType,
    reasonCode: input.reasonCode,
    observed: input.observed,
    threshold: input.threshold,
    createdAt,
  })
  let content: Omit<GovernanceAlert, 'schemaVersion' | 'alertHash'>
  if (schemaVersion === GOVERNANCE_ALERT_SCHEMA_VERSION_V2) {
    const windowStartedAt = instant(
      input.windowStartedAt ?? '',
      'governance alert window start',
    )
    const windowEndedAt = instant(
      input.windowEndedAt ?? '',
      'governance alert window end',
    )
    const windowMs = Date.parse(windowEndedAt) - Date.parse(windowStartedAt)
    assertDomain(
      typeof input.policyHash === 'string' && SHA.test(input.policyHash) &&
        typeof input.anomalyRecoveryBypassed === 'boolean' &&
        windowMs >= 1 && windowMs <= MAX_WINDOW_MS &&
        windowEndedAt === createdAt &&
        (!input.anomalyRecoveryBypassed ||
          GOVERNANCE_ANOMALY_REASONS.includes(
            input.reasonCode as GovernanceAnomalyReason,
          )),
      'INVALID_ARGUMENT',
      'governance alert policy evidence is invalid',
    )
    content = Object.freeze({
      ...common,
      policyHash: input.policyHash,
      anomalyRecoveryBypassed: input.anomalyRecoveryBypassed,
      windowStartedAt,
      windowEndedAt,
    })
  } else {
    assertDomain(
      GOVERNANCE_LIMIT_REASONS.includes(input.reasonCode as never) &&
        input.policyHash === undefined &&
        input.anomalyRecoveryBypassed === undefined &&
        input.windowStartedAt === undefined && input.windowEndedAt === undefined,
      'INVALID_ARGUMENT',
      'legacy governance alert cannot contain anomaly evidence',
    )
    content = common
  }
  const alertHash = calculateCanonicalHash({ schemaVersion, ...content })
  assertDomain(
    input.alertHash === undefined || input.alertHash === alertHash,
    'PERSISTENCE_CONFLICT',
    'governance alert hash is invalid',
  )
  return Object.freeze({ schemaVersion, ...content, alertHash })
}
