import {
  MULTICAM_LONGFORM_CRITERION_CHECKS,
  MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES,
  type MulticamLongformCriterion,
  type MulticamLongformEvidenceResourceType,
  type MulticamLongformGateReport,
} from '../domain/multicam-longform-gate.ts'
import type {
  explainMulticamLongformGateService,
  listMulticamLongformGateCriteria,
} from '../application/multicam-longform-gate.ts'
import type { PersistedMulticamLongformGate } from '../application/ports/multicam-longform-gate-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { exactFields, record } from './capture-derivation-contract.ts'

/**
 * F4.016 — the boundary of the multicamera/long-form phase gate.
 *
 * There is exactly one thing a caller may say here, and it is not evidence: the
 * project, in the path, and at most the session to narrow the capture-side
 * criteria to. Every measurement, every hash, every verdict and the approval
 * itself are read from PostgreSQL by the evaluator. So this module has no
 * parser for a score, a criterion result, an evidence ref or an approval — not
 * because sending one is discouraged, but because there is no shape in which it
 * could be expressed, and `exactFields` names any key that tried.
 *
 * On the way out, three things are preserved that a presenter could easily
 * flatten away, and each one changes what a reader would do next:
 *
 * - **`null` is not zero, and "missing" is not "failed".** A criterion nobody
 *   answered carries `neverEvaluated: true` and its checks say
 *   `evidence-missing`; a criterion that read rows and refused says
 *   `requirement-unmet`. One is work nobody has started, the other is work that
 *   came back negative.
 * - **An unverified reference is not an unhashed one.** `unverifiedReferenceCount`
 *   is tampering — a hash that was recomputed and disagreed.
 *   `unhashedReferenceCount` is a table that stores no hash of its own, so there
 *   was nothing to recompute. One number for both would let a row somebody
 *   edited hide behind a media artifact nobody downloaded.
 * - **Every criterion is published, including the ones that passed.** ADR-135's
 *   sentence is that each condition is independently visible; a response that
 *   listed only failures would be the aggregated boolean the gate exists to
 *   refuse.
 *
 * Two fields of the stored record are deliberately not published: the caller's
 * `idempotencyKey` and the `requestFingerprint` derived from it and the whole
 * actor context. Both belong to one request by one credential, and neither
 * tells a reader of the history anything about the gate; the record's identity
 * to a reader is `id` plus `recordHash`.
 */

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{2,127}$/
const RESOURCE_TYPES = new Set<string>(MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES)

/** Every check code, once, whichever criteria share it. */
export const MULTICAM_LONGFORM_CHECK_CODES = Object.freeze([
  ...new Set(
    Object.values(MULTICAM_LONGFORM_CRITERION_CHECKS).flatMap((codes) => [...codes]),
  ),
])

export interface EvaluateMulticamLongformGateBody {
  sessionId?: string
}

/**
 * The request body of an evaluation.
 *
 * `sessionId` narrows the five capture-side criteria to one session; leaving it
 * out lets the reader answer with whichever session the criteria read, and the
 * record says which one it judged rather than echoing what it was asked. Note
 * what the value is: a filter, never an assertion. A session the project does
 * not have is not an error here — the evaluation records `sessionId: null` and
 * the capture criteria fail for want of evidence, which is the honest answer.
 */
export function parseEvaluateMulticamLongformGateBody(
  input: unknown,
): EvaluateMulticamLongformGateBody {
  const body = record(input, 'body')
  exactFields(body, ['sessionId'], 'body')
  if (body.sessionId === undefined) return Object.freeze({})
  if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId.trim())) {
    throw new DomainError('INVALID_ARGUMENT', 'sessionId is invalid')
  }
  return Object.freeze({ sessionId: body.sessionId.trim() })
}

