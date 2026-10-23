import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The render check holds no phrase of its own: what must be absent comes from the request of the video being checked.
const script = fileURLToPath(new URL('../../scripts/verify-recovery-render.mjs', import.meta.url))
const run = (...args) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], { encoding: 'utf8' })
const workDir = mkdtempSync(join(tmpdir(), 'verify-recovery-render-'))
const json = (name, value) => { const path = join(workDir, name); writeFileSync(path, JSON.stringify(value)); return path }

test('without --forbidden-phrases the script is a usage error, not a check against a built-in list', () => {
  const result = run('render.wav')
  assert.equal(result.status, 64)
  assert.match(result.stderr, /Missing --forbidden-phrases/)
  assert.match(result.stderr, /Usage: verify-recovery-render/)
})

test('an unreadable, empty or malformed phrase list is a usage error', () => {
  assert.equal(run('render.wav', '--forbidden-phrases', join(workDir, 'missing.json')).status, 64)
  assert.equal(run('render.wav', '--forbidden-phrases', json('empty.json', [])).status, 64)
  assert.equal(run('render.wav', '--forbidden-phrases', json('numbers.json', [1, 2])).status, 64)
  assert.equal(run('render.wav', '--forbidden-phrases', json('blank.json', ['  '])).status, 64)
  assert.equal(run('render.wav', '--forbidden-phrases', json('ok.json', ['frase pedida']), '--seam-seconds', json('seams.json', ['x'])).status, 64)
})

test('a missing audio path is a usage error', () => {
  const result = run('--forbidden-phrases', json('phrases.json', ['frase pedida']))
  assert.equal(result.status, 64)
  assert.match(result.stderr, /Missing <audio-path>/)
})
