import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  CONFIDENCE_BAND_POLICY_V2,
  CONFIDENCE_BAND_POLICY_V2_SHA256,
  EVIDENCE_TIERS,
  type ConfidenceBand,
  type EvidenceGatedDecisionType,
  type EvidenceTier,
} from './decision-confidence.ts'
import {
  DIRECTOR_EVIDENCE_RUBRIC,
  DIRECTOR_EVIDENCE_RUBRIC_SHA256,
  assessPerceptionModality,
  type DecisionPerceptionEvidence,
  type FaceEvidenceRequestState,
  type ModalityAssessment,
  type SourceRightsVerdict,
} from './director-evidence-rubric.ts'
import { DomainError } from './errors.ts'
import { PERCEPTION_KINDS, type PerceptionCoverageState, type PerceptionKind } from './perception-timeline.ts'
import { serverPerceptionSnapshotId, type ServerPerceptionSnapshot } from './server-perception-snapshot.ts'

/**
 * W64. What the Director's critic reports about the perception its plan stood on, sealed inside the quality report
 * (`director-quality-report/v4`):
 *
 * - the server perception snapshot it assessed (id and hash: the very row the commit writes), and the per-kind coverage of it;
 * - the two policies that graded it, by hash (`confidence-band-policy/v2` and the evidence rubric);
 * - the tier of every perception kind over the whole timeline, each with the sealed envelopes and observations it stands on;
 * - the rights verdict of every source the plan plays (integral: any source that is not certain is a block);
 * - the face windows the plan needs, which sealed windows already satisfy them, and which the Director requested (with the operation
 *   each request created or replayed);
 * - a digest of every crop, caption and insert decision: its tier, its band, the hash of the evidence record the decision carries.
 *
 * It is evidence for the reader and for the oracle, not a second opinion: the bands are the policy's, the tiers are the rubric's.
 */
export const FACE_WINDOW_REQUEST_REPORT_ENTRY_CAP = 300
export const DIRECTOR_FACE_WINDOW_REQUEST_LIMIT = 200

export type FaceWindowRequestState = 'satisfied' | 'requested' | 'refused' | 'deferred'
export type FaceWindowRequestEntry = Readonly<{
  sourceArtifactId: string
  startSourceFrame: number
  endSourceFrame: number
  state: FaceWindowRequestState
  /** The operation the request created (or replayed); null for a window that was not requested. */
  operationId: string | null
  idempotencyKey: string | null
  replayed: boolean | null
  /** Why a window was refused or deferred. */
  reasonCode: string | null
}>

export type FaceWindowRequestReport = Readonly<{
  schemaVersion: 'director-face-window-requests/v1'
  /** `not-configured`: this Director had no way to request windows; `timeline-unsupported`: the EditPlan's clock or clips cannot be mapped to source windows. */
  status: 'planned' | 'not-configured' | 'timeline-unsupported'
  reasonCode: string | null
  requiredCount: number
  satisfiedCount: number
  requestedCount: number
  refusedCount: number
  deferredCount: number
  requestLimit: number
  entries: readonly FaceWindowRequestEntry[]
  entriesTruncated: boolean
}>

export type DirectorEvidenceCoverageEntry = Readonly<{
  kind: PerceptionKind
  state: PerceptionCoverageState
  examinedMs: number
  durationMs: number
  reasonCode: string | null
}>

export type DirectorEvidenceDecisionDigest = Readonly<{
  decisionId: string
  decisionType: EvidenceGatedDecisionType
  tier: EvidenceTier
  band: ConfidenceBand
  confidence: number
  evidenceHash: string
  reasonCodes: readonly string[]
}>

