import assert from 'node:assert/strict'
import test from 'node:test'
import { projectOverridePolicySnapshot, resolveProjectOverrides } from '../../src/v2/domain/project-overrides.ts'

test('project can disable logo and handles without mutating workspace values', () => {
  const workspace = Object.freeze({ logo: '/brand/logo.png', instagramHandle: '@apollo', youtubeHandle: '@apollo-video', subtitleStyle: 'kinetic' })
  const resolved = resolveProjectOverrides(workspace, { logo: { mode: 'none' }, instagramHandle: { mode: 'none' }, subtitleStyle: { mode: 'custom', value: 'caps-stroke' } })
  assert.deepEqual(resolved.logo, { value: null, origin: 'project-none' })
  assert.deepEqual(resolved.instagramHandle, { value: null, origin: 'project-none' })
  assert.deepEqual(resolved.youtubeHandle, { value: '@apollo-video', origin: 'workspace' })
  assert.deepEqual(resolved.subtitleStyle, { value: 'caps-stroke', origin: 'project-custom' })
  assert.equal(workspace.logo, '/brand/logo.png')
})

test('overrides persist inside a version-bound Policy Snapshot', () => {
  const snapshot = projectOverridePolicySnapshot({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-7', overrides: { guardrails: { mode: 'custom', value: ['não usar logo'] } } })
  assert.equal(JSON.parse(snapshot.contentJson).projectVersionId, 'version-7')
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
})
