import assert from 'node:assert/strict'
import test from 'node:test'

import { optimisticProjectPatch, projectQuickActionsService } from '../../src/v2/application/project-quick-actions.ts'

function repository() {
  const records = new Map([['project-1', { id: 'project-1', workspaceId: 'workspace-1', name: 'Original', status: 'completed', currentVersionId: 'version-1', snapshotRefs: ['snapshot-edit-1', 'snapshot-policy-1'] }]])
  return {
    records,
    async find(workspaceId, id) { const value = records.get(id); return value?.workspaceId === workspaceId ? value : null },
    async rename(workspaceId, id, name) { const value = await this.find(workspaceId, id); const next = { ...value, name }; records.set(id, next); return next },
    async duplicateCopyOnWrite({ workspaceId, projectId, name }) { const source = await this.find(workspaceId, projectId); const next = { ...source, id: 'project-2', name }; records.set(next.id, next); return next },
    async setArchived({ workspaceId, projectId, archived }) { const value = await this.find(workspaceId, projectId); const next = { ...value, status: archived ? 'archived' : 'completed' }; records.set(projectId, next); return next },
  }
}

test('quick actions enforce workspace permissions, confirmation and copy-on-write duplication', async () => {
  const projects = repository()
  const act = projectQuickActionsService({ projects })
  const actor = { workspaceId: 'workspace-1', actorId: 'user-1', permissions: ['projects:read', 'projects:write'], projectId: 'project-1' }
  assert.equal((await act({ ...actor, action: 'review' })).destination, '/project/project-1?mode=review')
  assert.equal((await act({ ...actor, action: 'rename', name: '  Novo nome  ' })).project.name, 'Novo nome')
  const duplicate = (await act({ ...actor, action: 'duplicate' })).project
  assert.notEqual(duplicate.id, 'project-1')
  assert.equal(duplicate.currentVersionId, 'version-1')
  assert.strictEqual(duplicate.snapshotRefs, projects.records.get('project-1').snapshotRefs)
  await assert.rejects(() => act({ ...actor, action: 'archive' }), /explicit confirmation/)
  assert.equal((await act({ ...actor, action: 'archive', confirmed: true })).project.status, 'archived')
  assert.equal((await act({ ...actor, action: 'restore' })).project.status, 'completed')
  await assert.rejects(() => act({ ...actor, workspaceId: 'workspace-2', action: 'open' }), /authenticated workspace/)
  await assert.rejects(() => act({ ...actor, permissions: ['projects:read'], action: 'rename', name: 'Nope' }), /projects:write/)
})

test('optimistic patch exposes exact rollback after a recoverable request failure', () => {
  const before = Object.freeze([{ id: 'project-1', name: 'Original', status: 'completed' }])
  const transaction = optimisticProjectPatch(before, 'project-1', { name: 'Tentativa' })
  assert.equal(transaction.next[0].name, 'Tentativa')
  assert.strictEqual(transaction.rollback(), before)
})