export type DirectorPerceptionEvidenceReport = Readonly<{
  schemaVersion: 'director-perception-evidence/v1'
  snapshot: Readonly<{ id: string; snapshotHash: string; projectVersionId: string; timelineHash: string; durationMs: number }>
  policy: Readonly<{
    bandPolicy: Readonly<{ schemaVersion: 'confidence-band-policy/v2'; policyHash: string }>
    rubric: Readonly<{ schemaVersion: 'director-evidence-rubric/v1'; rubricHash: string }>
  }>
  coverage: readonly DirectorEvidenceCoverageEntry[]
  modalities: readonly ModalityAssessment[]
  rights: Readonly<{ certain: boolean; sources: readonly SourceRightsVerdict[] }>
  faceWindows: FaceWindowRequestReport
  decisions: readonly DirectorEvidenceDecisionDigest[]
  evidenceHash: string
}>

export function emptyFaceWindowRequestReport(status: FaceWindowRequestReport['status'], reasonCode: string | null): FaceWindowRequestReport {
  return Object.freeze({
    schemaVersion: 'director-face-window-requests/v1' as const, status, reasonCode, requiredCount: 0, satisfiedCount: 0,
    requestedCount: 0, refusedCount: 0, deferredCount: 0, requestLimit: DIRECTOR_FACE_WINDOW_REQUEST_LIMIT,
    entries: Object.freeze([]), entriesTruncated: false,
  })
}

export function createFaceWindowRequestReport(input: Readonly<{
  entries: readonly FaceWindowRequestEntry[]
  reasonCode?: string | null
  status?: FaceWindowRequestReport['status']
}>): FaceWindowRequestReport {
  const count = (state: FaceWindowRequestState) => input.entries.filter((entry) => entry.state === state).length
  const ordered = input.entries.toSorted((left, right) =>
    left.sourceArtifactId < right.sourceArtifactId ? -1 : left.sourceArtifactId > right.sourceArtifactId ? 1
      : left.startSourceFrame - right.startSourceFrame || left.endSourceFrame - right.endSourceFrame)
  return Object.freeze({
    schemaVersion: 'director-face-window-requests/v1' as const,
    status: input.status ?? 'planned' as const,
    reasonCode: input.reasonCode ?? null,
    requiredCount: input.entries.length,
    satisfiedCount: count('satisfied'), requestedCount: count('requested'), refusedCount: count('refused'), deferredCount: count('deferred'),
    requestLimit: DIRECTOR_FACE_WINDOW_REQUEST_LIMIT,
    entries: Object.freeze(ordered.slice(0, FACE_WINDOW_REQUEST_REPORT_ENTRY_CAP)),
    entriesTruncated: ordered.length > FACE_WINDOW_REQUEST_REPORT_ENTRY_CAP,
  })
}

