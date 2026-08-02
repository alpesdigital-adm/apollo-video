import { assertPublicOperation, type PublicOperation } from './public-operation.ts'
import {
  batchProgress,
  deriveBatchStatus,
  hydrateProductionBatch,
  type BatchItem,
  type ProductionBatch,
} from './production-batch.ts'
import {
  parseCommandArtifactInvalidation,
  type CommandArtifactInvalidationV1,
} from './command-impact.ts'
import {
  MEDIA_ARTIFACT_LIFECYCLE_STATUSES,
  type MediaArtifactLifecycleStatus,
} from './media-artifact.ts'
import { assertDomain } from './errors.ts'
import { PROJECT_STATUSES, type ProjectStatus } from './project.ts'

export const VISIBLE_STATE_LABELS = [
  'queued',
  'in-progress',
  'waiting',
  'retry-scheduled',
  'completed',
  'failed',
  'canceled',
  'review-required',
  'partially-completed',
  'partially-failed',
  'superseded',
  'stale-output',
  'available',
  'quarantined',
  'deleted',
  'draft',
  'ingesting',
  'perceiving',
  'planning',
  'generating',
  'reviewing-assets',
  'rendering-proxy',
  'reviewing-proxy',
  'revising',
  'rendering-final',
  'archived',
] as const

