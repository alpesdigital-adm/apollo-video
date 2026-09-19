/**
 * Append-only journal of one supervised operation.
 *
 * `AGENTS.md` line 223 forbids claiming that something stopped without verifying
 * the terminal state, and line 279 makes an inconclusive postflight a blocker. A
 * claim nobody can re-read later is indistinguishable from an assumption, so every
 * step writes what it did, what it then observed, and — when the observation was
 * ambiguous — that the step was inconclusive.
 *
 * **No secret is ever written here.** The deploy hands the containers their
 * configuration with `--env-file`, so no environment value passes through this
 * process, and the events below record names, container ids, statuses and counts
 * only. `assertJournalDataCarriesNoSecret` makes that a runtime check rather than
 * a habit.
 *
 * Two streams, one writer each: the monitor appends samples to
 * `journal/<runId>.monitor.ndjson` while the orchestrator appends steps to
 * `journal/<runId>.ndjson`. Two processes appending to one file would depend on
 * every line staying under the atomic-write size, which is not a property worth
 * betting a deploy on.
 */

import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureJournalDirectory, journalDirectoryPath } from './state-files.ts'

export type OperationJournalStream = 'operation' | 'monitor'

export type OperationJournalEvent =
  | 'lock-acquired'
  | 'lock-released'
  | 'plan'
  | 'monitor-started'
  | 'monitor-stopped'
  | 'host-sample'
  | 'preflight-verdict'
  | 'during-verdict'
  | 'postflight-verdict'
  | 'stability-verdict'
  | 'budget-resolved'
  | 'budget-rejected'
  | 'cgroup-capability'
  | 'step-start'
  | 'step-verify'
  | 'step-done'
  | 'step-inconclusive'
  | 'step-blocked'
  | 'adopt-unlabelled'
  | 'latch-engaged'
  | 'latch-released'
  | 'gate-opened'

export interface OperationJournalLine {
  readonly tIso: string
  readonly monotonicMs: number
  readonly runId: string
  readonly event: OperationJournalEvent
  readonly data: unknown
}

export function journalPath(stateDir: string, runId: string, stream: OperationJournalStream): string {
  return join(journalDirectoryPath(stateDir), stream === 'monitor' ? `${runId}.monitor.ndjson` : `${runId}.ndjson`)
}

export interface CreateOperationJournalInput {
  readonly stateDir: string
  readonly runId: string
  readonly stream: OperationJournalStream
  readonly now: () => Date
  readonly monotonicNow: () => number
}

export interface OperationJournal {
  readonly path: string
  readonly append: (event: OperationJournalEvent, data: unknown) => Promise<void>
}

export async function createOperationJournal(input: CreateOperationJournalInput): Promise<OperationJournal> {
  await ensureJournalDirectory(input.stateDir)
  const path = journalPath(input.stateDir, input.runId, input.stream)
  return {
    path,
    async append(event, data) {
      const line: OperationJournalLine = {
        tIso: input.now().toISOString(),
        monotonicMs: input.monotonicNow(),
        runId: input.runId,
        event,
        data: data ?? null,
      }
      await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8')
    },
  }
}

/** Reads a journal, skipping lines that are not JSON objects (a torn tail). */
export async function readJournalLines(path: string): Promise<readonly OperationJournalLine[]> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
  const lines: OperationJournalLine[] = []
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const candidate = parsed as Record<string, unknown>
    if (typeof candidate.event !== 'string' || typeof candidate.runId !== 'string') continue
    if (!Number.isFinite(candidate.monotonicMs)) continue
    lines.push(candidate as unknown as OperationJournalLine)
  }
  return Object.freeze(lines)
}

/** The `host-sample` payloads of a monitor journal, oldest first. */
export async function readMonitorSamples(input: {
  readonly stateDir: string
  readonly runId: string
}): Promise<readonly unknown[]> {
  const lines = await readJournalLines(journalPath(input.stateDir, input.runId, 'monitor'))
  return Object.freeze(lines.filter((line) => line.event === 'host-sample').map((line) => line.data))
}

/**
 * Fails when a value that is about to be journalled contains a forbidden string.
 *
 * The deploy calls it with the values it read out of the environment file's NAMES
 * — never the values themselves — so that a future step that starts echoing
 * configuration breaks a test instead of leaking into a file on the host.
 */
export function assertJournalDataCarriesNoSecret(data: unknown, forbidden: readonly string[]): void {
  if (forbidden.length === 0) return
  const serialized = JSON.stringify(data ?? null)
  for (const value of forbidden) {
    if (value.length >= 8 && serialized.includes(value)) {
      throw new Error('journal payload contains a configured secret value')
    }
  }
}
