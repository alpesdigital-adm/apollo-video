import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  RESOURCE_BUDGET_APPROVAL_SCHEMA_VERSION,
  cgroupEnforcementIssues,
  dockerRunLimitArguments,
  parseMemory,
  readbackMismatches,
  resolveResourceBudget,
} from '../../src/v2/infrastructure/resource-budget/resource-budget.ts'

const root = resolve(import.meta.dirname, '..', '..')
const catalog = JSON.parse(await readFile(resolve(root, 'config/resource-budget.json'), 'utf8'))
const GIB = 1024 ** 3
const MIB = 1024 ** 2

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function approvedBudget(overrides = {}) {
  const base = {
    schemaVersion: RESOURCE_BUDGET_APPROVAL_SCHEMA_VERSION,
    profile: 'digitalocean-production',
    approvedBy: 'owner',
    approvedAtIso: '2026-09-18T20:00:00.000Z',
    host: { cpus: 4, memory: '16g' },
    envelope: { cpus: 3, memory: '8g', pids: 4096 },
    containers: clone(catalog.profiles['isolated-ci'].containers),
    auxiliaries: clone(catalog.profiles['isolated-ci'].auxiliaries),
  }
  return { ...base, ...overrides }
}

test('T-W23-C parseMemory accepts the Docker syntax the deploy accepts and nothing looser', () => {
  assert.equal(parseMemory('768m'), 768 * MIB)
  assert.equal(parseMemory('2g'), 2 * GIB)
  assert.equal(parseMemory('512k'), 512 * 1024)
  assert.equal(parseMemory(1024), 1024)
  assert.equal(parseMemory('1024'), 1024)
  for (const rejected of ['0m', '-1g', '1.5g', 'unlimited', '', ' ', null, undefined, Number.NaN, -1, 0, 1.5, '1t']) {
    assert.equal(parseMemory(rejected), null, `expected ${JSON.stringify(rejected)} to be rejected`)
  }
})

test('T-W23-C the isolated-ci profile resolves with the localization worker excluded until its feature is enabled', () => {
  const resolution = resolveResourceBudget({ catalog, profile: 'isolated-ci', enabledFeatures: { localization: false } })
  assert.equal(resolution.ok, true)
  assert.equal(resolution.host.cpus, 4)
  assert.equal(resolution.envelope.cpus, 3)
  const enabled = resolution.containers.filter((container) => container.enabled).map((container) => container.role)
  assert.equal(enabled.includes('localization-translation-worker'), false)
  assert.equal(enabled.length, 9)
  const translation = resolution.containers.find((container) => container.role === 'localization-translation-worker')
  assert.deepEqual({ optional: translation.optional, enabled: translation.enabled }, { optional: true, enabled: false })
  // 9 containers + the concurrent monitor + the largest sequential auxiliary.
  assert.equal(resolution.sum.cpus, 2.8)
  assert.equal(resolution.sum.memoryBytes, 5632 * MIB)
  assert.equal(resolution.sum.pids, 1376)
  assert.equal(resolution.headroom.cpus, 0.2)
  assert.deepEqual(resolution.margin, { cpus: 1, memoryBytes: 10 * GIB })
  assert.deepEqual([...resolution.uncoveredHostWork], ['docker-load', 'docker-pull', 'image-decompression', 'image-hash', 'backup'])
  assert.equal(resolution.approval, null)

  const withLocalization = resolveResourceBudget({ catalog, profile: 'isolated-ci', enabledFeatures: { localization: true } })
  assert.equal(withLocalization.ok, true)
  assert.equal(withLocalization.containers.filter((container) => container.enabled).length, 10)
  assert.equal(withLocalization.sum.cpus, 2.9)
  assert.equal(withLocalization.sum.memoryBytes, 5888 * MIB)
})

test('T-W23-C the local-dev profile also fits its envelope with and without localization', () => {
  for (const localization of [false, true]) {
    const resolution = resolveResourceBudget({ catalog, profile: 'local-dev', enabledFeatures: { localization } })
    assert.equal(resolution.ok, true, JSON.stringify(resolution))
    assert.ok(resolution.sum.cpus <= resolution.envelope.cpus)
    assert.ok(resolution.sum.memoryBytes <= resolution.envelope.memoryBytes)
    assert.ok(resolution.sum.pids <= resolution.envelope.pids)
  }
})

test('T-W23-C an optional feature must be declared explicitly; silence is not consent', () => {
  const resolution = resolveResourceBudget({ catalog, profile: 'isolated-ci' })
  assert.equal(resolution.ok, false)
  assert.match(resolution.errors.join('\n'), /enabledFeatures\.localization: must be declared true or false/)
})

