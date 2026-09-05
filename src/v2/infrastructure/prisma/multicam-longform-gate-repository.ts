import {
  Prisma,
  type PrismaClient,
  type V2MulticamLongformGate,
  type V2MulticamLongformGateCheck,
  type V2MulticamLongformGateCriterion,
  type V2MulticamLongformGateEvidence,
} from '../../../../generated/prisma-v2/index.js'

import { calculateMulticamLongformGateRecordHash } from '../../application/multicam-longform-gate.ts'
import type {
  MulticamLongformGateEvidenceQuery,
  MulticamLongformGateRepository,
  PersistedMulticamLongformGate,
} from '../../application/ports/multicam-longform-gate-repository.ts'
import { RENDERABLE_PLAN_ORIGINS } from '../../application/renderable-edit-plan.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { COLOR_TRANSFORM_ORDER, resolveColorPlan } from '../../domain/color-and-export.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMulticamLongformGateReportIntegrity,
  MULTICAM_LONGFORM_CRITERION_CHECKS,
  MULTICAM_LONGFORM_GATE_ID,
  MULTICAM_LONGFORM_GATE_SCHEMA_VERSION,
  type MulticamLongformCheckCode,
  type MulticamLongformCheckEvidenceInput,
  type MulticamLongformCriterion,
  type MulticamLongformCriterionEvidenceInput,
  type MulticamLongformEvidenceReferenceInput,
  type MulticamLongformEvidenceResourceType,
  type MulticamLongformFailureReason,
  type MulticamLongformGateReport,
} from '../../domain/multicam-longform-gate.ts'
import { parseProjectColorPlan } from '../../domain/project-color-plan.ts'
import type { CaptureSession } from '../../domain/capture-session.ts'
import type { Rational } from '../../domain/session-time.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'
import { PrismaCaptureProtocolRepository } from './capture-protocol-repository.ts'
import { PrismaCaptureSessionRepository } from './capture-session-repository.ts'
import { PrismaColorCriticReportRepository } from './color-critic-report-repository.ts'
import { PrismaEditorialSynthesisRepository } from './editorial-synthesis-repository.ts'
import { PrismaMulticamDirectionRepository } from './multicam-direction-repository.ts'
import { PrismaMulticamMatchPlanRepository } from './multicam-match-plan-repository.ts'
import { PrismaPlaybackMapRepository } from './playback-map-repository.ts'
import { PrismaRenderablePlanSnapshotRepository } from './renderable-plan-snapshot-repository.ts'
import { PrismaSyncDiagnosticRepository } from './sync-diagnostic-repository.ts'

/**
 * The F4.016 gate's reader and writer.
 *
 * Every criterion is answered by going to PostgreSQL through the repository
 * that owns the aggregate, because those read paths re-derive the aggregate
 * and compare its hash. That is what makes "tampered evidence reproves the
 * criterion" true rather than aspirational: a row edited underneath the
 * product makes the owning repository raise `PERSISTENCE_CONFLICT`, which is
 * caught here and recorded as `evidence-unverified` on that criterion alone.
 *
 * Rows with no owning repository — the final export operation and its media
 * artifact — are read directly. Their manifest is re-hashed here; the media
 * bytes are not, so an artifact reference carries `hash: null` and says so,
 * rather than claiming a verification that would need a download.
 */

const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const SYNCED_STATUSES = new Set(['synced-high', 'synced-medium'])
const MANUAL_ACTIONS = new Set(['reshoot-with-marker', 'add-manual-anchor'])
const INTERRUPTED_MODES = new Set(['paused', 'rewind', 'replay', 'seek', 'commentary-only'])
const BLOCKING_CEILINGS = new Set(['manual-anchors-required', 'not-synchronizable'])
const RESOLVED_CRITIC_ACTIONS = new Set(['approve', 'bounded-correction'])
const PARTICIPANT_ROLES = new Set(['camera-main', 'camera-alt', 'phone', 'microphone', 'reaction'])
const SYNTHESIS_TARGET_MS = 120_000
const DURATION_TOLERANCE_SECONDS = 1

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function isPersistenceConflict(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
}

function truncate(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`
}

function ref(
  type: MulticamLongformEvidenceResourceType,
  id: string,
  hash: string | null,
  verified: boolean,
): MulticamLongformEvidenceReferenceInput {
  const usable = typeof hash === 'string' && SHA_256_PATTERN.test(hash) ? hash : null
  return { type, id, hash: usable, verified: usable === null ? false : verified }
}

function check(
  code: MulticamLongformCheckCode,
  passed: boolean,
  failureReason: MulticamLongformFailureReason | null,
  detail: string,
  references: readonly MulticamLongformEvidenceReferenceInput[],
): MulticamLongformCheckEvidenceInput {
  return {
    code,
    passed,
    failureReason: passed ? null : failureReason ?? 'requirement-unmet',
    detail: truncate(detail),
    references: [...references],
  }
}

/** Every check of a criterion, failed for the same reason. */
function criterionFailed(
  criterion: MulticamLongformCriterion,
  reason: MulticamLongformFailureReason,
  detail: string,
  references: readonly MulticamLongformEvidenceReferenceInput[],
): MulticamLongformCriterionEvidenceInput {
  return {
    criterion,
    checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
      check(code, false, reason, detail, references)),
  }
}

function seconds(ticks: bigint, secondsPerTick: Rational): number {
  return Number(ticks) * (Number(secondsPerTick.num) / Number(secondsPerTick.den))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid JSON`)
  }
}

/**
 * Re-hash a stored media manifest. The manifest's own hash covers everything
 * except itself (`createMediaArtifactManifestV1`), so removing it and hashing
 * the rest is the check the writer's own factory performs.
 */
function manifestVerified(row: { manifestJson: string; manifestHash: string }): boolean {
  const manifest = record(parseJson(row.manifestJson, 'media artifact manifest'))
  if (!manifest) return false
  const { manifestHash: embedded, ...body } = manifest
  return embedded === row.manifestHash &&
    calculateCanonicalHash(body) === row.manifestHash
}

function manifestProbe(row: { manifestJson: string }) {
  const manifest = record(parseJson(row.manifestJson, 'media artifact manifest'))
  const probe = record(manifest?.probe)
  const artifact = record(manifest?.artifact)
  const value = (field: string) =>
    typeof probe?.[field] === 'number' && Number.isFinite(probe[field]) && (probe[field] as number) > 0
      ? probe[field] as number
      : null
  return {
    width: value('width'),
    height: value('height'),
    fps: value('fps'),
    duration: value('duration'),
    container: typeof artifact?.container === 'string' ? artifact.container : null,
    mediaType: typeof artifact?.mediaType === 'string' ? artifact.mediaType : null,
  }
}

