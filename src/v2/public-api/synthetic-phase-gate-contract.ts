import type { PersistedSyntheticPhaseGate } from '../application/ports/synthetic-phase-gate-repository.ts'
import type { SyntheticPhaseGateReport } from '../application/run-synthetic-phase-gate.ts'
import {
  SYNTHETIC_PHASE_GATE_CRITERION_CHECKS,
} from '../domain/synthetic-phase-gate.ts'
import { exactFields, record, sha256 } from './capture-derivation-contract.ts'
import { publicIdentifier } from './conventions.ts'

/** Every check code, once, in the order the domain evaluates it. */
export const SYNTHETIC_PHASE_GATE_CHECK_CODES = Object.freeze([
  ...new Set(Object.values(SYNTHETIC_PHASE_GATE_CRITERION_CHECKS).flatMap((codes) => [...codes])),
])

export interface RunSyntheticPhaseGateBody {
  projectVersionId: string
  projectVersionHash: string
}

/**
 * The caller identifies the immutable project version to judge. Evidence,
 * check results and approval are deliberately absent: the repository derives
 * all of them from server-owned rows and trusted attestations.
 */
export function parseRunSyntheticPhaseGateBody(input: unknown): RunSyntheticPhaseGateBody {
  const body = record(input, 'body')
  exactFields(body, ['projectVersionId', 'projectVersionHash'], 'body')
  return Object.freeze({
    projectVersionId: publicIdentifier(body.projectVersionId, 'projectVersionId'),
    projectVersionHash: sha256(body.projectVersionHash, 'projectVersionHash'),
  })
}

function presentReport(report: Readonly<SyntheticPhaseGateReport>) {
  return Object.freeze({
    schemaVersion: report.schemaVersion,
    gate: report.gate,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    projectVersionId: report.projectVersionId,
    projectVersionHash: report.projectVersionHash,
    approved: report.approved,
    covered: report.covered,
    passed: report.passed,
    total: report.total,
    missing: [...report.missing],
    failed: [...report.failed],
    serverEvidenceOnly: report.serverEvidenceOnly,
    evidence: report.evidence.map((criterion) => Object.freeze({
      criterion: criterion.criterion,
      source: criterion.source,
      automatic: criterion.automatic,
      passed: criterion.passed,
      missingChecks: [...criterion.missingChecks],
      checks: criterion.checks.map((check) => Object.freeze({
        code: check.code,
        passed: check.passed,
        missingEvidenceTypes: [...check.missingEvidenceTypes],
        references: check.references.map((reference) => Object.freeze({
          type: reference.type,
          id: reference.id,
          hash: reference.hash,
        })),
      })),
    })),
    evaluatedAt: report.evaluatedAt,
    fingerprint: report.fingerprint,
  })
}

export function presentSyntheticPhaseGate(gate: Readonly<PersistedSyntheticPhaseGate>) {
  return Object.freeze({
    schemaVersion: gate.schemaVersion,
    id: gate.id,
    workspaceId: gate.workspaceId,
    projectId: gate.projectId,
    projectVersionId: gate.projectVersionId,
    projectVersionHash: gate.projectVersionHash,
    report: presentReport(gate.report),
    reportFingerprint: gate.reportFingerprint,
    createdBy: Object.freeze({ type: gate.createdBy.type, id: gate.createdBy.id }),
    createdAt: gate.createdAt,
    recordHash: gate.recordHash,
  })
}

export function presentSyntheticPhaseGateRun(result: Readonly<{
  gate: Readonly<PersistedSyntheticPhaseGate>
  replayed: boolean
}>) {
  return Object.freeze({
    gate: presentSyntheticPhaseGate(result.gate),
    replayed: result.replayed,
  })
}

export function presentSyntheticPhaseGateList(
  gates: readonly Readonly<PersistedSyntheticPhaseGate>[],
) {
  return Object.freeze({ gates: gates.map(presentSyntheticPhaseGate) })
}
