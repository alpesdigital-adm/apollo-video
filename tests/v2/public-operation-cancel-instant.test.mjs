import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advancePublicOperationPhase,
  cancelPublicOperation,
  cancellationInstant,
  createQueuedPublicOperation,
  startPublicOperationAttempt,
} from '../../src/v2/domain/public-operation.ts'

/**
 * A cancel stamps the instant it was requested before it opens its transaction. A worker heartbeat that commits in between carries a later
 * `updatedAt`; the CI run that failed `proxy-render-cancel-running` was refused with "transition cannot move time backwards" for exactly that,
 * while the render was healthy. The repository now records the cancel no earlier than the row it supersedes; the domain transition is unchanged.
 */
const running = () => advancePublicOperationPhase(startPublicOperationAttempt(createQueuedPublicOperation({
  id: 'operation-cancel-instant-1', workspaceId: 'workspace-cancel-instant', projectId: 'project-cancel-instant', clientId: 'client-cancel-instant',
  type: 'project-proxy-render', target: { type: 'media-artifact', id: 'artifact-cancel-instant', manifestId: 'manifest-cancel-instant' }, createdAt: '2026-10-23T10:00:00.000Z',
}), '2026-10-23T10:00:01.000Z'), 'rendering', '2026-10-23T10:00:02.000Z')

test('the domain still refuses a cancellation that moves time backwards', () => {
  assert.throws(() => cancelPublicOperation(running(), '2026-10-23T10:00:01.500Z'), /cannot move time backwards/)
})

test('a request stamped before a later heartbeat is recorded at that heartbeat, and a later request keeps its own instant', () => {
  const operation = running()
  assert.equal(cancellationInstant(operation, '2026-10-23T10:00:01.900Z'), '2026-10-23T10:00:02.000Z')
  assert.equal(cancellationInstant(operation, '2026-10-23T10:00:02.000Z'), '2026-10-23T10:00:02.000Z')
  assert.equal(cancellationInstant(operation, '2026-10-23T10:00:02.250Z'), '2026-10-23T10:00:02.250Z')
  const canceled = cancelPublicOperation(operation, cancellationInstant(operation, '2026-10-23T10:00:01.900Z'))
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.updatedAt, '2026-10-23T10:00:02.000Z')
})

test('an invalid request instant is still refused', () => {
  assert.throws(() => cancellationInstant(running(), 'not-a-date'))
})
