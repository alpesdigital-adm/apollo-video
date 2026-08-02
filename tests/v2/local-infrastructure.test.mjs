import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('T-F0-030 local PostgreSQL, object storage and supervised runtime contracts remain isolated', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-local-infrastructure.mjs'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /PostgreSQL 16, versioned MinIO and supervised V2 runtime/)
})