export function createDirectorPerceptionEvidenceReport(input: Readonly<{
  snapshot: Readonly<ServerPerceptionSnapshot>
  rights: readonly SourceRightsVerdict[]
  faceWindows: FaceWindowRequestReport
  faceRequests: FaceEvidenceRequestState
  decisions: readonly DirectorEvidenceDecisionDigest[]
}>): DirectorPerceptionEvidenceReport {
  const { snapshot } = input
  const whole = [[0, snapshot.timeline.durationMs] as const]
  const body = {
    schemaVersion: 'director-perception-evidence/v1' as const,
    snapshot: Object.freeze({ id: serverPerceptionSnapshotId(snapshot.snapshotHash), snapshotHash: snapshot.snapshotHash,
      projectVersionId: snapshot.projectVersionId, timelineHash: snapshot.timeline.timelineHash, durationMs: snapshot.timeline.durationMs }),
    policy: Object.freeze({
      bandPolicy: Object.freeze({ schemaVersion: CONFIDENCE_BAND_POLICY_V2.schemaVersion, policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256 }),
      rubric: Object.freeze({ schemaVersion: DIRECTOR_EVIDENCE_RUBRIC.schemaVersion, rubricHash: DIRECTOR_EVIDENCE_RUBRIC_SHA256 }),
    }),
    coverage: Object.freeze(snapshot.timeline.coverage.map((entry) => Object.freeze({
      kind: entry.kind, state: entry.state, examinedMs: entry.observedMs, durationMs: snapshot.timeline.durationMs,
      reasonCode: entry.reasonCode ?? null,
    }))),
    modalities: Object.freeze(PERCEPTION_KINDS.map((kind) => assessPerceptionModality(snapshot, kind, whole, input.faceRequests))),
    rights: Object.freeze({
      certain: input.rights.length > 0 && input.rights.every((verdict) => verdict.certain),
      sources: Object.freeze(input.rights.toSorted((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0)),
    }),
    faceWindows: input.faceWindows,
    decisions: Object.freeze(input.decisions.toSorted((left, right) => left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0)),
  }
  return Object.freeze({ ...body, evidenceHash: calculateCanonicalHash(body) })
}

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${label} is invalid`)
  }
  return value as Record<string, unknown>
}
function exactKeys(item: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Object.keys(item).sort().join('|') !== [...keys].sort().join('|')) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${label} has unexpected fields`)
  }
}
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function parseFaceWindowReport(value: unknown): FaceWindowRequestReport {
  const item = recordOf(value, 'face window request report')
  exactKeys(item, ['schemaVersion', 'status', 'reasonCode', 'requiredCount', 'satisfiedCount', 'requestedCount', 'refusedCount',
    'deferredCount', 'requestLimit', 'entries', 'entriesTruncated'], 'face window request report')
  if (item.schemaVersion !== 'director-face-window-requests/v1' ||
      !['planned', 'not-configured', 'timeline-unsupported'].includes(String(item.status)) ||
      !(item.reasonCode === null || (typeof item.reasonCode === 'string' && REASON.test(item.reasonCode))) ||
      ![item.requiredCount, item.satisfiedCount, item.requestedCount, item.refusedCount, item.deferredCount].every(nonNegative) ||
      item.requestLimit !== DIRECTOR_FACE_WINDOW_REQUEST_LIMIT ||
      typeof item.entriesTruncated !== 'boolean' || !Array.isArray(item.entries) || item.entries.length > FACE_WINDOW_REQUEST_REPORT_ENTRY_CAP) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored face window request report is invalid')
  }
  const entries = item.entries.map((entry): FaceWindowRequestEntry => {
    const e = recordOf(entry, 'face window request entry')
    exactKeys(e, ['sourceArtifactId', 'startSourceFrame', 'endSourceFrame', 'state', 'operationId', 'idempotencyKey', 'replayed', 'reasonCode'], 'face window request entry')
    if (typeof e.sourceArtifactId !== 'string' || !ID.test(e.sourceArtifactId) || !nonNegative(e.startSourceFrame) ||
        !nonNegative(e.endSourceFrame) || (e.endSourceFrame as number) <= (e.startSourceFrame as number) ||
        !['satisfied', 'requested', 'refused', 'deferred'].includes(String(e.state)) ||
        !(e.operationId === null || (typeof e.operationId === 'string' && ID.test(e.operationId))) ||
        !(e.idempotencyKey === null || (typeof e.idempotencyKey === 'string' && e.idempotencyKey.length > 0 && e.idempotencyKey.length <= 128)) ||
        !(e.replayed === null || typeof e.replayed === 'boolean') ||
        !(e.reasonCode === null || (typeof e.reasonCode === 'string' && REASON.test(e.reasonCode))) ||
        // A requested window names the operation that carries it; a window nobody requested names none.
        ((e.state === 'requested') !== (e.operationId !== null)) ||
        ((e.state === 'requested') !== (e.idempotencyKey !== null)) ||
        ((e.state === 'refused' || e.state === 'deferred') && e.reasonCode === null)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored face window request entry is invalid')
    }
    return Object.freeze(e) as unknown as FaceWindowRequestEntry
  })
  const count = (state: FaceWindowRequestState) => entries.filter((entry) => entry.state === state).length
  if (!item.entriesTruncated && (
    item.requiredCount !== entries.length || item.satisfiedCount !== count('satisfied') || item.requestedCount !== count('requested') ||
    item.refusedCount !== count('refused') || item.deferredCount !== count('deferred'))) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored face window request counts disagree with its entries')
  }
  return Object.freeze({ ...item, entries: Object.freeze(entries) }) as unknown as FaceWindowRequestReport
}

