import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFileAdmissionGate } from '../../src/v2/infrastructure/ops-state/file-admission-gate.ts'

const FIXTURES = fileURLToPath(new URL('../fixtures/ops-state/', import.meta.url))
const NOW = new Date('2026-09-18T23:59:25.000Z')

/**
 * The reader half of the Wave 23 ops-state contract, rule by rule.
 *
 * Every case uses a real temporary directory rather than a stubbed filesystem,
 * because "the env points at a directory that is not there" is one of the rules and
 * a stub cannot fail the way a filesystem does. The clock and the mtime source are
 * injected so the staleness rule can be proven without waiting out a TTL.
 */
async function withStateDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-ops-state-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function copyFixture(directory, fixture, name) {
  await writeFile(join(directory, name), await readFile(join(FIXTURES, fixture), 'utf8'))
}

function gateFor(directory, options = {}) {
  return createFileAdmissionGate({
    directory,
    now: () => options.now ?? NOW,
    // Fresh by default: the contract measures an open gate's age from the file's
    // own mtime on this host, so a fixture copied a moment ago must read as fresh.
    statMtime: options.statMtime ?? (async (path) => (
      path === directory || path.endsWith('gate.json') || path.endsWith('latch.json')
        ? new Date(NOW.getTime() - 1_000)
        : null
    )),
    readText: options.readText,
  })
}

test('an unset APOLLO_OPS_STATE_DIR admits and says why, without inventing a gate', async () => {
  const gate = createFileAdmissionGate({ directory: undefined, now: () => NOW })
  const previous = process.env.APOLLO_OPS_STATE_DIR
  delete process.env.APOLLO_OPS_STATE_DIR
  try {
    const bare = createFileAdmissionGate({ now: () => NOW })
    assert.deepEqual(await bare.read(), { admits: true, reason: 'ops-state-not-configured' })
  } finally {
    if (previous !== undefined) process.env.APOLLO_OPS_STATE_DIR = previous
  }
  assert.deepEqual(await gate.read(), { admits: true, reason: 'ops-state-not-configured' })
})

test('a configured directory that does not exist is closed, not open', async () => {
  const gate = createFileAdmissionGate({
    directory: join(tmpdir(), 'apollo-ops-state-absent-on-purpose'),
    now: () => NOW,
  })
  assert.deepEqual(await gate.read(), { admits: false, reason: 'ops-state-unreadable' })
})

test('a configured directory that cannot be read is closed', async () => {
  await withStateDir(async (directory) => {
    const gate = gateFor(directory, { statMtime: async () => null })
    assert.deepEqual(await gate.read(), { admits: false, reason: 'ops-state-unreadable' })
  })
})

test('an absent gate.json is open: absence is the contract default', async () => {
  await withStateDir(async (directory) => {
    assert.deepEqual(await gateFor(directory).read(), { admits: true, reason: null })
  })
})

test('an unreadable latch or gate on the real filesystem is not an absent file', async () => {
  for (const [name, reason] of [['latch.json', 'incident-latch-unreadable'], ['gate.json', 'gate-unreadable']]) {
    await withStateDir(async (directory) => {
      // readFile on a directory fails on Windows and Linux, even when running
      // as root; this exercises the real adapter without chmod-based skips.
      await mkdir(join(directory, name))
      assert.deepEqual(await gateFor(directory).read(), { admits: false, reason })
    })
  }
})

test('permission and I/O errors close admission instead of becoming absence', async () => {
  for (const code of ['EACCES', 'EIO']) {
    for (const [name, reason] of [['latch.json', 'incident-latch-unreadable'], ['gate.json', 'gate-unreadable']]) {
      await withStateDir(async (directory) => {
        const gate = gateFor(directory, { readText: async (path) => {
          if (path === join(directory, name)) throw Object.assign(new Error('unreadable'), { code })
          return null
        } })
        assert.deepEqual(await gate.read(), { admits: false, reason })
      })
    }
  }
})

test('an open gate dated in the future is inconclusive, not fresh', async () => {
  await withStateDir(async (directory) => {
    await copyFixture(directory, 'gate-open.json', 'gate.json')
    const gate = gateFor(directory, { statMtime: async () => new Date(NOW.getTime() + 1) })
    assert.deepEqual(await gate.read(), { admits: false, reason: 'stale-gate' })
  })
})

test('the contract gate-open example admits while it is inside its ttl', async () => {
  await withStateDir(async (directory) => {
    await copyFixture(directory, 'gate-open.json', 'gate.json')
    assert.deepEqual(await gateFor(directory).read(), { admits: true, reason: null })
  })
})

test('the contract gate-closed example refuses and carries its reasons', async () => {
  await withStateDir(async (directory) => {
    await copyFixture(directory, 'gate-closed.json', 'gate.json')
    assert.deepEqual(await gateFor(directory).read(), {
      admits: false,
      reason: 'gate-closed:cpu-busy-sustained,monitor-stale',
    })
  })
})

