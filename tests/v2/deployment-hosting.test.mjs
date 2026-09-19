import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')

function runGuard(overrides = {}, entrypoint = null) {
  const script = `
    hostname() {
      if [[ "\${1:-}" == '-I' ]]; then
        [[ "\${TEST_ADDRESS_FAILURE:-0}" != 1 ]] || return 1
        printf '%s\\n' "$TEST_HOST_ADDRESSES"
      else
        printf '%s\\n' "$TEST_HOST_NAME"
      fi
    }
    export -f hostname
    # A regression must not touch a real daemon, database or directory.
    for name in docker install sudo pg_dump mv chmod find mkdir rm; do
      eval "$name() { printf 'UNEXPECTED_EFFECT\\\\n'; return 99; }"
      export -f "$name"
    done
    if [[ -n "$TEST_ENTRYPOINT" ]]; then
      source "$TEST_ENTRYPOINT" plan
    else
      source infra/deploy/lib/hosting.sh
      apollo_assert_hosting_policy || exit $?
      printf 'ADMITTED\\n'
      bash -c 'printf "DOCKER_CONTEXT=%s\\nDOCKER_HOST=%s\\n" "\${DOCKER_CONTEXT:-unset}" "\${DOCKER_HOST:-unset}"'
    fi
  `
  return spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      APOLLO_RESOURCE_PROFILE: 'digitalocean-production',
      APOLLO_HOSTING_PROVIDER: 'digitalocean',
      TEST_HOST_NAME: 'apollo-isolated-fixture',
      TEST_HOST_ADDRESSES: '198.51.100.23 10.0.0.4',
      TEST_ENTRYPOINT: entrypoint ?? '',
      ...overrides,
    },
  })
}

test('DigitalOcean hosting declaration admits only the new production profile and isolated local/CI profiles', () => {
  for (const environment of [
    {},
    { APOLLO_RESOURCE_PROFILE: 'isolated-ci', APOLLO_HOSTING_PROVIDER: '' },
    { APOLLO_RESOURCE_PROFILE: 'local-dev', APOLLO_HOSTING_PROVIDER: 'local', TEST_ADDRESS_FAILURE: '1' },
  ]) {
    const result = runGuard(environment)
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.match(result.stdout, /ADMITTED/)
  }
})

test('retired, absent or unknown production/provider configuration fails closed', () => {
  for (const environment of [
    { APOLLO_RESOURCE_PROFILE: 'shared-production' },
    { APOLLO_RESOURCE_PROFILE: '' },
    { APOLLO_RESOURCE_PROFILE: 'unknown' },
    { APOLLO_HOSTING_PROVIDER: '' },
    { APOLLO_HOSTING_PROVIDER: 'hostinger' },
    { APOLLO_RESOURCE_PROFILE: 'local-dev', APOLLO_HOSTING_PROVIDER: 'hostinger' },
    { TEST_ADDRESS_FAILURE: '1' },
    { TEST_HOST_ADDRESSES: '' },
    { DOCKER_HOST: 'ssh://operator@srv1512423.hstgr.cloud' },
    { DOCKER_CONTEXT: 'old-production' },
    { PGHOST: '187.77.245.144' },
  ]) {
    const result = runGuard(environment)
    assert.equal(result.status, 1, result.stderr || result.error?.message)
    assert.doesNotMatch(result.stdout, /ADMITTED|UNEXPECTED_EFFECT/)
  }
})

test('production pins the Docker endpoint for child processes instead of inheriting a saved remote context', () => {
  const result = runGuard()
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stdout, /^DOCKER_CONTEXT=default$/m)
  assert.match(result.stdout, /^DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock$/m)
})

test('the former Hostinger identity is rejected even with a local test profile or DigitalOcean declaration', () => {
  for (const profile of ['digitalocean-production', 'isolated-ci']) {
    for (const identity of [
      { TEST_HOST_NAME: 'srv1512423' },
      { TEST_HOST_NAME: 'SRV1512423.HSTGR.CLOUD.' },
      { TEST_HOST_NAME: '187.77.245.144' },
      { TEST_HOST_NAME: 'renamed-host', TEST_HOST_ADDRESSES: '10.0.0.4 187.77.245.144' },
    ]) {
      const result = runGuard({ APOLLO_RESOURCE_PROFILE: profile, ...identity })
      assert.equal(result.status, 1, result.stderr || result.error?.message)
      assert.match(result.stderr, /Hostinger.*forbidden/)
      assert.doesNotMatch(result.stdout, /ADMITTED|UNEXPECTED_EFFECT/)
    }
  }
})

test('deploy and backup entrypoints refuse Hostinger before any external effect', () => {
  for (const entrypoint of ['infra/deploy/apollo-vps.sh', 'infra/deploy/backup-postgres.sh']) {
    const result = runGuard({ TEST_HOST_NAME: 'srv1512423.hstgr.cloud' }, entrypoint)
    assert.equal(result.status, 1, result.stderr || result.error?.message)
    assert.match(result.stderr, /Hostinger.*forbidden/)
    assert.doesNotMatch(result.stdout, /UNEXPECTED_EFFECT/)
  }
})

test('shipped catalogs have no retired production alias or implicit Hostinger network', async () => {
  for (const filename of ['config/host-safety-policy.json', 'config/resource-budget.json']) {
    const catalog = JSON.parse(await readFile(resolve(root, filename), 'utf8'))
    assert.ok(catalog.profiles['digitalocean-production'])
    assert.equal(catalog.profiles['shared-production'], undefined)
  }
  for (const filename of ['infra/deploy/apollo-vps.sh', 'infra/deploy/lib/ops.sh']) {
    const script = await readFile(resolve(root, filename), 'utf8')
    assert.doesNotMatch(script, /easypanel/)
    assert.match(script, /--network "\$\{APOLLO_DOCKER_NETWORK\}"/)
  }
})
