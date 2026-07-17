import { DomainError } from '../domain/errors.ts'

export interface OperationalAlertSink { emit(alert: Readonly<{ code: string; workspaceId: string; clientId: string; observed: number; threshold: number }>): Promise<void> }

export function enforceOperationalSafetyService(dependencies: { alerts: OperationalAlertSink; killSwitch?: () => boolean }) {
  return async function enforce(input: { workspaceId: string; clientId: string; metric: 'error-rate' | 'spend-spike' | 'request-spike'; observed: number; threshold: number }) {
    if (dependencies.killSwitch?.()) throw new DomainError('OPERATIONAL_KILL_SWITCH_ACTIVE', 'Operational kill switch is active')
    if (!Number.isFinite(input.observed) || !Number.isFinite(input.threshold) || input.threshold < 0) throw new DomainError('INVALID_ARGUMENT', 'Anomaly values are invalid')
    const anomalous = input.observed > input.threshold
    if (anomalous) await dependencies.alerts.emit(Object.freeze({ code: input.metric.toUpperCase().replaceAll('-', '_'), workspaceId: input.workspaceId, clientId: input.clientId, observed: input.observed, threshold: input.threshold }))
    return Object.freeze({ allowed: !anomalous, anomalous })
  }
}

export const environmentKillSwitch = (environment: NodeJS.ProcessEnv = process.env) => () => environment.APOLLO_OPERATIONAL_KILL_SWITCH?.trim().toLowerCase() === 'true'
