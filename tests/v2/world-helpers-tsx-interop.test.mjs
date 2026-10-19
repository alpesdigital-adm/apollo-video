import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

// The world helpers are imported by journeys that run under `tsx`. In this typeless package tsx loads a STATICALLY imported
// .ts module through CJS interop, where Node's export lexer sees none (or only some) of its named exports, so a helper
// that says `import { x } from '../../../src/...ts'` fails there with "does not provide an export named x" while the same
// file loads under native type stripping. The helpers therefore import every .ts module dynamically. This pins both halves.
const root = fileURLToPath(new URL('../../', import.meta.url))
const helpers = ['operational-editorial-fixture', 'output-world', 'pg-output-world', 'perception-producer-pg-world', 'explicit-project-http']

test('the world helpers import their TypeScript modules dynamically', () => {
  for (const name of ['operational-editorial-fixture', 'output-world', 'pg-output-world']) {
    const text = readFileSync(new URL(`./helpers/${name}.mjs`, import.meta.url), 'utf8')
    const staticTs = [...text.matchAll(/^import\s[^;\n]*from\s+'([^']+\.ts)'/gm)].map((match) => match[1])
    assert.deepEqual(staticTs, [], `${name}.mjs statically imports ${staticTs.join(', ')}`)
  }
})

test('the world helpers load under tsx exactly as they load natively', () => {
  const urls = helpers.map((name) => pathToFileURL(fileURLToPath(new URL(`./helpers/${name}.mjs`, import.meta.url))).href)
  const script = `for (const url of ${JSON.stringify(urls)}) await import(url); console.log('loaded')`
  const run = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'node_modules/tsx/dist/cli.mjs', '--input-type=module', '-e', script],
    { cwd: root, encoding: 'utf8', timeout: 120_000 })
  assert.equal(run.status, 0, `${run.stderr}`.slice(-800))
  assert.match(run.stdout, /loaded/)
})