function parseModalityList(value: unknown): readonly ModalityAssessment[] {
  if (!Array.isArray(value) || value.length !== PERCEPTION_KINDS.length) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence does not assess every kind')
  }
  return Object.freeze(value.map((entry) => Object.freeze(entry)) as unknown as ModalityAssessment[])
}

/**
 * Re-reads a stored perception evidence report: structure, seal, policies, and the consistency the report can prove by itself (the
 * face tier never `high`, rights integral, a digest's band the policy's band for its tier). The figures are re-derived against the
 * stored snapshot by `verifyDirectorEvidenceReportAgainstSnapshot`.
 */
export function parseDirectorPerceptionEvidenceReport(value: unknown): DirectorPerceptionEvidenceReport {
  const item = recordOf(value, 'perception evidence report')
  exactKeys(item, ['schemaVersion', 'snapshot', 'policy', 'coverage', 'modalities', 'rights', 'faceWindows', 'decisions', 'evidenceHash'], 'perception evidence report')
  if (item.schemaVersion !== 'director-perception-evidence/v1') {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence report has an unknown schema')
  }
  const snapshot = recordOf(item.snapshot, 'perception evidence snapshot')
  exactKeys(snapshot, ['id', 'snapshotHash', 'projectVersionId', 'timelineHash', 'durationMs'], 'perception evidence snapshot')
  if (typeof snapshot.snapshotHash !== 'string' || !HASH.test(snapshot.snapshotHash) ||
      snapshot.id !== serverPerceptionSnapshotId(snapshot.snapshotHash) || typeof snapshot.timelineHash !== 'string' ||
      !HASH.test(snapshot.timelineHash) || typeof snapshot.projectVersionId !== 'string' || !ID.test(snapshot.projectVersionId) ||
      !nonNegative(snapshot.durationMs) || snapshot.durationMs === 0) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence names an invalid snapshot')
  }
  const policy = recordOf(item.policy, 'perception evidence policy')
  exactKeys(policy, ['bandPolicy', 'rubric'], 'perception evidence policy')
  const bandPolicy = recordOf(policy.bandPolicy, 'perception evidence band policy')
  const rubric = recordOf(policy.rubric, 'perception evidence rubric')
  if (bandPolicy.schemaVersion !== CONFIDENCE_BAND_POLICY_V2.schemaVersion || bandPolicy.policyHash !== CONFIDENCE_BAND_POLICY_V2_SHA256 ||
      rubric.schemaVersion !== DIRECTOR_EVIDENCE_RUBRIC.schemaVersion || rubric.rubricHash !== DIRECTOR_EVIDENCE_RUBRIC_SHA256) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence was graded by a policy this build does not know')
  }
  if (!Array.isArray(item.coverage) || item.coverage.length !== PERCEPTION_KINDS.length ||
      item.coverage.some((entry, index) => {
        const e = entry as Record<string, unknown>
        return typeof e !== 'object' || e === null || e.kind !== PERCEPTION_KINDS[index] || !['absent', 'partial', 'complete'].includes(String(e.state)) ||
          !nonNegative(e.examinedMs) || e.durationMs !== snapshot.durationMs ||
          (e.state === 'absent') !== (e.examinedMs === 0) || (e.state === 'complete') !== (e.examinedMs === e.durationMs) ||
          !(e.reasonCode === null || (typeof e.reasonCode === 'string' && REASON.test(e.reasonCode)))
      })) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence coverage is invalid')
  }
  const modalities = parseModalityList(item.modalities)
  modalities.forEach((entry, index) => {
    if (entry.modality !== PERCEPTION_KINDS[index] || entry.rangeMs !== snapshot.durationMs ||
        (entry.modality === 'face' && entry.tier === 'high') || (entry.tier === 'absent') !== (entry.examinedMs === 0)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence modality is invalid')
    }
  })
  const rights = recordOf(item.rights, 'perception evidence rights')
  exactKeys(rights, ['certain', 'sources'], 'perception evidence rights')
  if (typeof rights.certain !== 'boolean' || !Array.isArray(rights.sources) || rights.sources.length > 64 ||
      rights.sources.some((source) => {
        const s = source as Record<string, unknown>
        return typeof s !== 'object' || s === null || Object.keys(s).sort().join('|') !== 'artifactId|certain|reasonCode|snapshotHash|snapshotId' ||
          typeof s.artifactId !== 'string' || typeof s.certain !== 'boolean' || typeof s.reasonCode !== 'string' || !REASON.test(s.reasonCode)
      }) ||
      // Rights are integral: certain only when there is at least one source and every one of them is certain.
      rights.certain !== (rights.sources.length > 0 && rights.sources.every((source) => (source as Record<string, unknown>).certain === true))) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence rights are not integral')
  }
  const faceWindows = parseFaceWindowReport(item.faceWindows)
  if (!Array.isArray(item.decisions) || item.decisions.length > 64) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence decisions are invalid')
  }
  const decisions = item.decisions.map((entry): DirectorEvidenceDecisionDigest => {
    const d = recordOf(entry, 'perception evidence decision')
    exactKeys(d, ['decisionId', 'decisionType', 'tier', 'band', 'confidence', 'evidenceHash', 'reasonCodes'], 'perception evidence decision')
    if (typeof d.decisionId !== 'string' || !ID.test(d.decisionId) || !['crop', 'caption', 'insert'].includes(String(d.decisionType)) ||
        !(EVIDENCE_TIERS as readonly unknown[]).includes(d.tier) || !['auto-apply', 'review', 'block'].includes(String(d.band)) ||
        typeof d.confidence !== 'number' || !(d.confidence >= 0 && d.confidence <= 1) ||
        typeof d.evidenceHash !== 'string' || !HASH.test(d.evidenceHash) ||
        !Array.isArray(d.reasonCodes) || d.reasonCodes.some((code) => typeof code !== 'string' || !REASON.test(code)) ||
        // The one rule the digest can prove alone: absent evidence is never auto-apply.
        (d.tier === 'absent' && d.band === 'auto-apply')) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence decision digest is invalid')
    }
    return Object.freeze({ ...d, reasonCodes: Object.freeze([...d.reasonCodes as string[]]) }) as unknown as DirectorEvidenceDecisionDigest
  })
  const { evidenceHash, ...body } = item
  if (typeof evidenceHash !== 'string' || calculateCanonicalHash(body) !== evidenceHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored perception evidence report hash is invalid')
  }
  return Object.freeze({ ...item, snapshot: Object.freeze({ ...snapshot }), modalities, faceWindows, decisions: Object.freeze(decisions),
    coverage: Object.freeze((item.coverage as unknown[]).map((entry) => Object.freeze(entry))) }) as unknown as DirectorPerceptionEvidenceReport
}

