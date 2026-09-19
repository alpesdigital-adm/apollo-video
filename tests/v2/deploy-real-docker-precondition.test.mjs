import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('an explicitly enabled Docker E2E fails when its required daemon cannot be checked', async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), 'apollo-no-docker-'))
  try {
    for (const enabled of ['0', '1']) {
      const environment = { ...process.env, PATH: emptyPath, APOLLO_DEPLOY_DOCKER_E2E: enabled }
      delete environment.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types', '--test', 'tests/v2/deploy-real-docker.e2e.mjs',
      ], {
        cwd: resolve(import.meta.dirname, '../..'),
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      })
      assert.equal(result.error, undefined)
      const output = `${result.stdout}\n${result.stderr}`
      if (enabled === '0') {
        assert.equal(result.status, 0, output)
        assert.match(output, /APOLLO_DEPLOY_DOCKER_E2E is not 1/)
      } else {
        assert.notEqual(result.status, 0, `an enabled gate must not pass by skipping every case:\n${output}`)
        assert.match(output, /Docker E2E was explicitly enabled.*no docker/s)
      }
    }
  } finally {
    await rm(emptyPath, { recursive: true, force: true })
  }
})
