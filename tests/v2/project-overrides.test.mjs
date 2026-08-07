import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROJECT_OVERRIDE_ELEMENTS,
  normalizeProjectOverrides,
  projectOverridePolicySnapshot,
  resolveProjectOverrides,
} from '../../src/v2/domain/project-overrides.ts'

const logo = Object.freeze({
  assetId: 'asset-logo-workspace-1',
  checksum: 'a'.repeat(64),
  rightsId: 'rights-logo-workspace-1',
})

test('F1.010 project can disable logo and handles without mutating workspace values', () => {
  const workspace = Object.freeze({
    logo,
    instagramHandle: '@apollo',
    youtubeHandle: '@apollo-video',
    subtitleStyle: 'kinetic',
  })
  const resolved = resolveProjectOverrides(workspace, {
    logo: { mode: 'none' },
    instagramHandle: { mode: 'none' },
    subtitleStyle: { mode: 'custom', value: 'caps-stroke' },
  })
  assert.deepEqual(resolved.logo, { value: null, origin: 'project-none' })
  assert.deepEqual(resolved.instagramHandle, { value: null, origin: 'project-none' })
  assert.deepEqual(resolved.youtubeHandle, { value: '@apollo-video', origin: 'workspace' })
  assert.deepEqual(resolved.subtitleStyle, { value: 'caps-stroke', origin: 'project-custom' })
  assert.deepEqual(workspace.logo, logo)
  assert.equal(Object.isFrozen(workspace), true)
  assert.equal(Object.isFrozen(resolved), true)
})

test('F1.010 normalization materializes all ten allowlisted elements as inherit', () => {
  const overrides = normalizeProjectOverrides({})
  assert.deepEqual(Object.keys(overrides).toSorted(), [...PROJECT_OVERRIDE_ELEMENTS].toSorted())
  for (const element of PROJECT_OVERRIDE_ELEMENTS) {
    assert.deepEqual(overrides[element], { mode: 'inherit' })
    assert.equal(Object.isFrozen(overrides[element]), true)
  }
})

test('F1.010 every custom element validates its own typed value', () => {
  const overrides = normalizeProjectOverrides({
    logo: { mode: 'custom', value: logo },
    instagramHandle: { mode: 'custom', value: '@apollo.pro' },
    youtubeHandle: { mode: 'custom', value: '@apollo-video' },
    professionalName: { mode: 'custom', value: 'Apollo Creator' },
    companyName: { mode: 'custom', value: 'Apollo Studio' },
    intro: { mode: 'custom', value: { assetId: 'asset-intro-1', checksum: 'b'.repeat(64), rightsId: 'rights-intro-1' } },
    colors: { mode: 'custom', value: ['#d9ad44', '#070707'] },
    guardrails: { mode: 'custom', value: [] },
    subtitleStyle: { mode: 'custom', value: 'clean-color' },
    gradePreset: { mode: 'custom', value: 'cinema' },
  })
  assert.equal(overrides.logo.mode, 'custom')
  assert.deepEqual(overrides.colors.value, ['#d9ad44', '#070707'])
  assert.deepEqual(overrides.guardrails.value, [])
})

test('F1.010 unknown keys, modes, hidden values and malformed typed values fail closed', () => {
  const invalid = [
    { watermark: { mode: 'none' } },
    { logo: { mode: 'automatic' } },
    { logo: { mode: 'none', value: logo } },
    { logo: { mode: 'custom', value: '/brand/logo.png' } },
    { instagramHandle: { mode: 'custom', value: 'apollo' } },
    { colors: { mode: 'custom', value: ['red'] } },
    { colors: { mode: 'custom', value: ['#ffffff', '#ffffff'] } },
    { subtitleStyle: { mode: 'custom', value: 'unknown' } },
    { gradePreset: { mode: 'custom', value: 'vintage' } },
    { companyName: { mode: 'custom', value: '' } },
  ]
  for (const value of invalid) assert.throws(() => normalizeProjectOverrides(value))
  assert.throws(() => normalizeProjectOverrides(null))
  assert.throws(() => normalizeProjectOverrides([]))
})

test('F1.010 overrides persist with resolved origin in a version-bound Policy Snapshot', () => {
  const snapshot = projectOverridePolicySnapshot({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    projectVersionId: 'version-7',
    commandId: 'command-policy-1',
    workspaceDefaults: { guardrails: ['Não usar zoom automático.'] },
    overrides: { guardrails: { mode: 'custom', value: ['Não usar logo.'] } },
    createdAt: '2026-08-07T12:00:00.000Z',
  })
  const content = JSON.parse(snapshot.contentJson)
  assert.equal(content.schemaVersion, 2)
  assert.equal(content.projectVersionId, 'version-7')
  assert.equal(content.commandId, 'command-policy-1')
  assert.deepEqual(content.resolved.guardrails, { value: ['Não usar logo.'], origin: 'project-custom' })
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
})