function hydrateGate(
  row: V2MulticamLongformGate,
): Readonly<PersistedMulticamLongformGate> {
  hydrateExternalActorAudit(row, row.createdById)
  const stored = record(parseJson(row.reportJson, 'multicam long-form gate report'))
  if (!stored || !Array.isArray(stored.criteria)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored multicam long-form gate report is invalid',
    )
  }
  let report: Readonly<MulticamLongformGateReport>
  try {
    report = assertMulticamLongformGateReportIntegrity(
      stored as unknown as MulticamLongformGateReport,
    )
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored multicam long-form gate report failed integrity validation',
    )
  }
  if (
    stableSerialize(report) !== row.reportJson ||
    report.fingerprint !== row.reportFingerprint ||
    report.approved !== row.approved ||
    report.satisfied !== row.satisfied ||
    report.evaluated !== row.evaluated ||
    report.total !== row.total ||
    report.blocking.length !== row.blockingCount ||
    row.createdByType !== 'api-client' ||
    row.schemaVersion !== MULTICAM_LONGFORM_GATE_SCHEMA_VERSION ||
    row.gate !== MULTICAM_LONGFORM_GATE_ID
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored multicam long-form gate report failed integrity validation',
    )
  }
  const content = Object.freeze({
    schemaVersion: MULTICAM_LONGFORM_GATE_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    report,
    reportFingerprint: row.reportFingerprint,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (calculateMulticamLongformGateRecordHash(content) !== row.recordHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored multicam long-form gate record hash is inconsistent',
    )
  }
  return Object.freeze({ ...content, recordHash: row.recordHash })
}

type CriterionRows = {
  criteria: Omit<V2MulticamLongformGateCriterion, never>[]
  checks: Omit<V2MulticamLongformGateCheck, never>[]
  evidence: Omit<V2MulticamLongformGateEvidence, never>[]
}

/**
 * Project the report onto the criterion, check and evidence rows.
 *
 * The rows are derived from the report rather than assembled beside it, so a
 * query over `multicam_longform_gate_checks` cannot disagree with the record
 * whose hash was signed.
 */
function projectRows(
  gate: Readonly<PersistedMulticamLongformGate>,
): CriterionRows {
  const criteria: CriterionRows['criteria'] = []
  const checks: CriterionRows['checks'] = []
  const evidence: CriterionRows['evidence'] = []
  gate.report.criteria.forEach((criterion, ordinal) => {
    const criterionRowId = `${gate.id}:${criterion.criterion}`
    criteria.push({
      id: criterionRowId,
      workspaceId: gate.workspaceId,
      gateId: gate.id,
      criterion: criterion.criterion,
      ordinal,
      passed: criterion.passed,
      checkCount: criterion.checkCount,
      failedCheckCount: criterion.failedCheckCount,
      missingCheckCount: criterion.missingCheckCount,
      unverifiedReferenceCount: criterion.unverifiedReferenceCount,
    })
    criterion.checks.forEach((item, checkOrdinal) => {
      const checkRowId = `${criterionRowId}:${item.code}`
      checks.push({
        id: checkRowId,
        workspaceId: gate.workspaceId,
        criterionRowId,
        gateId: gate.id,
        criterion: criterion.criterion,
        checkCode: item.code,
        ordinal: checkOrdinal,
        passed: item.passed,
        failureReason: item.failureReason,
        detail: item.detail,
        referenceCount: item.references.length,
        unverifiedReferenceCount: item.references.filter(
          (reference) => !reference.verified,
        ).length,
      })
      item.references.forEach((reference, referenceOrdinal) => {
        evidence.push({
          id: `${checkRowId}:${referenceOrdinal}`,
          workspaceId: gate.workspaceId,
          checkRowId,
          gateId: gate.id,
          criterion: criterion.criterion,
          checkCode: item.code,
          ordinal: referenceOrdinal,
          resourceType: reference.type,
          resourceId: reference.id,
          resourceHash: reference.hash,
          verified: reference.verified,
        })
      })
    })
  })
  return { criteria, checks, evidence }
}

