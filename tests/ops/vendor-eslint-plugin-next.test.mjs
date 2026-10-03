import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { getRootDirs } = require('../../node_modules/@next/eslint-plugin-next/dist/utils/get-root-dirs.js')
const vendorRoot = new URL('../../tools/vendor/eslint-plugin-next/', import.meta.url)

test('all vendored rules and ESLint configurations retain official upstream bytes', () => {
  const upstream = JSON.parse(readFileSync(new URL('UPSTREAM_SHA256.json', vendorRoot), 'utf8'))
  const unchanged = Object.entries(upstream).filter(([file]) => file !== 'package.json' && file !== 'dist/utils/get-root-dirs.js')
  assert.equal(Object.keys(upstream).length, 56)
  assert.equal(unchanged.length, 54)
  for (const [file, expected] of unchanged) {
    const actual = createHash('sha256').update(readFileSync(new URL(file, vendorRoot))).digest('hex')
    assert.equal(actual, expected, `${file} differs from upstream`)
  }
})

test('packed dependency contains the same vendored package bytes', () => {
  const unpack = mkdtempSync(path.join(tmpdir(), 'apollo-next-plugin-pack-'))
  try {
    const tarball = new URL('../../tools/vendor/next-eslint-plugin-next-16.3.6-apollo.1.tgz', import.meta.url)
    execFileSync('tar', ['-xzf', '-'], {
      cwd: unpack,
      input: readFileSync(tarball),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    const files = Object.keys(JSON.parse(readFileSync(new URL('UPSTREAM_SHA256.json', vendorRoot), 'utf8')))
    for (const file of files) {
      assert.deepEqual(
        readFileSync(path.join(unpack, 'package', file)),
        readFileSync(new URL(file, vendorRoot)),
        `${file} in tarball differs from vendored source`,
      )
    }
  } finally {
    rmSync(unpack, { recursive: true, force: true })
  }
})

test('vendored Next root dirs keep string, array, wildcard and directory-only behavior', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'apollo-next-roots-'))
  const previous = process.cwd()
  try {
    mkdirSync(path.join(fixture, 'apps', 'web', 'nested'), { recursive: true })
    mkdirSync(path.join(fixture, 'apps', 'api'), { recursive: true })
    writeFileSync(path.join(fixture, 'apps', 'notes.txt'), 'not a directory')
    process.chdir(fixture)
    const roots = (rootDir) => getRootDirs({ cwd: fixture, settings: { next: { rootDir } } })

    assert.deepEqual(getRootDirs({ cwd: fixture, settings: {} }), [fixture])
    assert.deepEqual(roots('apps/web'), ['apps/web'])
    assert.deepEqual(new Set(roots('apps/*')), new Set(['apps/api', 'apps/web']))
    assert.deepEqual(new Set(roots(['apps/web', 'apps/api'])), new Set(['apps/web', 'apps/api']))
    assert.deepEqual(roots('apps/missing*'), [])
    assert.deepEqual(roots('apps\\web'), ['apps/web'])
    assert.ok(!roots('apps/*').includes('apps/notes.txt'))
    assert.ok(!roots('apps/*').includes('apps/web/nested'))

    try {
      symlinkSync(path.join(fixture, 'apps', 'web'), path.join(fixture, 'apps', 'web-link'), 'dir')
      const linked = roots('apps/web-link')
      assert.deepEqual(linked, ['apps/web-link'])
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    }
  } finally {
    process.chdir(previous)
    rmSync(fixture, { recursive: true, force: true })
  }
})
