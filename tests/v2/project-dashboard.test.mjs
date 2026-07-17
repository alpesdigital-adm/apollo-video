import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDashboardProject } from '../../src/v2/domain/project-dashboard.ts'

test('dashboard derives every project state and recommended action', () => {
  assert.equal(deriveDashboardProject({ status: 'created' }).state, 'draft')
  assert.equal(deriveDashboardProject({ status: 'analyzing' }).state, 'processing')
  assert.equal(deriveDashboardProject({ status: 'ready' }).action, 'Revisar edição')
  assert.equal(deriveDashboardProject({ status: 'error' }).action, 'Tentar novamente')
  assert.equal(deriveDashboardProject({ status: 'complete' }).state, 'completed')
  assert.equal(deriveDashboardProject({ status: 'complete', archivedAt: '2026-07-17T00:00:00Z' }).state, 'archived')
})

test('dashboard never fabricates progress without a measured total', () => {
  assert.equal(deriveDashboardProject({ status: 'analyzing' }).progress, null)
  assert.equal(deriveDashboardProject({ status: 'rendering', completed: 2, total: null }).progress, null)
  assert.equal(deriveDashboardProject({ status: 'rendering', completed: 2, total: 4 }).progress, 50)
})
