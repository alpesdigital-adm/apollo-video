import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPublicContractSnapshot,
  findBreakingContractChanges,
} from '../../src/v2/public-api/contract-snapshot.ts'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

test('current public contract is compatible with itself', () => {
  const snapshot = createPublicContractSnapshot()
  assert.deepEqual(findBreakingContractChanges(snapshot, snapshot), [])
})

test('new capabilities and schemas are additive', () => {
  const baseline = createPublicContractSnapshot()
  const current = clone(baseline)
  current.capabilities['apollo.future.read'] = { version: '1.0.0' }
  current.schemas['apollo://schemas/future/v1'] = { type: 'object' }

  assert.deepEqual(findBreakingContractChanges(baseline, current), [])
})

test('removed capabilities and changed same-version schemas are breaking', () => {
  const baseline = createPublicContractSnapshot()
  const current = clone(baseline)
  delete current.capabilities['apollo.health.read']
  current.schemas['apollo://schemas/create-project-request/v1'].required = []

  assert.deepEqual(findBreakingContractChanges(baseline, current), [
    'capability removed: apollo.health.read',
    'schema changed without a new ref: apollo://schemas/create-project-request/v1',
  ])
})
