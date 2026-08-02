import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { listProjectsService } from '../../src/v2/application/list-projects.ts'
import { PROJECT_STATUSES } from '../../src/v2/domain/project.ts'
import { presentProjectVisibleState } from '../../src/v2/domain/visible-state.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { presentProjectV2 } from '../../src/v2/public-api/presenters.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

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

test('T-FR-236 projects every persisted project phase into a fail-closed public visible state', () => {
  const states = new Map(PROJECT_STATUSES.map((status) => [
    status,
    presentProjectVisibleState(status),
  ]))

  assert.equal(states.size, 14)
  for (const [status, visibleState] of states) {
    assert.equal(visibleState.label, status)
    assert.equal(Object.isFrozen(visibleState), true)
    assert.equal(Object.isFrozen(visibleState.progress), true)
    assert.equal(Object.isFrozen(visibleState.availableActions), true)
  }
  assert.deepEqual(states.get('draft').progress, { mode: 'not-started', percent: 0 })
  assert.equal(states.get('rendering-proxy').primaryAction, 'view-progress')
  assert.equal(states.get('reviewing-proxy').primaryAction, 'review-output')
  assert.deepEqual(states.get('completed').progress, { mode: 'complete', percent: 100 })
  assert.equal(states.get('completed').terminal, true)
  assert.equal(states.get('failed').primaryAction, 'inspect-error')
  assert.equal(states.get('canceled').primaryAction, 'inspect-history')
  assert.equal(states.get('archived').primaryAction, 'inspect-history')
  assert.throws(() => presentProjectVisibleState('invented-phase'), /status is invalid/)

  const publicProject = presentProjectV2({
    id: 'project-visible-1', workspaceId: 'workspace-projects-1',
    name: 'Visible project', status: 'draft', objective: 'discovery', format: '9:16',
    locale: 'pt-BR', ownerId: 'client-projects-1', currentVersionId: 'version-visible-1',
    createdAt: '2026-08-01T12:00:00.000Z',
  })
  assert.equal(publicProject.visibleState.label, 'draft')

  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
  assert.equal(capabilities.get('apollo.projects.list').version, '2.0.0')
  assert.equal(capabilities.get('apollo.projects.list').outputSchemaRef, 'apollo://schemas/project-list/v4')
  assert.equal(capabilities.get('apollo.projects.create').version, '3.0.0')
  assert.equal(capabilities.get('apollo.projects.create').outputSchemaRef, 'apollo://schemas/project-created/v3')
  assert.equal(getPublicSchema('apollo://schemas/project-list/v3').ref, 'apollo://schemas/project-list/v3')
  assert.equal(getPublicSchema('apollo://schemas/project-created/v2').ref, 'apollo://schemas/project-created/v2')

  const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    .compile(getPublicSchema('apollo://schemas/project-list/v4').schema)
  const validBody = { data: { projects: [publicProject] }, meta: { apiVersion: 'v1' } }
  assert.equal(validate(validBody), true, JSON.stringify(validate.errors))
  const mismatched = structuredClone(validBody)
  mismatched.data.projects[0].visibleState.label = 'completed'
  assert.equal(validate(mismatched), false)
  const invalidAction = structuredClone(validBody)
  invalidAction.data.projects[0].visibleState.primaryAction = 'inspect-error'
  assert.equal(validate(invalidAction), false)
})
