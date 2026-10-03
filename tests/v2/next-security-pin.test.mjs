import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'))
const patched = '16.3.6'
const forkVersion = '16.3.6-apollo.2'
const forkTarball = 'tools/vendor/next-eslint-plugin-next-16.3.6-apollo.2.tgz'
// GHSA-vcvr-r3jv-pc5j: affected >=16.2.0 <16.3.6; this is a pin check, not an exploit test.
const parts = (version) => version.split('.').map(Number)
const compare = (left, right) => {
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
const affected = (version) => compare(version, '16.2.0') >= 0 && compare(version, patched) < 0

test('old Next pin is in GHSA-vcvr-r3jv-pc5j range; patched baseline is outside', () => {
  assert.equal(affected('16.3.4'), true)
  assert.equal(affected('16.3.6'), false)
  assert.equal(affected('16.2.0'), true)
  assert.equal(affected('16.1.9'), false)
})

test('platform and paired Next/eslint-config-next manifests use the patched exact pin', () => {
  const pkg = readJson('package.json')
  const versions = readJson('config/platform-versions.json')
  assert.equal(versions.web.next, patched)
  assert.equal(pkg.dependencies.next, patched)
  assert.equal(pkg.devDependencies['eslint-config-next'], patched)
  assert.equal(affected(pkg.dependencies.next), false)
})

test('npm lock root and resolved Next/eslint-config-next use patched pair', () => {
  const lock = readJson('package-lock.json')
  assert.equal(lock.packages[''].dependencies.next, patched)
  assert.equal(lock.packages[''].devDependencies['eslint-config-next'], patched)
  assert.equal(lock.packages['node_modules/next'].version, patched)
  assert.equal(lock.packages['node_modules/eslint-config-next'].version, patched)
  assert.equal(lock.packages['node_modules/@next/env'].version, patched)
  const fork = lock.packages['node_modules/@next/eslint-plugin-next']
  assert.equal(fork.version, forkVersion)
  assert.equal(fork.resolved, `file:${forkTarball}`)
  const bytes = readFileSync(new URL(`../../${forkTarball}`, import.meta.url))
  assert.equal(fork.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`)
  assert.equal(readJson('tools/vendor/eslint-plugin-next/package.json').version, forkVersion)
  const upstream = readJson('tools/vendor/eslint-plugin-next/UPSTREAM_SHA256.json')
  assert.equal(typeof upstream['dist/index.js'], 'string')
  assert.equal(upstream['package.json'].length, 64)
})

test('installed Next/eslint-config-next packages use patched pair', () => {
  assert.equal(readJson('node_modules/next/package.json').version, patched)
  assert.equal(readJson('node_modules/eslint-config-next/package.json').version, patched)
  assert.equal(readJson('node_modules/@next/eslint-plugin-next/package.json').version, forkVersion)
})
