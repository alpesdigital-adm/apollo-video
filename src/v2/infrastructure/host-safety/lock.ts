/**
 * Exclusivity of the one mutable remote operation.
 *
 * `AGENTS.md` line 186 allows at most one mutable remote operation, one owner and
 * one operational connection at a time across every agent and channel. The lock
 * is `mkdir` of a directory: on every POSIX filesystem `mkdir` either creates the
 * directory or fails with `EEXIST`, which makes it a compare-and-set without a
 * daemon, without a lock server, and without the "check then create" race a
 * `test -f` guard has.
 *
 * Identity, not age, decides whether a lock may be taken over. A stale-looking
 * lock whose PID is alive is a live operation that happens to be slow — breaking
 * it would produce the two concurrent deploys this file exists to prevent. A lock
 * is an orphan only when:
 *
 * - its `bootId` differs from the current boot (the machine rebooted, so no
 *   process of that run can still exist), or
 * - its PID no longer exists AND it started more than `OPS_LOCK_ORPHAN_AFTER_MS`
 *   ago (the grace window keeps a lock written microseconds before the owner's
 *   `fork` from being stolen).
 *
 * An orphan is moved into `journal/`, never deleted, so the takeover is auditable.
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  atomicWriteJson,
  ensureJournalDirectory,
  journalDirectoryPath,
  lockDirectoryPath,
  readJsonFile,
} from './state-files.ts'

export const OPS_LOCK_SCHEMA_VERSION = 'apollo-ops-lock/v1'
/** A dead PID is only an orphan once the lock is older than this. */
export const OPS_LOCK_ORPHAN_AFTER_MS = 600_000

export type OpsLockCommand = 'deploy' | 'plan' | 'latch-release' | 'gate-open' | 'status'

export interface OpsLockOwner {
  readonly schemaVersion: typeof OPS_LOCK_SCHEMA_VERSION
  readonly runId: string
  readonly pid: number
  readonly startedAtIso: string
  /** `/proc/sys/kernel/random/boot_id`: changes on every boot. */
  readonly bootId: string
  readonly command: OpsLockCommand
  readonly hostname: string
}

export interface AcquireOperationLockInput {
  readonly stateDir: string
  readonly owner: Omit<OpsLockOwner, 'schemaVersion'>
  /** Current boot id; a holder from another boot cannot still be running. */
  readonly currentBootId: string
  readonly nowMs: number
  /** Whether a PID exists on this host; injected so the rule is testable. */
  readonly processExists: (pid: number) => boolean
  readonly orphanAfterMs?: number
}

export type AcquireOperationLockResult =
  | { readonly acquired: true; readonly path: string; readonly owner: OpsLockOwner; readonly tookOverOrphan: string | null }
  | { readonly acquired: false; readonly reason: string; readonly holder: OpsLockOwner | null; readonly holderDescription: string }

function parseOwner(value: unknown): OpsLockOwner | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== OPS_LOCK_SCHEMA_VERSION) return null
  for (const key of ['runId', 'startedAtIso', 'bootId', 'command', 'hostname'] as const) {
    if (typeof candidate[key] !== 'string' || (candidate[key] as string).length === 0) return null
  }
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) < 1) return null
  if (Number.isNaN(Date.parse(candidate.startedAtIso as string))) return null
  return candidate as unknown as OpsLockOwner
}

function describeHolder(owner: OpsLockOwner | null, fallback: string): string {
  if (!owner) return fallback
  return `run ${owner.runId} (${owner.command}) pid ${owner.pid} on ${owner.hostname} since ${owner.startedAtIso}`
}

/** Reads the lock owner, distinguishing "no lock" from "lock with no readable owner". */
export async function readLockOwner(stateDir: string): Promise<
  { readonly held: false } | { readonly held: true; readonly owner: OpsLockOwner | null; readonly error?: string }
> {
  const read = await readJsonFile(join(lockDirectoryPath(stateDir), 'owner.json'))
  if (!read.present) {
    // The directory may exist without an owner file: a crash between `mkdir` and
    // the write. That is a held lock with an unknown owner, never a free lock,
    // so the two cases are told apart by the directory itself.
    try {
      await stat(lockDirectoryPath(stateDir))
    } catch {
      return { held: false }
    }
    return { held: true, owner: null, error: 'lock directory exists without owner.json' }
  }
  if (!read.valid) return { held: true, owner: null, error: read.error }
  const owner = parseOwner(read.value)
  return owner ? { held: true, owner } : { held: true, owner: null, error: 'owner.json does not match apollo-ops-lock/v1' }
}

