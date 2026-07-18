import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('T-SEC-API-004 public V1 routes bypass UI Proxy and keep route-level authentication', async () => {
  const source = await readFile(new URL('../../src/proxy.ts', import.meta.url), 'utf8')

  assert.match(source, /matcher:\s*\[\s*['"]\/\(\(\?!v1\|/)
  assert.doesNotMatch(source, /PUBLIC_PREFIXES/)
  assert.match(source, /Public APIs authenticate at the route boundary/)
})
