import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'))
const patched = '16.4.0'
const forkVersion = '16.3.6-apollo.2'
const forkTarball = 'tools/vendor/next-eslint-plugin-next-16.3.6-apollo.2.tgz'
// Current audit findings GHSA-3w37-wq28-93x7 and GHSA-4jqv-mc3x-m676,
// GHSA-39w2-rjm5-chcv, GHSA-f87g-xv8r-7p7x, GHSA-mcj8-r9mp-w47p,
// GHSA-cjq9-62q9-8jv4 report 16.3.x through 16.3.7 as affected. This checks
// the current 16.3 advisory range and the exact 16.4.0 pin, not exploitation
// or arbitrary historical Next versions. The vendor fork is versioned apart.
const parts = (version) => version.split('.').map(Number)
const compare = (left, right) => {
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
const affectedIn16_3 = (version) => compare(version, '16.3.0') >= 0 && compare(version, '16.3.7') <= 0

test('Next 16.3.7 is in the current advisory range; patched baseline is outside', () => {
  assert.equal(affectedIn16_3('16.3.0'), true)
  assert.equal(affectedIn16_3('16.3.7'), true)
  assert.equal(affectedIn16_3(patched), false)
})

test('platform and paired Next/eslint-config-next manifests use the patched exact pin', () => {
  const pkg = readJson('package.json')
  const versions = readJson('config/platform-versions.json')
  assert.equal(versions.web.next, patched)
  assert.equal(pkg.dependencies.next, patched)
  assert.equal(pkg.devDependencies['eslint-config-next'], patched)
  assert.equal(affectedIn16_3(pkg.dependencies.next), false)
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
