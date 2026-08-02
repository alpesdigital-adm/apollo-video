import { assertPublicOperation, type PublicOperation } from './public-operation.ts'

export const VISIBLE_STATE_LABELS = [
  'queued',
  'in-progress',
  'waiting',
  'retry-scheduled',
  'completed',
  'failed',
  'canceled',
] as const

export const VISIBLE_STATE_ACTIONS = [
  'view-progress',
  'cancel',
  'resolve-dependency',
  'open-result',
  'inspect-error',
  'retry',
] as const

export type VisibleStateLabel = (typeof VISIBLE_STATE_LABELS)[number]
export type VisibleStateAction = (typeof VISIBLE_STATE_ACTIONS)[number]

export interface VisibleProgress {
  mode: 'not-started' | 'determinate' | 'indeterminate' | 'complete' | 'none'
  percent?: number
}

export interface VisibleState {
  schemaVersion: 'visible-state/v1'
  label: VisibleStateLabel
  tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success'
  progress: Readonly<VisibleProgress>
  primaryAction: VisibleStateAction
  availableActions: readonly VisibleStateAction[]
  terminal: boolean
}

function freezeVisibleState(input: Omit<VisibleState, 'schemaVersion'>): Readonly<VisibleState> {
  return Object.freeze({
    schemaVersion: 'visible-state/v1' as const,
    ...input,
    progress: Object.freeze({ ...input.progress }),
    availableActions: Object.freeze([...input.availableActions]),
  })
}

function runningProgress(operation: PublicOperation): Readonly<VisibleProgress> {
  const progress = operation.progress
  if (!progress?.total) return Object.freeze({ mode: 'indeterminate' as const })
  return Object.freeze({
    mode: 'determinate' as const,
    percent: Math.round((progress.completed / progress.total) * 100),
  })
}

export function presentPublicOperationVisibleState(
  operation: PublicOperation,
): Readonly<VisibleState> {
  assertPublicOperation(operation)
  switch (operation.status) {
    case 'queued':
      return freezeVisibleState({
        label: 'queued', tone: 'neutral',
        progress: { mode: 'not-started', percent: 0 },
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
    case 'running':
      return freezeVisibleState({
        label: 'in-progress', tone: 'info', progress: runningProgress(operation),
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
    case 'waiting':
      return freezeVisibleState({
        label: 'waiting', tone: 'warning', progress: { mode: 'indeterminate' },
        primaryAction: 'resolve-dependency',
        availableActions: ['resolve-dependency', 'cancel'], terminal: false,
      })
    case 'retrying':
      return freezeVisibleState({
        label: 'retry-scheduled', tone: 'warning', progress: { mode: 'indeterminate' },
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
    case 'succeeded':
      return freezeVisibleState({
        label: 'completed', tone: 'success', progress: { mode: 'complete', percent: 100 },
        primaryAction: 'open-result', availableActions: ['open-result'], terminal: true,
      })
    case 'failed':
      return freezeVisibleState({
        label: 'failed', tone: 'danger', progress: { mode: 'none' },
        primaryAction: 'retry', availableActions: ['retry', 'inspect-error'], terminal: true,
      })
    case 'canceled':
      return freezeVisibleState({
        label: 'canceled', tone: 'neutral', progress: { mode: 'none' },
        primaryAction: 'retry', availableActions: ['retry'], terminal: true,
      })
  }
}