export function digestOfDecisionEvidence(
  evidence: DecisionPerceptionEvidence, band: ConfidenceBand, confidence: number,
): DirectorEvidenceDecisionDigest {
  return Object.freeze({
    decisionId: evidence.decisionId, decisionType: evidence.decisionType, tier: evidence.tier, band, confidence,
    evidenceHash: evidence.evidenceHash,
    reasonCodes: Object.freeze([...new Set(evidence.modalities.filter((entry) => entry.tier !== 'high').map((entry) => entry.reasonCode))].toSorted()),
  })
}

/**
 * The oracle for the whole report: every figure re-derived from the stored snapshot, the stored rights and the stored face-request
 * state must give byte-identical modalities and coverage. A stored tier the snapshot does not support fails here.
 */
export function verifyDirectorEvidenceReportAgainstSnapshot(
  report: DirectorPerceptionEvidenceReport,
  snapshot: Readonly<ServerPerceptionSnapshot>,
  faceRequests: FaceEvidenceRequestState,
): void {
  if (snapshot.snapshotHash !== report.snapshot.snapshotHash || serverPerceptionSnapshotId(snapshot.snapshotHash) !== report.snapshot.id ||
      snapshot.timeline.timelineHash !== report.snapshot.timelineHash || snapshot.projectVersionId !== report.snapshot.projectVersionId) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Perception evidence report names another snapshot')
  }
  const whole = [[0, snapshot.timeline.durationMs] as const]
  for (const [index, kind] of PERCEPTION_KINDS.entries()) {
    const rebuilt = assessPerceptionModality(snapshot, kind, whole, faceRequests)
    if (calculateCanonicalHash(rebuilt) !== calculateCanonicalHash(report.modalities[index])) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Perception evidence for ${kind} is not what its snapshot supports`)
    }
    const coverage = snapshot.timeline.coverage.find((entry) => entry.kind === kind)!
    const stored = report.coverage[index]!
    if (stored.state !== coverage.state || stored.examinedMs !== coverage.observedMs || stored.reasonCode !== (coverage.reasonCode ?? null)) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Perception evidence coverage of ${kind} is not what its snapshot states`)
    }
  }
}

