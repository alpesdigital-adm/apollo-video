import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const rootRequire = createRequire(resolve(root, 'package.json'))
const remotionRequire = createRequire(resolve(root, 'remotion/package.json'))

for (const [scope, requireFromManifest] of [['root', rootRequire], ['remotion', remotionRequire]]) {
  test(`fast-uri ${scope} parses a scheme-relative percent-encoded hostname case-insensitively`, () => {
    const { parse } = requireFromManifest('fast-uri')
    assert.equal(parse('//%41.com').host, 'a.com')
    assert.equal(parse('//A.com').host, 'a.com')
  })

  test(`fast-uri ${scope} equates a scheme-relative percent-encoded hostname`, () => {
    const { equal } = requireFromManifest('fast-uri')
    assert.equal(equal('//%41.com', '//a.com'), true)
  })
}

const braceConsumers = [
  ['minimatch 3 (brace-expansion 1.x)', createRequire(rootRequire.resolve('minimatch/package.json'))],
  ['typescript-estree/minimatch 10 (brace-expansion 5.x)', createRequire(rootRequire.resolve('@typescript-eslint/typescript-estree/package.json'))],
]

for (const [consumer, requireFromConsumer] of braceConsumers) {
  test(`${consumer} expands deeply nested braces without stack exhaustion`, () => {
    const entry = requireFromConsumer.resolve('brace-expansion')
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `
      const assert = require('node:assert/strict')
      const moduleExports = require(process.argv[1])
      const expand = typeof moduleExports === 'function' ? moduleExports : moduleExports.expand
      assert.deepEqual(expand('{a,b}'), ['a', 'b'])
      const result = expand('{'.repeat(3200) + 'a,b' + '}'.repeat(3200))
      assert.ok(Array.isArray(result))
    `, entry], { timeout: 4_000, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true })
    assert.equal(child.error, undefined, `${consumer}: ${child.error?.message}`)
    assert.equal(child.status, 0, `${consumer}: ${child.stderr}`)
  })
}