export const VISIBLE_STATE_ACTIONS = [
  'view-progress',
  'cancel',
  'resolve-dependency',
  'open-result',
  'inspect-error',
  'retry',
  'review-output',
  'open-results',
  'retry-failed',
  'inspect-history',
  'rebuild-output',
  'open-historical-output',
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

function determinateProgress(percent: number): Readonly<VisibleProgress> {
  return Object.freeze({ mode: 'determinate' as const, percent })
}

function batchItemPercent(item: Readonly<BatchItem>): number {
  return Math.floor(
    item.steps.filter((step) => step.state === 'completed').length /
      item.steps.length * 100,
  )
}

function presentValidatedBatchItemVisibleState(
  item: Readonly<BatchItem>,
): Readonly<VisibleState> {
  const progress = determinateProgress(batchItemPercent(item))
  switch (item.state) {
    case 'queued':
      return freezeVisibleState({
        label: 'queued', tone: 'neutral', progress,
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
    case 'planning':
    case 'materializing':
    case 'rendering':
      return freezeVisibleState({
        label: 'in-progress', tone: 'info', progress,
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
    case 'reviewing':
      return freezeVisibleState({
        label: 'review-required', tone: 'warning', progress,
        primaryAction: 'review-output', availableActions: ['review-output', 'cancel'], terminal: false,
      })
    case 'completed':
      return freezeVisibleState({
        label: 'completed', tone: 'success', progress: { mode: 'complete', percent: 100 },
        primaryAction: 'open-result', availableActions: ['open-result'], terminal: true,
      })
    case 'failed':
      return freezeVisibleState({
        label: 'failed', tone: 'danger', progress,
        primaryAction: 'retry', availableActions: ['retry', 'inspect-error'], terminal: true,
      })
    case 'cancelled':
      return freezeVisibleState({
        label: 'canceled', tone: 'neutral', progress,
        primaryAction: 'retry', availableActions: ['retry'], terminal: true,
      })
    case 'superseded':
      return freezeVisibleState({
        label: 'superseded', tone: 'neutral', progress: { mode: 'none' },
        primaryAction: 'inspect-history', availableActions: ['inspect-history'], terminal: true,
      })
  }
}

export interface ProductionBatchVisibleStates {
  batch: Readonly<VisibleState>
  items: readonly Readonly<{ itemId: string; visibleState: Readonly<VisibleState> }>[]
}

export function presentProductionBatchVisibleStates(
  input: Readonly<ProductionBatch>,
): Readonly<ProductionBatchVisibleStates> {
  const batch = hydrateProductionBatch(input)
  const progress = batchProgress(batch)
  const status = deriveBatchStatus(batch)
  const allItemsTerminal = batch.items.every((item) =>
    ['completed', 'failed', 'cancelled', 'superseded'].includes(item.state))
  let visibleState: Readonly<VisibleState>
  switch (status) {
    case 'queued':
      visibleState = freezeVisibleState({
        label: 'queued', tone: 'neutral', progress: determinateProgress(progress.percent),
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
      break
    case 'running':
      visibleState = freezeVisibleState({
        label: 'in-progress', tone: 'info', progress: determinateProgress(progress.percent),
        primaryAction: 'view-progress', availableActions: ['view-progress', 'cancel'], terminal: false,
      })
      break
    case 'review':
      visibleState = freezeVisibleState({
        label: 'review-required', tone: 'warning', progress: determinateProgress(progress.percent),
        primaryAction: 'review-output', availableActions: ['review-output', 'cancel'], terminal: false,
      })
      break
    case 'partially-completed': {
      const hasFailures = progress.failedItems > 0
      visibleState = freezeVisibleState({
        label: hasFailures ? 'partially-failed' : 'partially-completed',
        tone: hasFailures ? 'danger' : 'warning',
        progress: determinateProgress(progress.percent),
        primaryAction: hasFailures ? 'retry-failed' : 'open-results',
        availableActions: hasFailures
          ? ['retry-failed', 'inspect-error', 'open-results']
          : ['open-results', 'retry'],
        terminal: allItemsTerminal,
      })
      break
    }
    case 'completed':
      visibleState = freezeVisibleState({
        label: 'completed', tone: 'success', progress: { mode: 'complete', percent: 100 },
        primaryAction: 'open-results', availableActions: ['open-results'], terminal: true,
      })
      break
    case 'failed':
      visibleState = freezeVisibleState({
        label: 'failed', tone: 'danger', progress: determinateProgress(progress.percent),
        primaryAction: 'retry-failed', availableActions: ['retry-failed', 'inspect-error'], terminal: true,
      })
      break
    case 'cancelled':
      visibleState = freezeVisibleState({
        label: 'canceled', tone: 'neutral', progress: determinateProgress(progress.percent),
        primaryAction: 'retry', availableActions: ['retry'], terminal: true,
      })
      break
  }
  return Object.freeze({
    batch: visibleState,
    items: Object.freeze(batch.items.map((item) => Object.freeze({
      itemId: item.id,
      visibleState: presentValidatedBatchItemVisibleState(item),
    }))),
  })
}

export function presentCommandArtifactInvalidationVisibleState(
  input: Readonly<CommandArtifactInvalidationV1>,
): Readonly<VisibleState> {
  parseCommandArtifactInvalidation(input)
  return freezeVisibleState({
    label: 'stale-output',
    tone: 'warning',
    progress: { mode: 'none' },
    primaryAction: 'rebuild-output',
    availableActions: ['rebuild-output', 'open-historical-output'],
    terminal: false,
  })
}

export function presentMediaArtifactVisibleState(
  status: MediaArtifactLifecycleStatus,
): Readonly<VisibleState> {
  assertDomain(
    MEDIA_ARTIFACT_LIFECYCLE_STATUSES.includes(status),
    'INVALID_MEDIA_ARTIFACT',
    'Media artifact lifecycle status is invalid',
    { status },
  )
  switch (status) {
    case 'available':
      return freezeVisibleState({
        label: 'available', tone: 'success', progress: { mode: 'none' },
        primaryAction: 'open-result', availableActions: ['open-result'], terminal: true,
      })
    case 'quarantined':
      return freezeVisibleState({
        label: 'quarantined', tone: 'warning', progress: { mode: 'none' },
        primaryAction: 'inspect-error', availableActions: ['inspect-error'], terminal: false,
      })
    case 'deleted':
      return freezeVisibleState({
        label: 'deleted', tone: 'neutral', progress: { mode: 'none' },
        primaryAction: 'inspect-history', availableActions: ['inspect-history'], terminal: true,
      })
  }
}

export function presentProjectVisibleState(
  status: ProjectStatus,
): Readonly<VisibleState> {
  assertDomain(
    PROJECT_STATUSES.includes(status),
    'INVALID_PROJECT',
    'Project status is invalid',
    { status },
  )
  switch (status) {
    case 'draft':
      return freezeVisibleState({
        label: 'draft', tone: 'neutral',
        progress: { mode: 'not-started', percent: 0 },
        primaryAction: 'open-result', availableActions: ['open-result'], terminal: false,
      })
    case 'ingesting':
    case 'perceiving':
    case 'planning':
    case 'generating':
    case 'rendering-proxy':
    case 'revising':
    case 'rendering-final':
      return freezeVisibleState({
        label: status, tone: 'info', progress: { mode: 'indeterminate' },
        primaryAction: 'view-progress', availableActions: ['view-progress'], terminal: false,
      })
    case 'reviewing-assets':
    case 'reviewing-proxy':
      return freezeVisibleState({
        label: status, tone: 'warning', progress: { mode: 'none' },
        primaryAction: 'review-output', availableActions: ['review-output'], terminal: false,
      })
    case 'completed':
      return freezeVisibleState({
        label: 'completed', tone: 'success', progress: { mode: 'complete', percent: 100 },
        primaryAction: 'open-result', availableActions: ['open-result'], terminal: true,
      })
    case 'failed':
      return freezeVisibleState({
        label: 'failed', tone: 'danger', progress: { mode: 'none' },
        primaryAction: 'inspect-error', availableActions: ['inspect-error'], terminal: true,
      })
    case 'canceled':
      return freezeVisibleState({
        label: 'canceled', tone: 'neutral', progress: { mode: 'none' },
        primaryAction: 'inspect-history', availableActions: ['inspect-history'], terminal: true,
      })
    case 'archived':
      return freezeVisibleState({
        label: 'archived', tone: 'neutral', progress: { mode: 'none' },
        primaryAction: 'inspect-history', availableActions: ['inspect-history'], terminal: true,
      })
  }
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
