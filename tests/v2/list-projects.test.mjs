import assert from 'node:assert/strict'
import test from 'node:test'

import { listProjectsService } from '../../src/v2/application/list-projects.ts'

function project(id, createdAt) {
  return { id, workspaceId: 'workspace-projects-1', name: id, status: 'draft', createdAt }
}

test('project listing emits an opaque stable cursor and binds it to the workspace', async () => {
  const records = [
    project('project-003', '2026-07-16T03:00:00.000Z'),
    project('project-002', '2026-07-16T02:00:00.000Z'),
    project('project-001', '2026-07-16T01:00:00.000Z'),
  ]
  const requests = []
  const list = listProjectsService({
    projects: {
      async listByWorkspace(input) {
        requests.push(input)
        return input.after ? [records[2]] : records
      },
    },
  })
  const first = await list({ workspaceId: 'workspace-projects-1', limit: 2 })
  assert.deepEqual(first.projects.map(({ id }) => id), ['project-003', 'project-002'])
  assert.ok(first.nextCursor)
  const second = await list({ workspaceId: 'workspace-projects-1', limit: 2, after: first.nextCursor })
  assert.deepEqual(second.projects.map(({ id }) => id), ['project-001'])
  assert.deepEqual(requests[1].after, { createdAt: records[1].createdAt, id: records[1].id })
  await assert.rejects(
    () => list({ workspaceId: 'workspace-projects-2', after: first.nextCursor }),
    /does not match this project query/,
  )
})