export class PrismaMulticamLongformGateRepository
implements MulticamLongformGateRepository {
  private readonly client: PrismaClient
  private readonly sessions: PrismaCaptureSessionRepository
  private readonly protocols: PrismaCaptureProtocolRepository
  private readonly diagnostics: PrismaSyncDiagnosticRepository
  private readonly playbackMaps: PrismaPlaybackMapRepository
  private readonly directions: PrismaMulticamDirectionRepository
  private readonly matchPlans: PrismaMulticamMatchPlanRepository
  private readonly criticReports: PrismaColorCriticReportRepository
  private readonly syntheses: PrismaEditorialSynthesisRepository
  private readonly snapshots: PrismaRenderablePlanSnapshotRepository

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
    this.sessions = new PrismaCaptureSessionRepository(client)
    this.protocols = new PrismaCaptureProtocolRepository(client)
    this.diagnostics = new PrismaSyncDiagnosticRepository(client)
    this.playbackMaps = new PrismaPlaybackMapRepository(client)
    this.directions = new PrismaMulticamDirectionRepository(client)
    this.matchPlans = new PrismaMulticamMatchPlanRepository(client)
    this.criticReports = new PrismaColorCriticReportRepository(client)
    this.syntheses = new PrismaEditorialSynthesisRepository(client)
    this.snapshots = new PrismaRenderablePlanSnapshotRepository(client)
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2MulticamLongformGate.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (!row) return null
    const audit = hydrateExternalActorAudit(row, row.createdById)
    if (audit.contextHash !== input.actorContextHash) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key belongs to another authenticated actor context',
      )
    }
    return hydrateGate(row)
  }

  async readEvidence(input: Readonly<MulticamLongformGateEvidenceQuery>) {
    const { workspaceId, projectId, sessionId } = input
    const project = await this.client.v2Project.findFirst({
      where: { id: projectId, workspaceId },
      include: { currentVersion: true },
    })
    if (!project) return null

    const heads = await this.client.v2CaptureSessionHead.findMany({
      where: {
        workspaceId,
        projectId,
        ...(sessionId ? { sessionId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    })
    const sessionIds = heads.map((head) => head.sessionId)
    const scenarios = await this.scenariosBySession(workspaceId, sessionIds)

    const evidence: MulticamLongformCriterionEvidenceInput[] = [
      await this.podcastCriterion(workspaceId, scenarios),
      await this.teacherCriterion(workspaceId, scenarios),
      await this.insufficientEvidenceCriterion(workspaceId, sessionIds),
      await this.reactCriterion(workspaceId, sessionIds),
      await this.directionCriterion(workspaceId, sessionIds),
      await this.synthesisCriterion(workspaceId, projectId),
      await this.colourMatchCriterion(workspaceId, projectId, sessionIds),
      await this.colourCriticCriterion(
        workspaceId,
        projectId,
        project.currentVersionId,
      ),
      await this.finalMediaCriterion(workspaceId, projectId),
    ]

    return Object.freeze({
      resolvedSessionId: sessionId,
      projectVersionId: project.currentVersion?.id ?? null,
      projectVersionHash: project.currentVersion?.baseHash ?? null,
      evidence: Object.freeze(evidence),
    })
  }

  /**
   * Which capture scenario each session was evaluated against.
   *
   * The scenario is not a column on the session: it belongs to the protocol,
   * and a session's scenario is therefore whatever protocol was evaluated over
   * it. Reading it any other way would be guessing from track roles.
   */
  private async scenariosBySession(workspaceId: string, sessionIds: readonly string[]) {
    if (sessionIds.length === 0) return new Map<string, string[]>()
    const evaluations = await this.client.v2CaptureProtocolEvaluation.findMany({
      where: { workspaceId, sessionId: { in: [...sessionIds] } },
      orderBy: { evaluatedAt: 'desc' },
    })
    const protocols = await this.client.v2CaptureProtocol.findMany({
      where: {
        protocolId: { in: [...new Set(evaluations.map((item) => item.protocolId))] },
      },
    })
    const scenarioOf = new Map(
      protocols.map((protocol) => [
        `${protocol.protocolId}:${protocol.version}`,
        protocol.scenario,
      ]),
    )
    const bySession = new Map<string, string[]>()
    for (const evaluation of evaluations) {
      const scenario = scenarioOf.get(
        `${evaluation.protocolId}:${evaluation.protocolVersion}`,
      )
      if (!scenario) continue
      const key = `${scenario}`
      const list = bySession.get(key) ?? []
      if (!list.includes(evaluation.sessionId)) list.push(evaluation.sessionId)
      bySession.set(key, list)
    }
    return bySession
  }

  private async verifiedEvaluation(workspaceId: string, sessionId: string) {
    const evaluations = await this.protocols.listEvaluations({
      workspaceId,
      sessionId,
      limit: 5,
    })
    return evaluations[0] ?? null
  }

  /** Criteria 1 and 2 differ only in the scenario and the last two checks. */
  private async synchronisedCriterion(
    workspaceId: string,
    sessionId: string | undefined,
    criterion: 'podcast-multicam-synchronised' | 'teacher-and-screen-synchronised',
    scenario: string,
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const protocolCheck: MulticamLongformCheckCode =
      criterion === 'podcast-multicam-synchronised'
        ? 'podcast-protocol-evaluated'
        : 'teacher-protocol-evaluated'
    if (!sessionId) {
      return {
        criterion,
        checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
          check(
            code,
            false,
            'evidence-missing',
            `no capture session in this project was evaluated against a ${scenario} protocol`,
            [],
          )),
      }
    }
    let session: Readonly<CaptureSession> | null = null
    let diagnostic = null
    let coverages: readonly { trackId: string; bounds: { start: bigint; end: bigint }; coverageHash: string }[] = []
    let clockMaps: readonly { sourceId: string; mapHash: string; pieces: readonly unknown[] }[] = []
    let evaluation = null
    try {
      session = await this.sessions.readHead({ workspaceId, sessionId })
      evaluation = await this.verifiedEvaluation(workspaceId, sessionId)
      diagnostic = await this.diagnostics.readHead({ workspaceId, sessionId })
      coverages = await this.sessions.listCoverage({ workspaceId, sessionId })
      clockMaps = await this.sessions.listClockMaps({ workspaceId, sessionId })
    } catch (error) {
      if (!isPersistenceConflict(error)) throw error
      return criterionFailed(
        criterion,
        'evidence-unverified',
        `a stored row of session ${sessionId} did not re-derive to its own hash`,
        [ref('capture-session', sessionId, null, false)],
      )
    }
    const sessionRef = ref(
      'capture-session',
      sessionId,
      session?.sessionHash ?? null,
      true,
    )
    const evaluationRef = evaluation
      ? ref(
        'capture-protocol-evaluation',
        `${sessionId}:${evaluation.protocolId}:${evaluation.protocolVersion}`,
        evaluation.evaluationHash,
        true,
      )
      : sessionRef
    const diagnosticRef = diagnostic
      ? ref('sync-diagnostic', `${sessionId}:${diagnostic.version}`, diagnostic.diagnosticHash, true)
      : sessionRef

    const checks: MulticamLongformCheckEvidenceInput[] = [
      check(
        protocolCheck,
        Boolean(evaluation),
        'evidence-missing',
        evaluation
          ? `session ${sessionId} evaluated against ${evaluation.protocolId} v${evaluation.protocolVersion} (${scenario}), ceiling ${evaluation.ceiling}`
          : `session ${sessionId} has no capture protocol evaluation`,
        [sessionRef, evaluationRef],
      ),
      check(
        'diagnostic-synchronised',
        Boolean(diagnostic && SYNCED_STATUSES.has(diagnostic.status)),
        diagnostic ? 'requirement-unmet' : 'evidence-missing',
        diagnostic
          ? `diagnostic v${diagnostic.version} of session ${sessionId} is ${diagnostic.status} over ${diagnostic.tracks.length} tracks`
          : `session ${sessionId} has no sync diagnostic`,
        [diagnosticRef],
      ),
    ]

    const measuredCoverage = diagnostic
      ? diagnostic.tracks.filter((track) => track.coverageBps !== null)
      : []
    const coverageRefs = coverages
      .slice(0, 4)
      .map((coverage) => ref('track-coverage', coverage.trackId, coverage.coverageHash, true))
    const coverageCheck = check(
      'coverage-derived',
      coverages.length >= 2 && measuredCoverage.length >= 2,
      coverages.length === 0 ? 'evidence-missing' : 'evidence-not-measured',
      coverages.length === 0
        ? `session ${sessionId} has no derived track coverage`
        : `${coverages.length} coverage rows, ${measuredCoverage.length} of ${diagnostic?.tracks.length ?? 0} diagnostic tracks carry a measured coverageBps`,
      coverageRefs.length > 0 ? coverageRefs : [sessionRef],
    )

    if (criterion === 'podcast-multicam-synchronised') {
      const participants = (session?.tracks ?? []).filter((track) =>
        PARTICIPANT_ROLES.has(track.role))
      const distinctSources = new Set(participants.map((track) => track.sourceAssetId))
      checks.push(
        check(
          'participant-tracks-distinct',
          participants.length >= 2 && distinctSources.size >= 2,
          participants.length === 0 ? 'evidence-missing' : 'requirement-unmet',
          `${participants.length} participant tracks over ${distinctSources.size} distinct source assets in session ${sessionId}`,
          [sessionRef],
        ),
        coverageCheck,
        check(
          'clock-map-persisted',
          clockMaps.length >= 1 && clockMaps.every((map) => map.pieces.length >= 1),
          'evidence-missing',
          clockMaps.length === 0
            ? `session ${sessionId} has no persisted clock map`
            : `${clockMaps.length} clock maps persisted, ${clockMaps.reduce((total, map) => total + map.pieces.length, 0)} pieces`,
          clockMaps.length > 0
            ? clockMaps.slice(0, 4).map((map) => ref('clock-map', `${sessionId}:${map.sourceId}`, map.mapHash, true))
            : [sessionRef],
        ),
      )
      return { criterion, checks }
    }

    const spans = coverages.map((coverage) => ({
      trackId: coverage.trackId,
      ticks: coverage.bounds.end - coverage.bounds.start,
    }))
    const distinctSpans = new Set(spans.map((span) => span.ticks.toString()))
    checks.push(
      check(
        'track-durations-unequal',
        spans.length >= 2 && distinctSpans.size >= 2,
        spans.length < 2 ? 'evidence-missing' : 'requirement-unmet',
        spans.length < 2
          ? `session ${sessionId} has fewer than two derived coverages to compare`
          : `track spans in ticks: ${spans.slice(0, 4).map((span) => `${span.trackId}=${span.ticks}`).join(', ')}`,
        coverageRefs.length > 0 ? coverageRefs : [sessionRef],
      ),
      coverageCheck,
    )
    return { criterion, checks }
  }

  private async podcastCriterion(workspaceId: string, scenarios: Map<string, string[]>) {
    return this.synchronisedCriterion(
      workspaceId,
      scenarios.get('podcast')?.[0],
      'podcast-multicam-synchronised',
      'podcast',
    )
  }

  private async teacherCriterion(workspaceId: string, scenarios: Map<string, string[]>) {
    return this.synchronisedCriterion(
      workspaceId,
      scenarios.get('teacher-and-screen')?.[0],
      'teacher-and-screen-synchronised',
      'teacher-and-screen',
    )
  }

  private async insufficientEvidenceCriterion(
    workspaceId: string,
    sessionIds: readonly string[],
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'insufficient-evidence-requires-manual' as const
    for (const sessionId of sessionIds) {
      let records
      try {
        records = await this.sessions.listSyncEvidence({ workspaceId, sessionId })
      } catch (error) {
        if (!isPersistenceConflict(error)) throw error
        return criterionFailed(
          criterion,
          'evidence-unverified',
          `sync evidence of session ${sessionId} did not re-derive to its own hash`,
          [ref('capture-session', sessionId, null, false)],
        )
      }
      const insufficient = records.find(
        (item) => item.outcome === 'insufficient-evidence' && item.clockMap === null,
      )
      if (!insufficient) continue
      const evidenceRef = ref(
        'sync-evidence',
        `${sessionId}:${insufficient.trackId}`,
        null,
        false,
      )
      let diagnostic = null
      let evaluation = null
      try {
        diagnostic = await this.diagnostics.readHead({ workspaceId, sessionId })
        evaluation = await this.verifiedEvaluation(workspaceId, sessionId)
      } catch (error) {
        if (!isPersistenceConflict(error)) throw error
        return criterionFailed(
          criterion,
          'evidence-unverified',
          `a stored row of session ${sessionId} did not re-derive to its own hash`,
          [evidenceRef],
        )
      }
      const diagnosticRef = diagnostic
        ? ref('sync-diagnostic', `${sessionId}:${diagnostic.version}`, diagnostic.diagnosticHash, true)
        : evidenceRef
      const evaluationRef = evaluation
        ? ref(
          'capture-protocol-evaluation',
          `${sessionId}:${evaluation.protocolId}:${evaluation.protocolVersion}`,
          evaluation.evaluationHash,
          true,
        )
        : evidenceRef
      const demanded = diagnostic
        ? diagnostic.recommendedActions.filter((action) => MANUAL_ACTIONS.has(action))
        : []
      return {
        criterion,
        checks: [
          check(
            'sync-evidence-insufficient',
            true,
            null,
            `track ${insufficient.trackId} of session ${sessionId} is insufficient-evidence with no clock map, manualRequired=${insufficient.manualRequired}`,
            [evidenceRef],
          ),
          check(
            'diagnostic-requires-manual',
            Boolean(diagnostic?.manualRequired) && demanded.length >= 1,
            diagnostic ? 'requirement-unmet' : 'evidence-missing',
            diagnostic
              ? `diagnostic v${diagnostic.version} manualRequired=${diagnostic.manualRequired}, actions [${diagnostic.recommendedActions.join(', ')}]`
              : `session ${sessionId} has no sync diagnostic to demand a manual anchor`,
            [diagnosticRef],
          ),
          check(
            'protocol-ceiling-blocks-auto-edit',
            Boolean(
              evaluation &&
              BLOCKING_CEILINGS.has(evaluation.ceiling) &&
              evaluation.blocksAutoEdit,
            ),
            evaluation ? 'requirement-unmet' : 'evidence-missing',
            evaluation
              ? `protocol ${evaluation.protocolId} v${evaluation.protocolVersion} ceiling ${evaluation.ceiling}, blocksAutoEdit=${evaluation.blocksAutoEdit}`
              : `session ${sessionId} has no protocol evaluation to place a ceiling`,
            [evaluationRef],
          ),
        ],
      }
    }
    return {
      criterion,
      checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
        check(
          code,
          false,
          'evidence-missing',
          'no capture session in this project recorded an insufficient-evidence outcome',
          [],
        )),
    }
  }

  private async reactCriterion(
    workspaceId: string,
    sessionIds: readonly string[],
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'react-edited-with-piecewise-map' as const
    if (sessionIds.length === 0) {
      return { criterion, checks: [] }
    }
    const head = await this.client.v2PlaybackMapHead.findFirst({
      where: { workspaceId, sessionId: { in: [...sessionIds] } },
      orderBy: { updatedAt: 'desc' },
    })
    if (!head) {
      return {
        criterion,
        checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
          check(code, false, 'evidence-missing', 'no react playback map exists for this project', [])),
      }
    }
    const headRef = ref('playback-map', head.mapId, head.mapHash, false)
    let map = null
    let session: Readonly<CaptureSession> | null = null
    try {
      map = await this.playbackMaps.readHead({
        workspaceId,
        sessionId: head.sessionId,
        reactionTrackId: head.reactionTrackId,
      })
      session = await this.sessions.readHead({ workspaceId, sessionId: head.sessionId })
    } catch (error) {
      if (!isPersistenceConflict(error)) throw error
      return criterionFailed(
        criterion,
        'evidence-unverified',
        `playback map ${head.mapId} did not re-derive to its stored hash`,
        [headRef],
      )
    }
    if (!map) {
      return criterionFailed(
        criterion,
        'evidence-missing',
        `playback map head ${head.mapId} names a version that no longer exists`,
        [headRef],
      )
    }
    const mapRef = ref('playback-map', map.mapId, map.mapHash, true)
    const interrupted = map.pieces.filter((piece) => INTERRUPTED_MODES.has(piece.mode))
    const snapshot = await this.snapshots.readLatestForSource({
      workspaceId,
      origin: RENDERABLE_PLAN_ORIGINS[0],
      sourceId: map.mapId,
    })
    const reactionSeconds = session
      ? seconds(map.reactionMedia.durationTicks, session.clock.timebase.secondsPerTick)
      : null
    const referenceSeconds = seconds(
      map.referenceMedia.durationTicks,
      map.referenceMedia.timebase.secondsPerTick,
    )
    return {
      criterion,
      checks: [
        check(
          'playback-map-persisted',
          map.status === 'resolved',
          'requirement-unmet',
          `playback map ${map.mapId} v${map.version} status ${map.status}, ${map.pieces.length} pieces, ${map.uncovered.length} uncovered stretches`,
          [mapRef],
        ),
        check(
          'interrupted-piece-present',
          interrupted.length >= 1,
          'requirement-unmet',
          interrupted.length >= 1
            ? `${interrupted.length} interrupted pieces: ${[...new Set(interrupted.map((piece) => piece.mode))].join(', ')}`
            : `every piece of map ${map.mapId} is ${[...new Set(map.pieces.map((piece) => piece.mode))].join(', ')}`,
          [mapRef, ...interrupted.slice(0, 3).map((piece) => ref('playback-piece', `${map.mapId}:${piece.pieceId}`, null, false))],
        ),
        check(
          'reaction-duration-differs',
          reactionSeconds !== null &&
            Math.abs(reactionSeconds - referenceSeconds) > DURATION_TOLERANCE_SECONDS,
          reactionSeconds === null ? 'evidence-not-measured' : 'requirement-unmet',
          reactionSeconds === null
            ? `session ${head.sessionId} has no clock policy, so the reaction duration is not measured`
            : `reaction ${reactionSeconds.toFixed(3)}s vs reference ${referenceSeconds.toFixed(3)}s`,
          [mapRef, ref('capture-session', head.sessionId, session?.sessionHash ?? null, true)],
        ),
        check(
          'map-compiled-into-plan',
          Boolean(snapshot && snapshot.sourceHash === map.mapHash && snapshot.clipCount >= 1),
          snapshot ? 'evidence-stale' : 'evidence-missing',
          snapshot
            ? `snapshot ${snapshot.planId} compiled ${snapshot.clipCount} clips from source hash ${snapshot.sourceHash.slice(0, 12)} (map ${map.mapHash.slice(0, 12)})`
            : `playback map ${map.mapId} was never compiled into a renderable plan`,
          snapshot
            ? [mapRef, ref('renderable-plan-snapshot', snapshot.planId, snapshot.planHash, true)]
            : [mapRef],
        ),
      ],
    }
  }

  private async directionCriterion(
    workspaceId: string,
    sessionIds: readonly string[],
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'active-speaker-and-demonstration-directed' as const
    for (const sessionId of sessionIds) {
      const head = await this.client.v2MulticamDirectionHead.findUnique({
        where: { sessionId_workspaceId: { sessionId, workspaceId } },
      })
      if (!head) continue
      const headRef = ref('multicam-direction', `${sessionId}:${head.version}`, head.directionHash, false)
      let stored = null
      try {
        stored = await this.directions.readHead({ workspaceId, sessionId })
      } catch (error) {
        if (!isPersistenceConflict(error)) throw error
        return criterionFailed(
          criterion,
          'evidence-unverified',
          `multicam direction of session ${sessionId} did not re-derive to its stored hash`,
          [headRef],
        )
      }
      if (!stored) continue
      const direction = stored.direction
      const directionRef = ref(
        'multicam-direction',
        `${sessionId}:${stored.version}`,
        direction.directionHash,
        true,
      )
      const speaker = direction.shots.find(
        (shot) => shot.rule === 'speech-prefers-active-speaker',
      )
      const demonstration = direction.shots.find(
        (shot) => shot.rule === 'demonstration-prefers-screen',
      )
      const justified = [speaker, demonstration].filter(
        (shot): shot is NonNullable<typeof shot> => Boolean(shot),
      )
      return {
        criterion,
        checks: [
          check(
            'direction-persisted',
            direction.shots.length >= 1,
            'requirement-unmet',
            `direction v${stored.version} of session ${sessionId}: ${direction.shots.length} shots, ${direction.uncovered.length} uncovered ranges, manualReviewRequired=${direction.manualReviewRequired}`,
            [directionRef],
          ),
          check(
            'active-speaker-rule-fired',
            Boolean(speaker),
            'requirement-unmet',
            speaker
              ? `shot ${speaker.shotId} cut on speech-prefers-active-speaker to track ${speaker.chosen.trackId}`
              : `no shot in direction v${stored.version} was cut by speech-prefers-active-speaker; rules used: ${[...new Set(direction.shots.map((shot) => shot.rule))].join(', ')}`,
            speaker
              ? [directionRef, ref('shot-decision', `${sessionId}:${speaker.shotId}`, speaker.decisionHash, true)]
              : [directionRef],
          ),
          check(
            'demonstration-rule-fired',
            Boolean(demonstration),
            'requirement-unmet',
            demonstration
              ? `shot ${demonstration.shotId} cut on demonstration-prefers-screen to track ${demonstration.chosen.trackId}`
              : `no shot in direction v${stored.version} was cut by demonstration-prefers-screen`,
            demonstration
              ? [directionRef, ref('shot-decision', `${sessionId}:${demonstration.shotId}`, demonstration.decisionHash, true)]
              : [directionRef],
          ),
          check(
            'decisions-carry-justification',
            justified.length === 2 &&
              justified.every((shot) =>
                shot.reason.trim().length >= 8 && shot.evidenceRefs.length >= 1),
            justified.length === 2 ? 'requirement-unmet' : 'evidence-missing',
            justified.length === 2
              ? justified
                .map((shot) => `${shot.shotId}: "${shot.reason.slice(0, 80)}" (${shot.evidenceRefs.length} refs)`)
                .join(' | ')
              : `only ${justified.length} of the two required rules produced a shot to justify`,
            justified.length > 0
              ? justified.map((shot) => ref('shot-decision', `${sessionId}:${shot.shotId}`, shot.decisionHash, true))
              : [directionRef],
          ),
        ],
      }
    }
    return {
      criterion,
      checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
        check(code, false, 'evidence-missing', 'no multicam direction exists for this project', [])),
    }
  }

  private async synthesisCriterion(
    workspaceId: string,
    projectId: string,
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'contextual-multi-range-synthesis' as const
    let stored
    try {
      stored = await this.syntheses.list({ workspaceId, projectId, limit: 20 })
    } catch (error) {
      if (!isPersistenceConflict(error)) throw error
      return criterionFailed(
        criterion,
        'evidence-unverified',
        `a stored editorial synthesis of project ${projectId} did not re-derive to its own hash`,
        [ref('project', projectId, null, false)],
      )
    }
    const chosen =
      stored.find((item) => item.synthesis.targetDurationMs === SYNTHESIS_TARGET_MS) ??
      stored[0]
    if (!chosen) {
      return {
        criterion,
        checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
          check(code, false, 'evidence-missing', 'no editorial synthesis exists for this project', [])),
      }
    }
    const synthesis = chosen.synthesis
    const synthesisRef = ref('editorial-synthesis', synthesis.id, synthesis.synthesisHash, true)
    const drift = Math.abs(synthesis.synthesizedDurationMs - synthesis.targetDurationMs)
    const snapshot = await this.snapshots.readLatestForSource({
      workspaceId,
      origin: RENDERABLE_PLAN_ORIGINS[1],
      sourceId: synthesis.id,
    })
    const proof = synthesis.contextProof
    const proofSize =
      proof.claimsIncluded.length + proof.qualifiersIncluded.length
    return {
      criterion,
      checks: [
        check(
          'synthesis-persisted',
          synthesis.ranges.length >= 1,
          'requirement-unmet',
          `synthesis ${synthesis.id}: ${synthesis.ranges.length} ranges, ${synthesis.joins.length} joins, ${synthesis.droppedMs}ms dropped from ${synthesis.sourceDurationMs}ms`,
          [synthesisRef],
        ),
        check(
          'target-duration-is-120s',
          synthesis.targetDurationMs === SYNTHESIS_TARGET_MS,
          'requirement-unmet',
          `targetDurationMs=${synthesis.targetDurationMs} (ADR-135 asks for ${SYNTHESIS_TARGET_MS})`,
          [synthesisRef],
        ),
        check(
          'duration-within-tolerance',
          drift <= synthesis.toleranceMs,
          'requirement-unmet',
          `synthesised ${synthesis.synthesizedDurationMs}ms, ${drift}ms from target, tolerance ${synthesis.toleranceMs}ms`,
          [synthesisRef],
        ),
        check(
          'multiple-ranges-preserved',
          synthesis.ranges.length >= 2 &&
            (synthesis.chronologyPreserved || synthesis.reorderReason !== null),
          'requirement-unmet',
          `${synthesis.ranges.length} ranges, chronologyPreserved=${synthesis.chronologyPreserved}, reorderReason=${synthesis.reorderReason ?? 'none'}`,
          snapshot
            ? [synthesisRef, ref('renderable-plan-snapshot', snapshot.planId, snapshot.planHash, true)]
            : [synthesisRef],
        ),
        check(
          'context-proof-recorded',
          proofSize >= 1 &&
            Boolean(snapshot && snapshot.sourceHash === synthesis.synthesisHash),
          snapshot ? 'requirement-unmet' : 'evidence-missing',
          snapshot
            ? `context proof records ${proof.claimsIncluded.length} claims and ${proof.qualifiersIncluded.length} qualifiers; plan ${snapshot.planId} compiled ${snapshot.clipCount} clips from hash ${snapshot.sourceHash.slice(0, 12)}`
            : `context proof records ${proofSize} entries but the synthesis was never compiled into a renderable plan`,
          snapshot
            ? [synthesisRef, ref('renderable-plan-snapshot', snapshot.planId, snapshot.planHash, true)]
            : [synthesisRef],
        ),
      ],
    }
  }

  private async colourMatchCriterion(
    workspaceId: string,
    projectId: string,
    sessionIds: readonly string[],
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'colour-match-precedes-creative-lut' as const
    for (const sessionId of sessionIds) {
      const head = await this.client.v2MulticamMatchPlanHead.findFirst({
        where: { workspaceId, projectId, sessionId },
      })
      if (!head) continue
      const headRef = ref('match-plan', head.planId, head.planHash, false)
      let stored = null
      try {
        stored = await this.matchPlans.readHead({ workspaceId, projectId, sessionId })
      } catch (error) {
        if (!isPersistenceConflict(error)) throw error
        return criterionFailed(
          criterion,
          'evidence-unverified',
          `match plan ${head.planId} did not re-derive to its stored hash`,
          [headRef],
        )
      }
      if (!stored) continue
      const plan = stored.plan
      const planRef = ref('match-plan', plan.planId, plan.planHash, true)
      const transforms = plan.cameraTransforms
      const allMatchStage = transforms.length >= 1 &&
        transforms.every((transform) => transform.transform.kind === 'match')
      const resolved = await this.resolvedColourOrder(
        workspaceId,
        projectId,
        transforms[0]?.cameraId ?? plan.referenceCameraId,
      )
      return {
        criterion,
        checks: [
          check(
            'match-plan-persisted',
            plan.pipelineStage === 'match',
            'requirement-unmet',
            `match plan ${plan.planId} v${stored.version}: stage ${plan.pipelineStage}, reference camera ${plan.referenceCameraId}, confidence ${plan.confidence}, humanReviewRequired=${plan.humanReviewRequired}`,
            [planRef],
          ),
          check(
            'transforms-are-match-stage',
            allMatchStage,
            transforms.length === 0 ? 'evidence-missing' : 'requirement-unmet',
            transforms.length === 0
              ? `match plan ${plan.planId} carries no camera transform`
              : `${transforms.length} camera transforms, kinds [${[...new Set(transforms.map((transform) => transform.transform.kind))].join(', ')}]`,
            [planRef, ...transforms.slice(0, 3).map((transform) =>
              ref('match-transform', `${plan.planId}:${transform.cameraId}`, null, false))],
          ),
          check(
            'match-precedes-creative-lut',
            resolved.ordered,
            resolved.reason,
            resolved.detail,
            resolved.reference ? [planRef, resolved.reference] : [planRef],
          ),
        ],
      }
    }
    return {
      criterion,
      checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
        check(code, false, 'evidence-missing', 'no multicam match plan exists for this project', [])),
    }
  }

  /**
   * Resolve the project's stored ColorPlan for one camera and read the order
   * off the result, using the domain's own resolver rather than trusting a
   * stored ordering. `COLOR_TRANSFORM_ORDER` is the authority for what "before"
   * means; the evidence is that the persisted plan resolves that way for a
   * camera the match plan actually corrects.
   */
  private async resolvedColourOrder(
    workspaceId: string,
    projectId: string,
    cameraId: string,
  ): Promise<{
    ordered: boolean
    reason: MulticamLongformFailureReason
    detail: string
    reference: MulticamLongformEvidenceReferenceInput | null
  }> {
    const head = await this.client.v2ProjectColorPlanHead.findUnique({
      where: { projectId_workspaceId: { projectId, workspaceId } },
      include: { colorPlan: true },
    })
    if (!head?.colorPlan) {
      return {
        ordered: false,
        reason: 'evidence-missing',
        detail: `project ${projectId} has no colour plan to resolve`,
        reference: null,
      }
    }
    const row = head.colorPlan
    const reference = ref('colour-plan', row.id, row.recordHash, false)
    let plan
    try {
      plan = parseProjectColorPlan(parseJson(row.recordJson, 'project colour plan'))
    } catch {
      return {
        ordered: false,
        reason: 'evidence-unverified',
        detail: `colour plan ${row.id} did not re-derive to its stored record`,
        reference,
      }
    }
    if (plan.recordHash !== row.recordHash) {
      return {
        ordered: false,
        reason: 'evidence-unverified',
        detail: `colour plan ${row.id} record hash disagrees with its content`,
        reference,
      }
    }
    const verified = ref('colour-plan', row.id, row.recordHash, true)
    let transforms
    try {
      transforms = resolveColorPlan(plan.plan, { cameraId }).stages
    } catch (error) {
      return {
        ordered: false,
        reason: 'requirement-unmet',
        detail: `colour plan ${row.id} does not resolve for camera ${cameraId}: ${error instanceof Error ? error.message : 'unknown'}`,
        reference: verified,
      }
    }
    const kinds = transforms.map((transform) => transform.kind)
    const matchIndex = kinds.indexOf('match')
    const lutIndex = kinds.indexOf('creative-lut')
    return {
      ordered: matchIndex >= 0 && lutIndex >= 0 && matchIndex < lutIndex,
      reason: 'requirement-unmet',
      detail: `resolved order for ${cameraId}: [${kinds.join(', ')}] against COLOR_TRANSFORM_ORDER [${COLOR_TRANSFORM_ORDER.join(', ')}]`,
      reference: verified,
    }
  }

  private async colourCriticCriterion(
    workspaceId: string,
    projectId: string,
    projectVersionId: string | null,
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'colour-critic-resolved' as const
    if (!projectVersionId) {
      return { criterion, checks: [] }
    }
    let reports
    try {
      reports = await this.criticReports.listForProjectVersion({
        workspaceId,
        projectId,
        projectVersionId,
        limit: 10,
      })
    } catch (error) {
      if (!isPersistenceConflict(error)) throw error
      return criterionFailed(
        criterion,
        'evidence-unverified',
        `a colour critic report of version ${projectVersionId} did not re-derive to its stored hash`,
        [ref('project-version', projectVersionId, null, false)],
      )
    }
    const report = reports[0]
    if (!report) {
      return {
        criterion,
        checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
          check(
            code,
            false,
            'evidence-missing',
            `project version ${projectVersionId} has no colour critic report`,
            [],
          )),
      }
    }
    const reportRef = ref('colour-critic-report', report.reportId, report.reportHash, true)
    const hard = report.issues.filter((issue) => issue.severity === 'hard')
    return {
      criterion,
      checks: [
        check(
          'critic-report-persisted',
          report.dimensions.length >= 1,
          'requirement-unmet',
          `report ${report.reportId} evaluated ${report.dimensions.length} dimensions over subject ${report.subject.kind}, confidence ${report.confidence} (${report.confidenceBand})`,
          [reportRef],
        ),
        check(
          'verdict-resolved',
          RESOLVED_CRITIC_ACTIONS.has(report.action),
          'requirement-unmet',
          `newest verdict for version ${projectVersionId}: ${report.action} caused by ${report.cause}`,
          [reportRef],
        ),
        check(
          'no-open-hard-issue',
          hard.length === 0,
          'requirement-unmet',
          hard.length === 0
            ? `${report.issues.length} issues, none hard`
            : `${hard.length} hard issues remain: ${hard.slice(0, 3).map((issue) => `${issue.dimension}/${issue.code}`).join(', ')}`,
          [reportRef],
        ),
      ],
    }
  }

  private async finalMediaCriterion(
    workspaceId: string,
    projectId: string,
  ): Promise<MulticamLongformCriterionEvidenceInput> {
    const criterion = 'final-mp4-inspectable' as const
    const exports = await this.client.v2ProjectFinalExportOperation.findMany({
      where: { workspaceId, projectId },
      include: {
        operation: true,
        attempts: { orderBy: { attempt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const promoted = exports
      .map((item) => ({
        item,
        attempt: item.attempts.find(
          (attempt) =>
            attempt.status === 'promoted' &&
            attempt.outputArtifactId === item.outputArtifactId,
        ),
      }))
      .find(
        (candidate) =>
          candidate.item.operation.status === 'succeeded' &&
          Boolean(candidate.attempt?.outputSha256) &&
          Number(candidate.attempt?.outputByteSize ?? 0) > 0,
      )
    if (!promoted?.attempt) {
      return {
        criterion,
        checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) =>
          check(
            code,
            false,
            'evidence-missing',
            `project ${projectId} has no promoted final export attempt`,
            [],
          )),
      }
    }
    const { item, attempt } = promoted
    const exportRef = ref('final-export', item.operationId, null, false)
    const [artifact, manifest] = await Promise.all([
      this.client.v2MediaArtifact.findFirst({
        where: { id: item.outputArtifactId, workspaceId },
      }),
      this.client.v2MediaArtifactManifest.findFirst({
        where: { id: item.outputManifestId, artifactId: item.outputArtifactId, workspaceId },
      }),
    ])
    const manifestOk = manifest ? manifestVerified(manifest) : false
    const manifestRef = manifest
      ? ref('media-manifest', manifest.id, manifest.manifestHash, manifestOk)
      : exportRef
    const artifactRef = artifact
      ? ref('media-artifact', artifact.id, null, false)
      : exportRef
    const probe = manifest ? manifestProbe(manifest) : null
    const probeMeasured = Boolean(
      probe &&
      probe.width !== null &&
      probe.height !== null &&
      probe.fps !== null &&
      probe.duration !== null,
    )
    const frames = probeMeasured && probe
      ? Math.round((probe.duration ?? 0) * (probe.fps ?? 0))
      : null
    return {
      criterion,
      checks: [
        check(
          'final-export-promoted',
          true,
          null,
          `operation ${item.operationId} succeeded; attempt ${attempt.attempt} promoted ${attempt.outputByteSize} bytes, sha256 ${String(attempt.outputSha256).slice(0, 12)}`,
          [exportRef, artifactRef],
        ),
        check(
          'output-codec-recorded',
          item.outputContainer === 'mp4' &&
            item.outputCodec.length > 0 &&
            item.outputAudioCodec.length > 0,
          'requirement-unmet',
          `container ${item.outputContainer}, video ${item.outputCodec}, audio ${item.outputAudioCodec}, ${item.outputWidth}x${item.outputHeight}@${item.outputFps}`,
          [exportRef],
        ),
        check(
          'output-probe-measured',
          probeMeasured && manifestOk,
          manifest ? (manifestOk ? 'evidence-not-measured' : 'evidence-unverified') : 'evidence-missing',
          manifest
            ? manifestOk
              ? `manifest ${manifest.id} probe ${probe?.width}x${probe?.height}@${probe?.fps} for ${probe?.duration}s (${frames ?? 'unmeasured'} frames), ${probe?.mediaType}/${probe?.container}`
              : `manifest ${manifest.id} did not re-derive to its stored manifestHash`
            : `export ${item.operationId} names manifest ${item.outputManifestId}, which is absent`,
          [manifestRef],
        ),
        check(
          'artifact-hash-matches-attempt',
          Boolean(
            artifact &&
            artifact.status === 'available' &&
            artifact.sha256 === attempt.outputSha256 &&
            artifact.byteSize === attempt.outputByteSize,
          ),
          artifact ? 'requirement-unmet' : 'evidence-missing',
          artifact
            ? `artifact ${artifact.id} status ${artifact.status}, sha256 ${artifact.sha256.slice(0, 12)} vs attempt ${String(attempt.outputSha256).slice(0, 12)}, ${artifact.byteSize} vs ${attempt.outputByteSize} bytes`
            : `export ${item.operationId} names artifact ${item.outputArtifactId}, which is absent`,
          [artifactRef, manifestRef],
        ),
      ],
    }
  }

  async persist(
    gate: Readonly<PersistedMulticamLongformGate>,
    authenticationAudit: Parameters<MulticamLongformGateRepository['persist']>[1],
    attempt = 1,
  ): ReturnType<MulticamLongformGateRepository['persist']> {
    const key = {
      workspaceId_projectId_idempotencyKey: {
        workspaceId: gate.workspaceId,
        projectId: gate.projectId,
        idempotencyKey: gate.idempotencyKey,
      },
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2MulticamLongformGate.findUnique({
          where: key,
        })
        if (existing) {
          const audit = hydrateExternalActorAudit(existing, existing.createdById)
          if (audit.contextHash !== authenticationAudit.contextHash) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key belongs to another authenticated actor context',
            )
          }
          if (existing.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different multicam long-form gate request',
            )
          }
          return Object.freeze({ gate: hydrateGate(existing), replayed: true })
        }
        const rows = projectRows(gate)
        await transaction.v2MulticamLongformGate.create({
          data: {
            id: gate.id,
            workspaceId: gate.workspaceId,
            projectId: gate.projectId,
            sessionId: gate.sessionId,
            projectVersionId: gate.projectVersionId,
            projectVersionHash: gate.projectVersionHash,
            schemaVersion: MULTICAM_LONGFORM_GATE_SCHEMA_VERSION,
            gate: MULTICAM_LONGFORM_GATE_ID,
            approved: gate.report.approved,
            satisfied: gate.report.satisfied,
            evaluated: gate.report.evaluated,
            total: gate.report.total,
            blockingCount: gate.report.blocking.length,
            reportJson: stableSerialize(gate.report),
            reportFingerprint: gate.reportFingerprint,
            recordHash: gate.recordHash,
            idempotencyKey: gate.idempotencyKey,
            requestFingerprint: gate.requestFingerprint,
            createdByType: gate.createdBy.type,
            createdById: gate.createdBy.id,
            ...externalActorAuditData(
              authenticationAudit,
              gate.workspaceId,
              gate.createdBy.id,
            ),
            evaluatedAt: new Date(gate.report.evaluatedAt),
            createdAt: new Date(gate.createdAt),
          },
        })
        await transaction.v2MulticamLongformGateCriterion.createMany({
          data: rows.criteria,
        })
        await transaction.v2MulticamLongformGateCheck.createMany({
          data: rows.checks,
        })
        await transaction.v2MulticamLongformGateEvidence.createMany({
          data: rows.evidence,
        })
        const written = await transaction.v2MulticamLongformGate.findUniqueOrThrow({
          where: { id: gate.id },
        })
        return Object.freeze({ gate: hydrateGate(written), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(gate, authenticationAudit, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'multicam long-form gate conflicted with another transaction',
        )
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: gate.workspaceId,
          projectId: gate.projectId,
          idempotencyKey: gate.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different multicam long-form gate request',
            )
          }
          return Object.freeze({ gate: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    gateId: string
  }) {
    const row = await this.client.v2MulticamLongformGate.findFirst({
      where: {
        id: input.gateId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
    })
    return row ? hydrateGate(row) : null
  }

  async readLatest(input: { workspaceId: string; projectId: string }) {
    const row = await this.client.v2MulticamLongformGate.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrateGate(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    limit: number
  }) {
    const rows = await this.client.v2MulticamLongformGate.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateGate))
  }
}
