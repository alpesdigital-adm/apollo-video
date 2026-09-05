import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  LegacyRuntimeAuditResult,
  MulticamLongformCriterionEvidenceInput,
  MulticamLongformGateReport,
} from '../../domain/multicam-longform-gate.ts'

/**
 * What the gate reader is allowed to be told: a project, and at most a session
 * to narrow the capture-side criteria to. Nothing else. Every other input the
 * evaluation uses is a row the reader fetched itself.
 */
export interface MulticamLongformGateEvidenceQuery {
  workspaceId: string
  projectId: string
  sessionId: string | null
}

export interface MulticamLongformGateEvidenceContext {
  /** The session the capture criteria were read against, when one was found. */
  resolvedSessionId: string | null
  /** The project version the project-side criteria were read against. */
  projectVersionId: string | null
  projectVersionHash: string | null
  evidence: readonly MulticamLongformCriterionEvidenceInput[]
}

export interface PersistedMulticamLongformGate {
  schemaVersion: 'multicam-longform-gate/v1'
  id: string
  workspaceId: string
  projectId: string
  sessionId: string | null
  projectVersionId: string | null
  projectVersionHash: string | null
  report: Readonly<MulticamLongformGateReport>
  reportFingerprint: string
  idempotencyKey: string
  requestFingerprint: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  recordHash: string
}

export interface MulticamLongformGateRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedMulticamLongformGate> | null>
  /**
   * Read every persisted row the ten criteria depend on and turn each into a
   * check result. Returns `null` when the project does not exist in the
   * workspace — "no project" is a different answer from "no evidence".
   */
  readEvidence(
    input: Readonly<MulticamLongformGateEvidenceQuery>,
  ): Promise<Readonly<MulticamLongformGateEvidenceContext> | null>
  persist(
    gate: Readonly<PersistedMulticamLongformGate>,
    authenticationAudit: Readonly<ApiAccessAuditContext>,
  ): Promise<
    Readonly<{
      gate: Readonly<PersistedMulticamLongformGate>
      replayed: boolean
    }>
  >
  read(input: {
    workspaceId: string
    projectId: string
    gateId: string
  }): Promise<Readonly<PersistedMulticamLongformGate> | null>
  readLatest(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<PersistedMulticamLongformGate> | null>
  list(input: {
    workspaceId: string
    projectId: string
    limit: number
  }): Promise<readonly Readonly<PersistedMulticamLongformGate>[]>
}

/**
 * Criterion 10's evidence producer. It is a port rather than a repository
 * method because "does the code import legacy runtime" is answered by reading
 * the module graph, not by reading PostgreSQL, and the gate must be able to
 * run against a scanner fake in a unit test.
 */
export interface LegacyRuntimeAuditPort {
  audit(): Promise<Readonly<LegacyRuntimeAuditResult>>
}
