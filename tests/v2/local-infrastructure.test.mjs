import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('T-F0-030 local PostgreSQL and object storage contracts remain isolated and versioned', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-local-infrastructure.mjs'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /PostgreSQL 16 and versioned MinIO are isolated/)
})
