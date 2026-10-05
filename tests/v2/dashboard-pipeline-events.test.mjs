import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createPublicOperationProgressEvents } from '../../src/v2/domain/public-operation-event.ts'
import { createQueuedPublicOperation, startPublicOperationAttempt, advancePublicOperationPhase } from '../../src/v2/domain/public-operation.ts'
import { dashboardFeedEventType, PROJECT_EVENT_FEED_RELEVANT_TYPES } from '../../src/v2/ui/project-event-feed-controller.ts'
import { PROJECT_DASHBOARD_EVENT_TYPES } from '../../src/v2/domain/public-event-feed.ts'

test('W36 worker progress contains only persisted phase/counts and suppresses no-op/heartbeat', () => {
  const queued = createQueuedPublicOperation({ id: 'w36-operation', workspaceId: 'w36-workspace', clientId: 'w36-client',
    projectId: 'w36-project', type: 'project-proxy-render', target: { type: 'media-artifact', id: 'w36-artifact', manifestId: 'w36-manifest' },
    createdAt: '2026-10-05T14:00:00.000Z' })
  const running = startPublicOperationAttempt(queued, '2026-10-05T14:00:01.000Z')
  const next = advancePublicOperationPhase(running, 'rendering', '2026-10-05T14:00:02.000Z')
  assert.deepEqual(createPublicOperationProgressEvents({ previous: running, operation: { ...running, updatedAt: next.updatedAt }, createEventId: randomUUID }), [])
  const [event] = createPublicOperationProgressEvents({ previous: running, operation: next, createEventId: randomUUID })
  assert.equal(event.type, 'operation.progress.changed')
  assert.equal(event.data.phase, next.phase)
  assert.deepEqual(event.data.progress, next.progress)
  assert.equal(event.data.projectId, 'w36-project')
  assert.equal('percentage' in event.data, false)
  assert.equal('error' in event.data, false)
  assert.equal(dashboardFeedEventType(event, 'w36-workspace'), event.type)
})

test('W36 invalidation verifies identity/version/workspace/resource/project and shares feed allowlist', () => {
  assert.deepEqual([...PROJECT_EVENT_FEED_RELEVANT_TYPES], [...PROJECT_DASHBOARD_EVENT_TYPES])
  const event = { id: randomUUID(), type: 'annotation.created', version: '1.0.0', workspaceId: 'w36-workspace',
    resource: { type: 'annotation', id: 'w36-annotation' }, data: { projectId: 'w36-project' } }
  assert.equal(dashboardFeedEventType(event, 'w36-workspace'), event.type)
  for (const bad of [null, { ...event, workspaceId: 'foreign-workspace' }, { ...event, version: '2.0.0' },
    { ...event, id: 'not-a-uuid' }, { ...event, resource: { type: 'operation', id: 'w36-operation' } },
    { ...event, data: {} }, { ...event, data: { projectId: '../project' } }]) {
    assert.equal(dashboardFeedEventType(bad, 'w36-workspace'), null)
  }
})