test('an open gate older than its ttl is stale and therefore closed', async () => {
  await withStateDir(async (directory) => {
    await copyFixture(directory, 'gate-open.json', 'gate.json')
    // ttlMs is 30000 in the contract example; 30001ms of age is one millisecond too
    // old, which is the boundary a dead monitor crosses.
    const stale = gateFor(directory, {
      statMtime: async (path) => (
        path === directory ? NOW : new Date(NOW.getTime() - 30_001)
      ),
    })
    assert.deepEqual(await stale.read(), { admits: false, reason: 'stale-gate' })

    const exactlyAtTtl = gateFor(directory, {
      statMtime: async (path) => (
        path === directory ? NOW : new Date(NOW.getTime() - 30_000)
      ),
    })
    assert.deepEqual(await exactlyAtTtl.read(), { admits: true, reason: null })
  })
})

test('an open gate whose file vanishes between read and stat is stale', async () => {
  await withStateDir(async (directory) => {
    await copyFixture(directory, 'gate-open.json', 'gate.json')
    const racing = gateFor(directory, {
      statMtime: async (path) => (path === directory ? NOW : null),
    })
    assert.deepEqual(await racing.read(), { admits: false, reason: 'stale-gate' })
  })
})

test('a latch closes the gate whatever the metrics say', async () => {
  await withStateDir(async (directory) => {
    await copyFixture(directory, 'gate-open.json', 'gate.json')
    await copyFixture(directory, 'latch.json', 'latch.json')
    assert.deepEqual(await gateFor(directory).read(), {
      admits: false,
      reason: 'incident-latch:stop-timeout',
    })
  })
})

test('a latch nobody can parse still means somebody latched', async () => {
  await withStateDir(async (directory) => {
    await writeFile(join(directory, 'latch.json'), '{ this is not json')
    assert.deepEqual(await gateFor(directory).read(), {
      admits: false,
      reason: 'incident-latch-unreadable',
    })
    await writeFile(
      join(directory, 'latch.json'),
      JSON.stringify({ schemaVersion: 'apollo-ops-latch/v2', reason: 'whatever' }),
    )
    assert.deepEqual(await gateFor(directory).read(), {
      admits: false,
      reason: 'incident-latch-unreadable',
    })
  })
})

test('a latch with no stated reason is still a closed gate', async () => {
  await withStateDir(async (directory) => {
    await writeFile(
      join(directory, 'latch.json'),
      JSON.stringify({ schemaVersion: 'apollo-ops-latch/v1', runId: 'r' }),
    )
    assert.deepEqual(await gateFor(directory).read(), {
      admits: false,
      reason: 'incident-latch:engaged',
    })
  })
})

test('every unreadable, unknown or untimed gate shape fails closed', async () => {
  const cases = [
    ['{ not json at all', 'gate-unparseable'],
    ['[]', 'gate-unparseable'],
    ['"a string"', 'gate-unparseable'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v2', state: 'open', ttlMs: 30000 }), 'gate-schema-unknown'],
    [JSON.stringify({ state: 'open', ttlMs: 30000 }), 'gate-schema-unknown'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'paused', ttlMs: 30000 }), 'gate-state-unknown'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', ttlMs: 30000 }), 'gate-state-unknown'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'open' }), 'gate-ttl-invalid'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'open', ttlMs: 0 }), 'gate-ttl-invalid'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'open', ttlMs: -1 }), 'gate-ttl-invalid'],
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'open', ttlMs: '30000' }), 'gate-ttl-invalid'],
    // An invalid ttl closes a `closed` gate too: the rule is about the document, not
    // about which verdict it happens to carry.
    [JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'closed' }), 'gate-ttl-invalid'],
  ]
  await withStateDir(async (directory) => {
    for (const [body, reason] of cases) {
      await writeFile(join(directory, 'gate.json'), body)
      assert.deepEqual(
        await gateFor(directory).read(),
        { admits: false, reason },
        `gate.json body ${body} must close with ${reason}`,
      )
    }
  })
})

test('a closed gate with no reasons listed still names itself', async () => {
  await withStateDir(async (directory) => {
    await writeFile(
      join(directory, 'gate.json'),
      JSON.stringify({ schemaVersion: 'apollo-ops-gate/v1', state: 'closed', ttlMs: 30000 }),
    )
    assert.deepEqual(await gateFor(directory).read(), { admits: false, reason: 'gate-closed' })
  })
})

test('the reader never writes to or removes anything in the state directory', async () => {
  await withStateDir(async (directory) => {
    await mkdir(join(directory, 'journal'), { recursive: true })
    await copyFixture(directory, 'gate-closed.json', 'gate.json')
    const before = await readFile(join(directory, 'gate.json'), 'utf8')
    for (let index = 0; index < 3; index += 1) await gateFor(directory).read()
    assert.equal(await readFile(join(directory, 'gate.json'), 'utf8'), before)
  })
})