/** Acquires the lock, or refuses with the identity of whoever holds it. */
export async function acquireOperationLock(input: AcquireOperationLockInput): Promise<AcquireOperationLockResult> {
  const lockDirectory = lockDirectoryPath(input.stateDir)
  const orphanAfterMs = input.orphanAfterMs ?? OPS_LOCK_ORPHAN_AFTER_MS
  const owner: OpsLockOwner = { schemaVersion: OPS_LOCK_SCHEMA_VERSION, ...input.owner }

  const created = await tryCreateLockDirectory(lockDirectory)
  if (created) {
    await atomicWriteJson(join(lockDirectory, 'owner.json'), owner)
    return { acquired: true, path: lockDirectory, owner, tookOverOrphan: null }
  }

  const holder = await readLockOwner(input.stateDir)
  const holderOwner = holder.held ? holder.owner : null
  if (!holderOwner) {
    return {
      acquired: false,
      reason: 'lock-held-by-unknown-owner',
      holder: null,
      holderDescription: describeHolder(null, `${lockDirectory} exists with no readable owner.json`),
    }
  }
  const differentBoot = holderOwner.bootId !== input.currentBootId
  const pidGone = !input.processExists(holderOwner.pid)
  const ageMs = input.nowMs - Date.parse(holderOwner.startedAtIso)
  const orphan = differentBoot || (pidGone && ageMs > orphanAfterMs)
  if (!orphan) {
    return {
      acquired: false,
      reason: pidGone ? 'lock-held-recently-by-a-gone-pid' : 'lock-held',
      holder: holderOwner,
      holderDescription: describeHolder(holderOwner, ''),
    }
  }

  await ensureJournalDirectory(input.stateDir)
  const archivedAt = join(journalDirectoryPath(input.stateDir), `lock-${holderOwner.runId}.orphaned.json`)
  await atomicWriteJson(archivedAt, {
    ...holderOwner,
    orphanedBecause: differentBoot ? 'different-boot-id' : 'pid-absent-and-older-than-grace',
    observedBootId: input.currentBootId,
    observedAtMs: input.nowMs,
    ageMs,
  })
  await rm(lockDirectory, { recursive: true, force: true })
  const recreated = await tryCreateLockDirectory(lockDirectory)
  if (!recreated) {
    return {
      acquired: false,
      reason: 'lock-recreated-by-another-run',
      holder: null,
      holderDescription: 'another run acquired the lock while the orphan was being archived',
    }
  }
  await atomicWriteJson(join(lockDirectory, 'owner.json'), owner)
  return { acquired: true, path: lockDirectory, owner, tookOverOrphan: archivedAt }
}

async function tryCreateLockDirectory(path: string): Promise<boolean> {
  try {
    // No `recursive: true`: recursive mkdir succeeds on an existing directory,
    // which would turn the compare-and-set into an unconditional success.
    await mkdir(path)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false
    throw error
  }
}

export type ReleaseOperationLockResult =
  | { readonly released: true }
  | { readonly released: false; readonly reason: string; readonly holder: OpsLockOwner | null }

/** Releases the lock only when this run still owns it. */
export async function releaseOperationLock(input: { readonly stateDir: string; readonly runId: string }): Promise<ReleaseOperationLockResult> {
  const holder = await readLockOwner(input.stateDir)
  if (!holder.held) return { released: false, reason: 'no-lock-held', holder: null }
  if (!holder.owner) return { released: false, reason: 'lock-owner-unreadable', holder: null }
  if (holder.owner.runId !== input.runId) return { released: false, reason: 'lock-owned-by-another-run', holder: holder.owner }
  await rename(join(lockDirectoryPath(input.stateDir), 'owner.json'), join(lockDirectoryPath(input.stateDir), 'owner.released.json'))
  await rm(lockDirectoryPath(input.stateDir), { recursive: true, force: true })
  return { released: true }
}
