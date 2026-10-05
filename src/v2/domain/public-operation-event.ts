import {
  createPublicEvent,
  type PublicEvent,
} from './public-event.ts'
import type {
  PublicOperation,
  PublicOperationStatus,
} from './public-operation.ts'

export function createPublicOperationStatusEvents(input: {
  previousStatus?: PublicOperationStatus
  operation: Readonly<Pick<
    PublicOperation,
    | 'id'
    | 'workspaceId'
    | 'projectId'
    | 'clientId'
    | 'type'
    | 'status'
    | 'phase'
    | 'attempt'
    | 'updatedAt'
  >>
  createEventId: () => string
}): readonly Readonly<PublicEvent>[] {
  if (input.previousStatus === input.operation.status) {
    return Object.freeze([])
  }
  const common = {
    workspaceId: input.operation.workspaceId,
    occurredAt: input.operation.updatedAt,
    actor: { clientId: input.operation.clientId },
    resource: { type: 'operation', id: input.operation.id },
  } as const
  const data = {
    operationType: input.operation.type,
    previousStatus: input.previousStatus ?? null,
    status: input.operation.status,
    phase: input.operation.phase,
    attempt: input.operation.attempt,
    ...(input.operation.projectId
      ? { projectId: input.operation.projectId }
      : {}),
  }
  const events: Readonly<PublicEvent>[] = [createPublicEvent({
    ...common,
    id: input.createEventId(),
    type: 'operation.status.changed',
    version: '1.0.0',
    data,
  })]
  if (input.operation.status === 'succeeded') {
    events.push(createPublicEvent({
      ...common,
      id: input.createEventId(),
      type: 'operation.succeeded',
      version: '1.0.0',
      data,
    }))
  } else if (input.operation.status === 'failed') {
    events.push(createPublicEvent({
      ...common,
      id: input.createEventId(),
      type: 'operation.failed',
      version: '1.0.0',
      data,
    }))
  }
  return Object.freeze(events)
}

/** A refetch signal from persisted worker state, never an inferred percentage. */
export function createPublicOperationProgressEvents(input: {
  previous: Readonly<PublicOperation>
  operation: Readonly<PublicOperation>
  createEventId: () => string
}): readonly Readonly<PublicEvent>[] {
  const { previous, operation } = input
  if (previous.phase === operation.phase &&
      previous.progress?.completed === operation.progress?.completed &&
      previous.progress?.total === operation.progress?.total &&
      previous.progress?.unit === operation.progress?.unit) return Object.freeze([])
  return Object.freeze([createPublicEvent({
    id: input.createEventId(),
    type: 'operation.progress.changed',
    version: '1.0.0',
    workspaceId: operation.workspaceId,
    occurredAt: operation.updatedAt,
    actor: { clientId: operation.clientId },
    resource: { type: 'operation', id: operation.id },
    data: {
      operationType: operation.type,
      status: operation.status,
      phase: operation.phase,
      previousPhase: previous.phase,
      attempt: operation.attempt,
      ...(operation.projectId ? { projectId: operation.projectId } : {}),
      ...(operation.progress ? { progress: { ...operation.progress } } : {}),
    },
  })])
}