test('T-W23-C a quota that is missing, unlimited, NaN, negative or malformed is refused before any mutation', () => {
  const cases = [
    ['missing', (profile) => { delete profile.containers['render-worker'] }, /containers\.render-worker: quota is missing/],
    ['unlimited cpus', (profile) => { profile.containers['render-worker'].cpus = 0 }, /render-worker\.cpus: must be a positive finite number/],
    ['unlimited memory', (profile) => { profile.containers['render-worker'].memory = 'unlimited' }, /render-worker\.memory: must be a positive Docker memory limit/],
    ['nan cpus', (profile) => { profile.containers['render-worker'].cpus = 'NaN' }, /render-worker\.cpus: must be a positive finite number/],
    ['negative pids', (profile) => { profile.containers['render-worker'].pidsLimit = -5 }, /render-worker\.pidsLimit: must be a positive integer/],
    ['fractional pids', (profile) => { profile.containers['render-worker'].pidsLimit = 1.5 }, /render-worker\.pidsLimit: must be a positive integer/],
    ['unknown role', (profile) => { profile.containers['ghost-worker'] = { cpus: 1, memory: '1g', pidsLimit: 1 } }, /containers\.ghost-worker: unknown role/],
    ['missing auxiliary', (profile) => { delete profile.auxiliaries.monitor }, /auxiliaries\.monitor: quota is missing/],
    ['optional role still validated when disabled', (profile) => { profile.containers['localization-translation-worker'].memory = 'lots' }, /localization-translation-worker\.memory/],
  ]
  for (const [label, mutate, pattern] of cases) {
    const mutated = clone(catalog)
    mutate(mutated.profiles['isolated-ci'])
    const resolution = resolveResourceBudget({ catalog: mutated, profile: 'isolated-ci', enabledFeatures: { localization: false } })
    assert.equal(resolution.ok, false, label)
    assert.match(resolution.errors.join('\n'), pattern, label)
  }
})

test('T-W23-C a sum over the envelope is refused even when every individual quota is valid', () => {
  const mutated = clone(catalog)
  mutated.profiles['isolated-ci'].containers['render-worker'].cpus = 1
  const resolution = resolveResourceBudget({ catalog: mutated, profile: 'isolated-ci', enabledFeatures: { localization: false } })
  assert.equal(resolution.ok, false)
  assert.match(resolution.errors.join('\n'), /sum\.cpus: 3\.3 exceeds the envelope of 3 CPUs/)

  const overMemory = clone(catalog)
  overMemory.profiles['isolated-ci'].containers['render-worker'].memory = '2g'
  const memoryResolution = resolveResourceBudget({ catalog: overMemory, profile: 'isolated-ci', enabledFeatures: { localization: false } })
  assert.equal(memoryResolution.ok, false)
  assert.match(memoryResolution.errors.join('\n'), /sum\.memory: \d+ bytes exceeds the envelope/)

  const overHost = clone(catalog)
  overHost.profiles['isolated-ci'].envelope.cpus = 5
  const hostResolution = resolveResourceBudget({ catalog: overHost, profile: 'isolated-ci', enabledFeatures: { localization: false } })
  assert.equal(hostResolution.ok, false)
  assert.match(hostResolution.errors.join('\n'), /envelope\.cpus: 5 exceeds the 4 host CPUs/)
})

test('T-W23-C the digitalocean-production profile has no default and refuses to run without an approved budget', () => {
  const resolution = resolveResourceBudget({ catalog, profile: 'digitalocean-production', enabledFeatures: { localization: false } })
  assert.equal(resolution.ok, false)
  assert.match(resolution.errors.join('\n'), /requires an operator-approved budget document; none was provided/)
  assert.equal(catalog.profiles['digitalocean-production'].containers, undefined)
  assert.equal(catalog.profiles['digitalocean-production'].envelope, undefined)
})

