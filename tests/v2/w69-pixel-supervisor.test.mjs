import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireWorkloadLock, releaseWorkloadLock, WorkloadLockHeldError } from '../../scripts/validation/workload-lock.mjs'
import { main, parseArguments } from '../../scripts/validation/w69-run-ass-binder-pixels.mjs'

async function withDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-lock-test-'))
  try { await action(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the workload lock is an exclusive create that is never waited for or stolen', async () => {
  await withDirectory(async (directory) => {
    const lockPath = join(directory, 'workload.lock')
    const first = await acquireWorkloadLock({ lockPath, label: 'w69-test', pid: 4242, now: () => new Date('2026-10-17T00:00:00.000Z') })
    assert.equal(first.record.pid, 4242); assert.equal(first.record.at, '2026-10-17T00:00:00.000Z')
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), first.record)
    await assert.rejects(acquireWorkloadLock({ lockPath, label: 'other' }), (error) =>
      error instanceof WorkloadLockHeldError && error.holder.label === 'w69-test' && error.holder.nonce === first.nonce)
    // The lock of a dead holder is not stolen either: only its operator removes it.
    assert.equal(await releaseWorkloadLock(first), 'released')
    assert.equal(await releaseWorkloadLock(first), 'absent-or-unreadable')
    const second = await acquireWorkloadLock({ lockPath, label: 'w69-second' })
    assert.notEqual(second.nonce, first.nonce)
    assert.equal(await releaseWorkloadLock(second), 'released')
  })
})

test('a stale owner never removes a lock that now belongs to another owner, and unreadable holders still block', async () => {
  await withDirectory(async (directory) => {
    const lockPath = join(directory, 'workload.lock')
    const stale = await acquireWorkloadLock({ lockPath, label: 'stale' })
    await writeFile(lockPath, JSON.stringify({ pid: 1, label: 'replacement', at: 'x', nonce: 'someone-else' }))
    assert.equal(await releaseWorkloadLock(stale), 'held-by-another-owner')
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).label, 'replacement')
    await writeFile(lockPath, '{not json')
    await assert.rejects(acquireWorkloadLock({ lockPath, label: 'late' }), (error) => error instanceof WorkloadLockHeldError && error.holder === null)
    assert.equal(await releaseWorkloadLock(stale), 'absent-or-unreadable')
    assert.equal(await readFile(lockPath, 'utf8'), '{not json')
  })
})

test('lock arguments are validated', async () => {
  await assert.rejects(acquireWorkloadLock({ lockPath: '', label: 'x' }), TypeError)
  await assert.rejects(acquireWorkloadLock({ lockPath: join(tmpdir(), 'x.lock'), label: 'bad label!' }), TypeError)
})

test('the supervisor refuses relative paths, bad pins and unknown flags, and a dry run starts nothing', async () => {
  assert.throws(() => parseArguments([]), /--base/)
  assert.throws(() => parseArguments(['--base', 'relative']), /--base/)
  assert.throws(() => parseArguments(['--base', join(tmpdir(), 'b'), '--ffmpeg-sha256', 'abc']), /SHA-256/)
  assert.throws(() => parseArguments(['--base', join(tmpdir(), 'b'), '--nope']), /Unknown argument/)
  assert.throws(() => parseArguments(['--base', join(tmpdir(), 'b'), '--timeout-ms', '5']), /out of range/)
  assert.throws(() => parseArguments(['--base']), /requires a value/)
  const options = parseArguments(['--base', join(tmpdir(), 'b'), '--dry-run'])
  assert.equal(options.dryRun, true); assert.equal(options.fontFamily, 'Arial')
  await withDirectory(async (directory) => {
    const lines = []
    const original = console.log
    console.log = (line) => lines.push(line)
    try { assert.equal(await main(['--base', directory, '--dry-run']), 0) } finally { console.log = original }
    const plan = JSON.parse(lines.join('\n'))
    assert.equal(plan.dryRun, true); assert.equal(plan.lockPath, join(directory, 'workload.lock'))
    assert.deepEqual(plan.args, ['--experimental-transform-types', '--test', 'tests/v2/ass-emission-clock-pixels.integration.mjs'])
    await assert.rejects(readFile(join(directory, 'workload.lock')), { code: 'ENOENT' })
  })
})