/**
 * What a stored run must agree with itself on: the report names the snapshot the run's perception names, states the coverage that
 * timeline states, carries a digest for exactly the evidence-gated decisions the run holds (same evidence seal, tier, band and
 * confidence), and every decision of the run was graded by the band policy the report names.
 */
export function assertDirectorRunEvidenceConsistency(input: Readonly<{
  evidence: DirectorPerceptionEvidenceReport
  baseVersionId: string
  perception: Readonly<{
    inputVersionId?: string
    serverSnapshot?: Readonly<{ snapshotHash: string }>
    timeline: Readonly<{ timelineHash: string; durationMs: number; coverage: readonly Readonly<{ kind: string; state: string; observedMs: number; reasonCode?: string }>[] }>
  }>
  decisions: readonly Readonly<{
    id: string
    confidence: number
    confidenceBand: string
    bandPolicy?: Readonly<{ schemaVersion: string; policyHash: string }>
    perceptionEvidence?: Readonly<{ decisionType: string; tier: string; evidenceHash: string }>
  }>[]
}>): void {
  const { evidence, perception, decisions } = input
  const conflict = (message: string): never => { throw new DomainError('PERSISTENCE_CONFLICT', message) }
  if (perception.serverSnapshot?.snapshotHash !== evidence.snapshot.snapshotHash ||
      perception.inputVersionId !== input.baseVersionId || evidence.snapshot.projectVersionId !== input.baseVersionId ||
      perception.timeline.timelineHash !== evidence.snapshot.timelineHash || perception.timeline.durationMs !== evidence.snapshot.durationMs) {
    conflict('The run perception and its quality report describe different snapshots')
  }
  for (const [index, entry] of evidence.coverage.entries()) {
    const stated = perception.timeline.coverage.find((item) => item.kind === entry.kind)
    if (!stated || perception.timeline.coverage[index]?.kind !== entry.kind || stated.state !== entry.state ||
        stated.observedMs !== entry.examinedMs || (stated.reasonCode ?? null) !== entry.reasonCode) {
      conflict(`The quality report coverage of ${entry.kind} is not the one of the run perception`)
    }
  }
  if (decisions.some((decision) => decision.bandPolicy?.schemaVersion !== evidence.policy.bandPolicy.schemaVersion ||
      decision.bandPolicy.policyHash !== evidence.policy.bandPolicy.policyHash)) {
    conflict('A decision of the run was not graded by the band policy its quality report names')
  }
  const gated = decisions.filter((decision) => decision.perceptionEvidence !== undefined)
  if (gated.length !== evidence.decisions.length) conflict('The quality report digests other decisions than the run holds')
  for (const decision of gated) {
    const digest = evidence.decisions.find((entry) => entry.decisionId === decision.id)
    if (!digest || digest.evidenceHash !== decision.perceptionEvidence!.evidenceHash || digest.tier !== decision.perceptionEvidence!.tier ||
        digest.decisionType !== decision.perceptionEvidence!.decisionType || digest.band !== decision.confidenceBand ||
        digest.confidence !== decision.confidence) {
      conflict(`The quality report digest of decision ${decision.id} is not what the decision carries`)
    }
  }
}
