import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Temporary roots created by this process, keyed by absolute path. A root can only be removed by the process that
// created it, under the temporary directory, with the prefix and uuid it was created with: a directory that merely
// looks similar (another run's, a hand-made one, a path outside the temporary directory) is never touched.
const owned = new Map()

// Last resort for a run that ends without reaching its `finally` (test-runner timeout, process.exit, an uncaught error):
// roots still owned when the process exits are removed synchronously. A SIGKILL cannot be caught, which is why the
// callers also remove their root on every path.
process.once('exit', () => {
  for (const root of owned.keys()) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* the next run's postflight reports leftovers */ }
  }
})

/** Creates `<tmpdir>/<prefix><uuid>` and remembers that this process owns it. */
export async function createOwnedTempRoot(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z0-9][a-z0-9-]*-$/.test(prefix)) throw new Error('a temporary root prefix is lowercase words ending in "-"')
  const suffix = randomUUID()
  const root = resolve(join(tmpdir(), `${prefix}${suffix}`))
  await mkdir(root, { recursive: false })
  owned.set(root, { prefix, suffix })
  return root
}

/**
 * Removes a root made by createOwnedTempRoot in this process. Returns true when it removed the directory, false when the
 * root is not owned (nothing is deleted then) or is already gone. Safe to call on every path, more than once.
 */
export async function removeOwnedTempRoot(root) {
  const resolved = resolve(String(root))
  const record = owned.get(resolved)
  if (!record) return false
  if (dirname(resolved) !== resolve(tmpdir()) || basename(resolved) !== `${record.prefix}${record.suffix}`) {
    throw new Error(`refusing to remove ${resolved}: it is not the temporary root this process created`)
  }
  owned.delete(resolved)
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  return true
}

/** Runs `run(root)` and removes the root afterwards on success, on failure and when `run` throws synchronously. */
export async function withOwnedTempRoot(prefix, run) {
  const root = await createOwnedTempRoot(prefix)
  try {
    return await run(root)
  } finally {
    await removeOwnedTempRoot(root)
  }
}

/** The roots this process still owns (a postflight check reads it). */
export function ownedTempRoots() {
  return [...owned.keys()]
}
