/**
 * Shared file mechanics of the host operational state directory.
 *
 * The directory (`APOLLO_OPS_STATE_DIR`, `/var/lib/apollo-ops` in production)
 * holds only host operational state: `gate.json`, `latch.json`, `lock/` and
 * `journal/`. It is deliberately NOT product state — no project, version, job or
 * artifact is ever written here; those live exclusively in PostgreSQL. Keeping
 * the boundary explicit is what stops this directory from becoming a second,
 * unversioned source of truth for the product.
 *
 * Every write is a temporary file in the same directory followed by `rename`,
 * which is atomic on the same filesystem: a reader — a worker deciding whether to
 * claim, the deploy deciding whether to advance — never sees half a decision.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export const OPS_STATE_FILES = Object.freeze({
  gate: 'gate.json',
  latch: 'latch.json',
  lock: 'lock',
  lockOwner: join('lock', 'owner.json'),
  journal: 'journal',
})

export function gateFilePath(stateDir: string): string {
  return join(stateDir, OPS_STATE_FILES.gate)
}

export function latchFilePath(stateDir: string): string {
  return join(stateDir, OPS_STATE_FILES.latch)
}

export function lockDirectoryPath(stateDir: string): string {
  return join(stateDir, OPS_STATE_FILES.lock)
}

export function journalDirectoryPath(stateDir: string): string {
  return join(stateDir, OPS_STATE_FILES.journal)
}

/** Writes JSON through a temporary file and an atomic rename in the same directory. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export type JsonFileRead =
  | { readonly present: true; readonly valid: true; readonly value: unknown }
  | { readonly present: true; readonly valid: false; readonly error: string }
  | { readonly present: false }

/**
 * Reads a JSON file without throwing. `present` and `valid` are separate answers
 * because they mean opposite things to a gate: an absent `gate.json` means the
 * run finished cleanly, while an unparseable one means something is wrong and the
 * gate must close.
 */
export async function readJsonFile(path: string): Promise<JsonFileRead> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { present: false }
    return { present: true, valid: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { present: true, valid: true, value: JSON.parse(content) }
  } catch (error) {
    return { present: true, valid: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function ensureJournalDirectory(stateDir: string): Promise<string> {
  const directory = journalDirectoryPath(stateDir)
  await mkdir(directory, { recursive: true })
  return directory
}

/** Filesystem-safe form of an ISO timestamp, for names inside `journal/`. */
export function timestampSlug(iso: string): string {
  return iso.replace(/[^0-9A-Za-z]/g, '')
}
