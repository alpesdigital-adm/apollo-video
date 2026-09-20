/**
 * The incident latch: one file whose presence refuses every operation.
 *
 * `AGENTS.md` line 231 forbids deploy, test and automatic restart during an
 * incident or an owner pause, and line 232 requires explicit authorization plus
 * five minutes of stable metrics before resuming. A latch that lived inside a
 * container would be cleared by the very restart it is meant to prevent, so it
 * lives on the host, next to `gate.json`, outside every container's writable
 * layer (the containers mount the directory read-only).
 *
 * It is never deleted. Releasing it moves the document into `journal/` with the
 * operator's reason, so the trail of "what stopped, when, and who decided it was
 * safe" survives the release. A latch file that cannot be parsed counts as
 * engaged: the one thing worse than a stuck latch is a latch that fails open.
 */

import { rename } from 'node:fs/promises'
import { join } from 'node:path'

import {
  atomicWriteJson,
  ensureJournalDirectory,
  journalDirectoryPath,
  latchFilePath,
  readJsonFile,
  timestampSlug,
} from './state-files.ts'

export const OPS_LATCH_SCHEMA_VERSION = 'apollo-ops-latch/v1'

export interface OpsLatchEvidence {
  /** Relative path of the journal that explains the latch. */
  readonly journal: string
  readonly lastSampleSeq: number | null
}

export interface OpsLatchDocument {
  readonly schemaVersion: typeof OPS_LATCH_SCHEMA_VERSION
  readonly engagedAtIso: string
  readonly runId: string
  readonly reason: string
  readonly detail: string
  readonly evidence: OpsLatchEvidence
}

export interface EngageLatchInput {
  readonly stateDir: string
  readonly runId: string
  /** Short stable code, e.g. `stop-timeout`, `readback-mismatch`, `gate-closed`. */
  readonly reason: string
  readonly detail: string
  readonly evidence: OpsLatchEvidence
  readonly engagedAtIso: string
}

export type LatchRead =
  | { readonly engaged: false }
  | { readonly engaged: true; readonly document: OpsLatchDocument }
  | { readonly engaged: true; readonly document: null; readonly error: string }

function parseLatchDocument(value: unknown): OpsLatchDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== OPS_LATCH_SCHEMA_VERSION) return null
  if (typeof candidate.engagedAtIso !== 'string' || Number.isNaN(Date.parse(candidate.engagedAtIso))) return null
  for (const key of ['runId', 'reason', 'detail'] as const) {
    if (typeof candidate[key] !== 'string' || (candidate[key] as string).length === 0) return null
  }
  const evidence = candidate.evidence
  if (typeof evidence !== 'object' || evidence === null) return null
  const evidenceRecord = evidence as Record<string, unknown>
  if (typeof evidenceRecord.journal !== 'string') return null
  if (evidenceRecord.lastSampleSeq !== null && !Number.isSafeInteger(evidenceRecord.lastSampleSeq)) return null
  return candidate as unknown as OpsLatchDocument
}

/**
 * Engages the latch, or leaves an existing one untouched.
 *
 * The first cause wins: overwriting would replace the evidence of what actually
 * went wrong with whatever failed next.
 */
export async function engageLatch(input: EngageLatchInput): Promise<{ readonly engaged: OpsLatchDocument; readonly alreadyEngaged: boolean }> {
  const existing = await readLatch(input.stateDir)
  if (existing.engaged && existing.document) return { engaged: existing.document, alreadyEngaged: true }
  const document: OpsLatchDocument = {
    schemaVersion: OPS_LATCH_SCHEMA_VERSION,
    engagedAtIso: input.engagedAtIso,
    runId: input.runId,
    reason: input.reason,
    detail: input.detail,
    evidence: input.evidence,
  }
  await atomicWriteJson(latchFilePath(input.stateDir), document)
  return { engaged: document, alreadyEngaged: existing.engaged }
}

/** Reads the latch. An unreadable latch is an engaged latch. */
export async function readLatch(stateDir: string): Promise<LatchRead> {
  const read = await readJsonFile(latchFilePath(stateDir))
  if (!read.present) return { engaged: false }
  if (!read.valid) return { engaged: true, document: null, error: read.error }
  const document = parseLatchDocument(read.value)
  if (!document) return { engaged: true, document: null, error: 'latch.json does not match apollo-ops-latch/v1' }
  return { engaged: true, document }
}

export interface ReleaseLatchInput {
  readonly stateDir: string
  readonly reason: string
  readonly releasedAtIso: string
  readonly operator?: string
}

export type ReleaseLatchResult =
  | { readonly released: true; readonly archivedAt: string; readonly document: OpsLatchDocument | null }
  | { readonly released: false; readonly error: string }

/**
 * Moves the latch into `journal/`, adding the release reason. Never `rm`.
 *
 * An unparseable latch is still archived — under a timestamp taken at release
 * time, since its own `engagedAtIso` cannot be trusted — so that a corrupt file
 * can be cleared by the documented path instead of by hand.
 */
export async function releaseLatch(input: ReleaseLatchInput): Promise<ReleaseLatchResult> {
  if (input.reason.trim().length === 0) return { released: false, error: 'a release requires the operator reason' }
  const current = await readLatch(input.stateDir)
  if (!current.engaged) return { released: false, error: 'no latch is engaged' }
  await ensureJournalDirectory(input.stateDir)
  const slug = timestampSlug(current.document ? current.document.engagedAtIso : input.releasedAtIso)
  const archivedAt = join(journalDirectoryPath(input.stateDir), `latch-${slug}.released.json`)
  await atomicWriteJson(archivedAt, {
    ...(current.document ?? { schemaVersion: OPS_LATCH_SCHEMA_VERSION, unparseable: true }),
    releasedAtIso: input.releasedAtIso,
    releaseReason: input.reason,
    releasedBy: input.operator ?? null,
  })
  // The document now exists in the journal; only then does the latch stop being
  // the host's answer. A crash between the two leaves the latch engaged, which is
  // the safe side of the failure.
  await rename(latchFilePath(input.stateDir), `${archivedAt}.source`)
  return { released: true, archivedAt, document: current.document }
}
