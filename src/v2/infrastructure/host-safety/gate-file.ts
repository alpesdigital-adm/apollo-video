/**
 * Writer and deploy-side reader of `gate.json`, the admission decision.
 *
 * Semantics, which are asymmetric on purpose:
 *
 * - **absent** ⇒ open. A finished run removes the file, and a host that never ran
 *   a supervised operation has no reason to hold Apollo back.
 * - **present and `state: "closed"`** ⇒ closed, with the policy's reason codes.
 * - **present, `state: "open"` and older than `ttlMs`** ⇒ closed (`stale-gate`).
 *   A monitor that died mid-run leaves its last open decision behind; letting it
 *   age into an open gate would be the exact failure `AGENTS.md` line 205 forbids
 *   ("falha do monitor fecha o gate").
 * - **present and unreadable / unknown schema / unknown state / no positive ttl**
 *   ⇒ closed. An undecodable decision is not a decision.
 *
 * Age is measured on `CLOCK_MONOTONIC` (see `host-clock.ts`), which is shared by
 * every process on the host, so the monitor's container and the deploy's shell
 * are comparing the same clock.
 */

import { rm } from 'node:fs/promises'

import type { HostSafetyReason } from './policy.ts'
import type { JsonFileRead } from './state-files.ts'
import { atomicWriteJson, gateFilePath, readJsonFile } from './state-files.ts'

export const OPS_GATE_SCHEMA_VERSION = 'apollo-ops-gate/v1'

export type OpsGateState = 'open' | 'closed'

export interface OpsGateOwner {
  readonly runId: string
  readonly kind: 'monitor' | 'orchestrator'
  readonly pid: number
}

export interface OpsGateDocument {
  readonly schemaVersion: typeof OPS_GATE_SCHEMA_VERSION
  readonly state: OpsGateState
  readonly reasons: readonly HostSafetyReason[]
  readonly seq: number
  readonly issuedAtIso: string
  readonly issuedAtMonotonicMs: number
  readonly ttlMs: number
  readonly owner: OpsGateOwner
}

export interface WriteGateFileInput {
  readonly stateDir: string
  readonly state: OpsGateState
  readonly reasons: readonly HostSafetyReason[]
  readonly seq: number
  readonly issuedAtIso: string
  readonly issuedAtMonotonicMs: number
  readonly ttlMs: number
  readonly owner: OpsGateOwner
}

/** Writes one decision atomically. `seq` must advance strictly inside a run. */
export async function writeGateFile(input: WriteGateFileInput): Promise<OpsGateDocument> {
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new Error('gate seq must be a positive integer')
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error('gate ttlMs must be positive')
  const document: OpsGateDocument = {
    schemaVersion: OPS_GATE_SCHEMA_VERSION,
    state: input.state,
    reasons: input.state === 'open' ? [] : Object.freeze([...input.reasons]),
    seq: input.seq,
    issuedAtIso: input.issuedAtIso,
    issuedAtMonotonicMs: input.issuedAtMonotonicMs,
    ttlMs: input.ttlMs,
    owner: input.owner,
  }
  await atomicWriteJson(gateFilePath(input.stateDir), document)
  return document
}

/** Removes `gate.json`. Absence is the "no supervised operation in flight" state. */
export async function removeGateFile(stateDir: string): Promise<void> {
  await rm(gateFilePath(stateDir), { force: true })
}

export interface DeployGateDecision {
  readonly admit: boolean
  readonly present: boolean
  readonly document: OpsGateDocument | null
  readonly ageMs: number | null
  readonly reasons: readonly string[]
}

export interface ReadGateForDeployInput {
  readonly stateDir: string
  /** Sampled after `gate.json` is read so a concurrently published gate cannot appear future-dated. */
  readonly monotonicNowMs: () => number
  /** Largest tolerated age of the decision the deploy is about to act on. */
  readonly maximumDecisionAgeMs: number
  /** Highest `seq` this run has already seen; the next read must exceed it. */
  readonly lastSeenSeq?: number
  /** A run in flight must find a decision; only a finished run may find none. */
  readonly requirePresent?: boolean
}

function parseGateDocument(value: unknown): OpsGateDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== OPS_GATE_SCHEMA_VERSION) return null
  if (candidate.state !== 'open' && candidate.state !== 'closed') return null
  if (!Number.isFinite(candidate.ttlMs) || (candidate.ttlMs as number) <= 0) return null
  if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 1) return null
  if (!Number.isFinite(candidate.issuedAtMonotonicMs)) return null
  if (typeof candidate.issuedAtIso !== 'string') return null
  if (!Array.isArray(candidate.reasons) || !candidate.reasons.every((reason) => typeof reason === 'string')) return null
  const owner = candidate.owner
  if (typeof owner !== 'object' || owner === null) return null
  const ownerRecord = owner as Record<string, unknown>
  if (typeof ownerRecord.runId !== 'string' || (ownerRecord.kind !== 'monitor' && ownerRecord.kind !== 'orchestrator')) return null
  if (!Number.isSafeInteger(ownerRecord.pid)) return null
  return candidate as unknown as OpsGateDocument
}

/**
 * The reading the deploy performs before each mutation: the decision must exist,
 * be decodable, be open, be fresher than `maximumDecisionAgeMs`, be inside its
 * own ttl, and carry a `seq` strictly greater than the last one seen — a monitor
 * that stopped writing keeps publishing the same seq, which looks fresh by mtime
 * and is not.
 */
export async function readGateForDeploy(
  input: ReadGateForDeployInput,
  readGateDocument: (path: string) => Promise<JsonFileRead> = readJsonFile,
): Promise<DeployGateDecision> {
  const reasons: string[] = []
  const read = await readGateDocument(gateFilePath(input.stateDir))
  const nowMonotonicMs = input.monotonicNowMs()
  if (!read.present) {
    if (input.requirePresent === true) {
      return { admit: false, present: false, document: null, ageMs: null, reasons: ['gate-absent'] }
    }
    return { admit: true, present: false, document: null, ageMs: null, reasons: [] }
  }
  if (!read.valid) {
    return { admit: false, present: true, document: null, ageMs: null, reasons: [`gate-unreadable: ${read.error}`] }
  }
  const document = parseGateDocument(read.value)
  if (!document) {
    return { admit: false, present: true, document: null, ageMs: null, reasons: ['gate-malformed'] }
  }
  const ageMs = nowMonotonicMs - document.issuedAtMonotonicMs
  if (ageMs < 0) reasons.push('gate-clock-reset')
  if (ageMs > document.ttlMs) reasons.push('stale-gate')
  if (ageMs > input.maximumDecisionAgeMs) reasons.push('gate-decision-too-old')
  if (input.lastSeenSeq !== undefined && document.seq <= input.lastSeenSeq) reasons.push('gate-seq-not-advancing')
  if (document.state === 'closed') reasons.push(...(document.reasons.length ? document.reasons : ['gate-closed']))
  return {
    admit: reasons.length === 0,
    present: true,
    document,
    ageMs,
    reasons: Object.freeze(reasons),
  }
}
