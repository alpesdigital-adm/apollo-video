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

test('project listing normalizes combined filters and binds pagination to the exact query', async () => {
  const requests = []
  const list = listProjectsService({ projects: { async listByWorkspace(input) { requests.push(input); return [] } } })
  const result = await list({
    workspaceId: 'workspace-projects-1', text: '  Hook validado  ', status: 'draft',
    objective: 'lead-generation', format: '9:16', locale: 'pt-BR', ownerId: 'owner-001',
    createdFrom: '2026-07-01T00:00:00.000Z', createdTo: '2026-07-31T23:59:59.999Z',
  })
  assert.deepEqual(result, { projects: [] })
  assert.deepEqual(requests[0].filters, {
    text: 'Hook validado', status: 'draft', objective: 'lead-generation', format: '9:16',
    locale: 'pt-BR', createdFrom: '2026-07-01T00:00:00.000Z', createdTo: '2026-07-31T23:59:59.999Z', ownerId: 'owner-001',
  })

  const records = [project('project-003', '2026-07-16T03:00:00.000Z'), project('project-002', '2026-07-16T02:00:00.000Z')]
  const paged = listProjectsService({ projects: { async listByWorkspace() { return records } } })
  const first = await paged({ workspaceId: 'workspace-projects-1', limit: 1, status: 'draft' })
  await assert.rejects(() => paged({ workspaceId: 'workspace-projects-1', limit: 1, status: 'completed', after: first.nextCursor }), /does not match this project query/)
})

test('project listing rejects invalid ranges and unsupported facets before querying storage', async () => {
  const list = listProjectsService({ projects: { async listByWorkspace() { throw new Error('must not query') } } })
  await assert.rejects(() => list({ workspaceId: 'workspace-projects-1', format: '3:2' }), /format is not supported/)
  await assert.rejects(() => list({ workspaceId: 'workspace-projects-1', createdFrom: '2026-08-01', createdTo: '2026-07-01' }), /must not be after/)
})