function presentReference(
  reference: Readonly<{
    type: MulticamLongformEvidenceResourceType
    id: string
    hash: string | null
    verified: boolean
  }>,
) {
  return Object.freeze({
    type: reference.type,
    id: reference.id,
    // Null means the table stores no hash of its own — a media artifact whose
    // sha256 would need a download, a child row its parent's hash covers. It
    // does not mean the hash was checked and came back empty.
    hash: reference.hash,
    verified: reference.verified,
  })
}

function presentReport(report: Readonly<MulticamLongformGateReport>) {
  return Object.freeze({
    schemaVersion: report.schemaVersion,
    gate: report.gate,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    sessionId: report.sessionId,
    approved: report.approved,
    satisfied: report.satisfied,
    evaluated: report.evaluated,
    total: report.total,
    failed: [...report.failed],
    blocking: report.blocking.map((entry) =>
      Object.freeze({
        criterion: entry.criterion,
        check: entry.check,
        reason: entry.reason,
        detail: entry.detail,
      })),
    serverEvidenceOnly: report.serverEvidenceOnly,
    criteria: report.criteria.map((criterion) =>
      Object.freeze({
        criterion: criterion.criterion,
        source: criterion.source,
        automatic: criterion.automatic,
        passed: criterion.passed,
        checkCount: criterion.checkCount,
        failedCheckCount: criterion.failedCheckCount,
        missingCheckCount: criterion.missingCheckCount,
        unverifiedReferenceCount: criterion.unverifiedReferenceCount,
        unhashedReferenceCount: criterion.unhashedReferenceCount,
        checks: criterion.checks.map((check) =>
          Object.freeze({
            code: check.code,
            passed: check.passed,
            failureReason: check.failureReason,
            detail: check.detail,
            references: check.references.map(presentReference),
          })),
      })),
    evaluatedAt: report.evaluatedAt,
    fingerprint: report.fingerprint,
  })
}

export function presentMulticamLongformGate(
  gate: Readonly<PersistedMulticamLongformGate>,
) {
  return Object.freeze({
    schemaVersion: gate.schemaVersion,
    id: gate.id,
    workspaceId: gate.workspaceId,
    projectId: gate.projectId,
    // The session the reader resolved, which may be null even when the request
    // named one: the record says what it judged, not what it was asked.
    sessionId: gate.sessionId,
    projectVersionId: gate.projectVersionId,
    projectVersionHash: gate.projectVersionHash,
    report: presentReport(gate.report),
    reportFingerprint: gate.reportFingerprint,
    createdBy: Object.freeze({ type: gate.createdBy.type, id: gate.createdBy.id }),
    createdAt: gate.createdAt,
    recordHash: gate.recordHash,
  })
}

export function presentMulticamLongformGateEvaluated(
  result: Readonly<{
    gate: Readonly<PersistedMulticamLongformGate>
    replayed: boolean
  }>,
) {
  return Object.freeze({
    gate: presentMulticamLongformGate(result.gate),
    replayed: result.replayed,
  })
}

export function presentMulticamLongformGateRead(
  gate: Readonly<PersistedMulticamLongformGate>,
) {
  return Object.freeze({ gate: presentMulticamLongformGate(gate) })
}

export function presentMulticamLongformGateHistory(
  gates: readonly Readonly<PersistedMulticamLongformGate>[],
) {
  return Object.freeze({ gates: gates.map(presentMulticamLongformGate) })
}

export function presentMulticamLongformGateCriteria(
  criteria: ReturnType<typeof listMulticamLongformGateCriteria>,
) {
  return Object.freeze({
    gate: 'multicam-longform/v1' as const,
    total: criteria.length,
    criteria: criteria.map((entry) =>
      Object.freeze({
        criterion: entry.criterion,
        statement: entry.statement,
        checks: [...entry.checks],
      })),
  })
}

