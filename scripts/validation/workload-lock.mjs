import { randomBytes } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'

/**
 * Global local-workload lock shared with the W66 executor. The lock is a single file created
 * exclusively (`wx`): whoever creates it owns the workload slot, nobody waits on it and nobody
 * steals it. A holder that died leaves a file only its operator may remove. Release deletes the
 * file only while it still carries this owner's nonce, so a lock that was replaced is never
 * removed by a stale owner.
 */
export class WorkloadLockHeldError extends Error {
  constructor(lockPath, holder) {
    super(`Workload lock ${lockPath} is held: ${holder === null ? 'unreadable holder' : JSON.stringify(holder)}`)
    this.name = 'WorkloadLockHeldError'
    this.lockPath = lockPath
    this.holder = holder
  }
}

async function readHolder(lockPath) {
  try { return JSON.parse(await readFile(lockPath, 'utf8')) } catch { return null }
}

export async function acquireWorkloadLock({ lockPath, label, pid = process.pid, now = () => new Date() }) {
  if (typeof lockPath !== 'string' || lockPath.length === 0) throw new TypeError('lockPath is required')
  if (typeof label !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(label)) throw new TypeError('label must be a short plain token')
  const nonce = randomBytes(16).toString('hex')
  const record = { pid, label, at: now().toISOString(), nonce }
  let handle
  try {
    handle = await open(lockPath, 'wx') // exclusive create: fails with EEXIST when the slot is taken
  } catch (error) {
    if (error?.code === 'EEXIST') throw new WorkloadLockHeldError(lockPath, await readHolder(lockPath))
    throw error
  }
  try {
    await handle.writeFile(JSON.stringify(record))
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    throw error
  }
  await handle.close()
  return Object.freeze({ lockPath, nonce, record })
}

/** Returns 'released' when this owner's lock was removed, otherwise the reason it was left alone. */
export async function releaseWorkloadLock(lock) {
  const holder = await readHolder(lock.lockPath)
  if (holder === null) return 'absent-or-unreadable'
  if (holder.nonce !== lock.nonce) return 'held-by-another-owner'
  try { await unlink(lock.lockPath) } catch (error) {
    if (error?.code === 'ENOENT') return 'absent-or-unreadable'
    throw error
  }
  return 'released'
}
