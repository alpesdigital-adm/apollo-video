import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createOwnedTempRoot,
  ownedTempRoots,
  removeOwnedTempRoot,
  withOwnedTempRoot,
} from './helpers/owned-temp-root.mjs'
import { createW39ArtifactRoot, removeW39ArtifactRoot } from './helpers/dashboard-w39-duplicate.mjs'

const helperUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'owned-temp-root.mjs')).href

async function populate(root) {
  await mkdir(join(root, 'w39', 'abc12345'), { recursive: true })
  await writeFile(join(root, 'w39', 'abc12345', 'master.mp4'), Buffer.alloc(4096, 1))
  await mkdir(join(root, 'artifacts', 'nested'), { recursive: true })
  await writeFile(join(root, 'artifacts', 'nested', 'server-written.bin'), Buffer.alloc(4096, 2))
}

test('an owned temporary root is created under the temporary directory and removed with everything in it', async () => {
  const root = await createOwnedTempRoot('apollo-owned-root-test-')
  assert.equal(dirname(root), resolve(tmpdir()))
  assert.match(basename(root), /^apollo-owned-root-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  await populate(root)
  assert.deepEqual(ownedTempRoots().includes(root), true)
  assert.equal(await removeOwnedTempRoot(root), true)
  assert.equal(existsSync(root), false)
  assert.equal(ownedTempRoots().includes(root), false)
  assert.equal(await removeOwnedTempRoot(root), false, 'removing twice is harmless')
})

test('withOwnedTempRoot leaves no directory behind on success', async () => {
  let seen
  const value = await withOwnedTempRoot('apollo-owned-root-success-', async (root) => {
    seen = root
    await populate(root)
    assert.equal(existsSync(root), true)
    return 'done'
  })
  assert.equal(value, 'done')
  assert.equal(existsSync(seen), false)
})

test('withOwnedTempRoot leaves no directory behind on failure and still raises the failure', async () => {
  let seen
  await assert.rejects(
    withOwnedTempRoot('apollo-owned-root-failure-', async (root) => {
      seen = root
      await populate(root)
      throw new Error('journey failed halfway')
    }),
    /journey failed halfway/,
  )
  assert.equal(existsSync(seen), false)
})

test('the W39 artifact root is gone after the journey, including artifacts the journey server wrote', async () => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('apollo-w39-artifacts-')))
  const root = await createW39ArtifactRoot()
  assert.match(basename(root), /^apollo-w39-artifacts-[0-9a-f-]{36}$/)
  await populate(root)
  assert.equal(await removeW39ArtifactRoot(root), true)
  assert.equal(existsSync(root), false)
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('apollo-w39-artifacts-') && !before.has(name))
  assert.deepEqual(after, [], 'this journey left no apollo-w39-artifacts-* directory')
})

test('only a root this process created is ever removed', async () => {
  const lookalike = join(tmpdir(), `apollo-w39-artifacts-${randomUUID()}`)
  await mkdir(lookalike, { recursive: true })
  const outside = join(tmpdir(), `apollo-owned-root-outside-${randomUUID()}`)
  await mkdir(outside, { recursive: true })
  try {
    await writeFile(join(lookalike, 'keep.txt'), 'another run owns this')
    assert.equal(await removeW39ArtifactRoot(lookalike), false)
    assert.equal(await removeOwnedTempRoot(outside), false)
    assert.equal(await removeOwnedTempRoot(tmpdir()), false)
    assert.equal(existsSync(join(lookalike, 'keep.txt')), true)
    assert.equal(existsSync(outside), true)
    await assert.rejects(createOwnedTempRoot('Bad Prefix'), /prefix/)
    await assert.rejects(createOwnedTempRoot('../escape-'), /prefix/)
  } finally {
    await rm(lookalike, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a run that ends without reaching its finally (uncaught error, process.exit) still leaves nothing behind', () => {
  for (const ending of ['process.exit(3)', "throw new Error('timeout kill')", '']) {
    const script = `
      import { createOwnedTempRoot } from ${JSON.stringify(helperUrl)}
      import { mkdir, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      const root = await createOwnedTempRoot('apollo-owned-root-exit-')
      await mkdir(join(root, 'artifacts'), { recursive: true })
      await writeFile(join(root, 'artifacts', 'x.bin'), 'x')
      console.log(root)
      ${ending}
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const root = child.stdout.trim().split(/\r?\n/)[0]
    assert.match(basename(root), /^apollo-owned-root-exit-/, child.stderr)
    assert.equal(existsSync(root), false, `ending ${ending || 'normally'} left ${root}`)
  }
})