test('T-W23-C an approved digitalocean-production budget must keep the margin for the other services of the host', () => {
  const valid = resolveResourceBudget({
    catalog,
    profile: 'digitalocean-production',
    enabledFeatures: { localization: false },
    approvedBudget: approvedBudget(),
  })
  assert.equal(valid.ok, true, JSON.stringify(valid))
  assert.deepEqual(valid.approval, { approvedBy: 'owner', approvedAtIso: '2026-09-18T20:00:00.000Z' })
  assert.deepEqual(valid.margin, { cpus: 1, memoryBytes: 8 * GIB })

  const noMargin = resolveResourceBudget({
    catalog,
    profile: 'digitalocean-production',
    enabledFeatures: { localization: false },
    approvedBudget: approvedBudget({ envelope: { cpus: 4, memory: '8g', pids: 4096 } }),
  })
  assert.equal(noMargin.ok, false)
  assert.match(noMargin.errors.join('\n'), /envelope\.cpus: 4 exceeds 3 \(host 4 CPUs minus the 25% margin/)

  const noReserve = resolveResourceBudget({
    catalog,
    profile: 'digitalocean-production',
    enabledFeatures: { localization: false },
    approvedBudget: approvedBudget({ host: { cpus: 4, memory: '8g' }, envelope: { cpus: 3, memory: '7g', pids: 4096 } }),
  })
  assert.equal(noReserve.ok, false)
  assert.match(noReserve.errors.join('\n'), /envelope\.memory: .* leaves less than the \d+ byte reserve/)

  for (const [label, overrides, pattern] of [
    ['wrong schema', { schemaVersion: 'apollo-resource-budget-approval/v0' }, /approvedBudget\.schemaVersion/],
    ['no approver', { approvedBy: '  ' }, /approvedBudget\.approvedBy/],
    ['bad timestamp', { approvedAtIso: 'yesterday' }, /approvedBudget\.approvedAtIso/],
    ['other profile', { profile: 'isolated-ci' }, /approvedBudget\.profile: must be "digitalocean-production"/],
  ]) {
    const resolution = resolveResourceBudget({
      catalog,
      profile: 'digitalocean-production',
      enabledFeatures: { localization: false },
      approvedBudget: approvedBudget(overrides),
    })
    assert.equal(resolution.ok, false, label)
    assert.match(resolution.errors.join('\n'), pattern, label)
  }
})

test('T-W23-C malformed catalogs are refused, never thrown on', () => {
  for (const [label, broken, pattern] of [
    ['not an object', null, /catalog: must be an object/],
    ['wrong schema', { ...clone(catalog), schemaVersion: 'x' }, /catalog\.schemaVersion/],
    ['unknown profile', clone(catalog), /profiles\.nope: unknown profile/],
  ]) {
    const resolution = resolveResourceBudget({ catalog: broken, profile: 'nope', enabledFeatures: { localization: false } })
    assert.equal(resolution.ok, false, label)
    assert.match(resolution.errors.join('\n'), pattern, label)
  }
  const missingRoles = clone(catalog)
  delete missingRoles.roles
  assert.match(resolveResourceBudget({ catalog: missingRoles, profile: 'isolated-ci' }).errors.join('\n'), /roles: missing/)
})

test('T-W23-C docker arguments carry the exact bytes and forbid swap beyond the memory limit', () => {
  assert.deepEqual(
    [...dockerRunLimitArguments({ cpus: 0.5, memoryBytes: 768 * MIB, pidsLimit: 256 })],
    ['--cpus', '0.5', '--memory', `${768 * MIB}b`, '--memory-swap', `${768 * MIB}b`, '--pids-limit', '256'],
  )
})

test('T-W23-C readback compares what the daemon applied with what was asked', () => {
  const quota = { cpus: 0.5, memoryBytes: 768 * MIB, pidsLimit: 256 }
  assert.deepEqual(
    [...readbackMismatches(quota, { nanoCpus: 500_000_000, memoryBytes: 768 * MIB, memorySwapBytes: 768 * MIB, pidsLimit: 256 })],
    [],
  )
  const mismatches = readbackMismatches(quota, { nanoCpus: 0, memoryBytes: 0, memorySwapBytes: -1, pidsLimit: 0 })
  assert.equal(mismatches.length, 4)
  assert.match(mismatches[0], /NanoCpus: expected 500000000, observed 0/)
  assert.match(mismatches[2], /MemorySwap/)
})

test('T-W23-C cgroup v1 or a daemon without limit support fails closed', () => {
  assert.deepEqual([...cgroupEnforcementIssues({ cgroupVersion: '2', cgroupDriver: 'systemd', warnings: [] })], [])
  assert.deepEqual([...cgroupEnforcementIssues({ cgroupVersion: '2', cgroupDriver: 'cgroupfs', warnings: ['WARNING: bridge-nf-call-iptables is disabled'] })], [])
  const v1 = cgroupEnforcementIssues({ cgroupVersion: '1', cgroupDriver: 'cgroupfs', warnings: [] })
  assert.match(v1.join('\n'), /cgroup version "1" is not supported/)
  const noMemory = cgroupEnforcementIssues({ cgroupVersion: '2', cgroupDriver: 'systemd', warnings: ['WARNING: No memory limit support', 'WARNING: No swap limit support'] })
  assert.equal(noMemory.length, 2)
  const driver = cgroupEnforcementIssues({ cgroupVersion: '2', cgroupDriver: 'none', warnings: [] })
  assert.match(driver.join('\n'), /cgroup driver "none" is not recognised/)
})