export function presentMulticamLongformGateOutstanding(
  explained: Awaited<
    ReturnType<ReturnType<typeof explainMulticamLongformGateService>>
  >,
) {
  return Object.freeze({
    gateId: explained.gateId,
    evaluatedAt: explained.evaluatedAt,
    gate: explained.gate,
    approved: explained.approved,
    satisfied: explained.satisfied,
    total: explained.total,
    outstanding: explained.outstanding.map((entry) =>
      Object.freeze({
        criterion: entry.criterion,
        statement: entry.statement,
        // "Nobody ran it" and "it ran and said no" are different work, and the
        // order the service produced puts the first kind first.
        neverEvaluated: entry.neverEvaluated,
        missingCheckCount: entry.missingCheckCount,
        failedCheckCount: entry.failedCheckCount,
        unverifiedReferenceCount: entry.unverifiedReferenceCount,
        unhashedReferenceCount: entry.unhashedReferenceCount,
        blocking: entry.blocking.map((blocker) =>
          Object.freeze({
            check: blocker.check,
            reason: blocker.reason,
            detail: blocker.detail,
          })),
      })),
  })
}

export function resourceTypeParameter(
  value: string | null,
  field: string,
): MulticamLongformEvidenceResourceType | undefined {
  if (value === null) return undefined
  if (!RESOURCE_TYPES.has(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is not an evidence resource type`)
  }
  return value as MulticamLongformEvidenceResourceType
}

/**
 * The artifacts one evaluation read, addressed so a reader can go and open them.
 *
 * Nothing is re-read here and nothing is re-derived: these are the references
 * the evaluation itself recorded, deduplicated across the checks that cited
 * them, each carrying the criteria and checks it answered. A reference appears
 * once per `type:id:hash`, so the same media artifact cited by three checks is
 * one row with three citations rather than three rows a reader has to reconcile.
 *
 * `filteredOut` and `omittedArtifacts` travel with the list, because a narrowed
 * or truncated set of artifacts that reads as complete is an argument that the
 * gate looked at less than it did.
 */
export function presentMulticamLongformGateArtifacts(
  gate: Readonly<PersistedMulticamLongformGate>,
  options: Readonly<{
    type?: MulticamLongformEvidenceResourceType
    limit: number
  }>,
) {
  const collected = new Map<
    string,
    {
      type: MulticamLongformEvidenceResourceType
      id: string
      hash: string | null
      verified: boolean
      citedBy: { criterion: MulticamLongformCriterion; check: string; passed: boolean }[]
    }
  >()
  for (const criterion of gate.report.criteria) {
    for (const check of criterion.checks) {
      for (const reference of check.references) {
        const key = `${reference.type}:${reference.id}:${reference.hash ?? ''}`
        const citation = {
          criterion: criterion.criterion,
          check: check.code as string,
          passed: check.passed,
        }
        const existing = collected.get(key)
        if (existing) {
          existing.citedBy.push(citation)
          continue
        }
        collected.set(key, {
          type: reference.type,
          id: reference.id,
          hash: reference.hash,
          verified: reference.verified,
          citedBy: [citation],
        })
      }
    }
  }
  const all = [...collected.values()]
  const matching = options.type === undefined
    ? all
    : all.filter((entry) => entry.type === options.type)
  const kept = matching.slice(0, options.limit)
  return Object.freeze({
    gateId: gate.id,
    evaluatedAt: gate.report.evaluatedAt,
    approved: gate.report.approved,
    artifacts: kept.map((entry) =>
      Object.freeze({
        type: entry.type,
        id: entry.id,
        hash: entry.hash,
        verified: entry.verified,
        citedBy: entry.citedBy.map((citation) =>
          Object.freeze({
            criterion: citation.criterion,
            check: citation.check,
            passed: citation.passed,
          })),
      })),
    // A reference whose hash was recomputed and disagreed. Counted apart from
    // the ones that carry no hash at all: the first forbids a check from
    // passing, the second only says nothing could be recomputed.
    unverifiedCount: kept.filter((entry) => entry.hash !== null && !entry.verified).length,
    unhashedCount: kept.filter((entry) => entry.hash === null).length,
    filteredOut: all.length - matching.length,
    omittedArtifacts: matching.length - kept.length,
  })
}
