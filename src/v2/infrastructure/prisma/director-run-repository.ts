import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient, type V2ProjectSnapshot } from '../../../../generated/prisma-v2/index.js'

import type {
  DirectorRunCommit,
  DirectorRunContext,
  DirectorRunRepository,
  DirectorRunResult,
  DirectorSnapshotCommitScope,
  ResolveDirectorSnapshots,
} from '../../application/ports/director-run-repository.ts'
import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import {
  type DirectedEditPlan,
  type DirectorPerceptionSnapshot,
  type DirectorQualityReport,
  type DirectorRun,
  type RunDirectorCommandPayload,
  hasConsistentFaceSafetyClaim,
  validateDirectedEditPlan,
  validateDirectorDecisions,
} from '../../domain/director-run.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProjectSnapshot, type ProjectSnapshot } from '../../domain/project-snapshot.ts'
import { assertDirectorSnapshotAuthority, assertDirectorSnapshotContent, bindDirectorSnapshotIdentities } from '../../application/director-snapshot-identity.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'
import { validateTreatmentPlan, type TreatmentPlan } from '../../domain/treatment-plan.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { createDirectorRunInvalidations, parseDirectorRunImpact } from '../../domain/director-run-impact.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { persistOperationStatusEvents } from './public-operation-repository.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from './edit-command-actor-audit.ts'
import { hydrateExternalActorAudit } from './external-actor-audit.ts'
import {
  bindDirectorObjective,
  resolveStrategicObjective,
} from '../../domain/strategic-objective.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState } from './project-version-commit.ts'
import { parseStrategicQualityReport } from '../../domain/strategic-rubric.ts'
import { parseDirectorDecisionLog } from '../../domain/director-decision.ts'
import { readPerceptionProducerEnvelope } from './perception-producer-envelope-repository.ts'
import type { PerceptionProducerEnvelope } from '../../domain/perception-producer-envelope.ts'
import { expectedOcrTimeline } from '../../domain/projected-ocr-timeline.ts'
import { createPerceptionTimeline, type PerceptionTimeline } from '../../domain/perception-timeline.ts'

const directorRunInclude = Prisma.validator<Prisma.V2DirectorRunInclude>()({
  command: { include: { artifactInvalidations: true } },
  resultVersion: { include: { briefSnapshot: true } },
  perceptionSnapshot: true,
  treatmentSnapshot: true,
  storySnapshot: true,
  editPlanSnapshot: true,
  qualitySnapshot: true,
})

type StoredDirectorRun = Prisma.V2DirectorRunGetPayload<{ include: typeof directorRunInclude }>

function ocrSnapshotEvidence(envelope: Readonly<PerceptionProducerEnvelope>) {
  return {
    envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
    sourceArtifactId: envelope.sourceArtifactId, sourceSha256: envelope.sourceSha256,
    timeMapHash: envelope.timeMapHash,
    sampledTimelineFrames: envelope.samples.map((sample) => sample.timelineFrame),
    emptyTextTimelineFrames: envelope.samples.filter((sample) => sample.ocr.length === 0)
      .map((sample) => sample.timelineFrame),
  }
}

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

export function parseDirectorPerceptionSnapshotUnchecked(input: {
  contentJson: string; contentHash: string; schemaVersion: number; baseVersionId: string
}): Readonly<DirectorPerceptionSnapshot> {
  const record = parseRecord(input.contentJson, 'Director perception')
  if (calculateCanonicalHash(record) !== input.contentHash ||
      record.schemaVersion !== input.schemaVersion || ![1, 2].includes(input.schemaVersion)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director perception snapshot hash or schema is invalid')
  }
  const expectedKeys = input.schemaVersion === 2
    ? ['schemaVersion', 'id', 'inputVersionId', 'timeline', 'summary',
        ...('ocrEvidence' in record ? ['ocrEvidence'] : [])]
    : ['schemaVersion', 'id', 'timeline', 'summary']
  if (Object.keys(record).sort().join('|') !== expectedKeys.sort().join('|') ||
      typeof record.id !== 'string' || !record.id ||
      (input.schemaVersion === 2 && record.inputVersionId !== input.baseVersionId)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director perception snapshot identity is invalid')
  }
  const stored = record as unknown as DirectorPerceptionSnapshot
  let rebuilt: Readonly<PerceptionTimeline>
  try {
    rebuilt = createPerceptionTimeline({ durationMs: stored.timeline.durationMs,
      observations: stored.timeline.observations,
      coverage: stored.timeline.coverage.map((item) => ({ kind: item.kind, ranges: item.ranges })),
    })
  } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Director perception timeline is invalid') }
  if (stableSerialize(rebuilt) !== stableSerialize(stored.timeline) ||
      !stored.summary || stored.summary.faceCoverage !== 'absent' ||
      stored.summary.id !== `${stored.id}-summary` ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stored.summary.sourceTranscriptId) ||
      !Number.isFinite(stored.summary.speechCoverage) ||
      stored.summary.speechCoverage < 0 || stored.summary.speechCoverage > 1 ||
      !Number.isFinite(stored.summary.confidence) ||
      stored.summary.confidence < 0 || stored.summary.confidence > 1) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director perception coverage is invalid')
  }
  if (input.schemaVersion === 2) {
    const evidence = stored.ocrEvidence
    const ocrCoverage = stored.timeline.coverage.find((entry) => entry.kind === 'ocr')
    const ocrObservations = stored.timeline.observations.filter((item) => item.kind === 'ocr')
    if (evidence !== undefined) {
      const keys = ['envelopeId', 'envelopeHash', 'sourceArtifactId', 'sourceSha256',
        'timeMapHash', 'sampledTimelineFrames', 'emptyTextTimelineFrames']
      if (Object.keys(evidence).sort().join('|') !== keys.sort().join('|') ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.envelopeId) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.sourceArtifactId) ||
          [evidence.envelopeHash, evidence.sourceSha256, evidence.timeMapHash]
            .some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
          !Array.isArray(evidence.sampledTimelineFrames) ||
          !Array.isArray(evidence.emptyTextTimelineFrames) ||
          evidence.sampledTimelineFrames.some((frame, index) =>
            !Number.isSafeInteger(frame) || frame < 0 ||
            (index > 0 && frame <= evidence.sampledTimelineFrames[index - 1]!)) ||
          evidence.emptyTextTimelineFrames.some((frame) =>
            !Number.isSafeInteger(frame) || frame < 0 ||
            !evidence.sampledTimelineFrames.includes(frame)) ||
          evidence.emptyTextTimelineFrames.some((frame, index) =>
            index > 0 && frame <= evidence.emptyTextTimelineFrames[index - 1]!) ||
          stored.summary.visualCoverage !==
            (evidence.sampledTimelineFrames.length > 0 ? 'partial' : 'absent') ||
          !ocrCoverage || (evidence.sampledTimelineFrames.length > 0 && ocrCoverage.observedMs === 0) ||
          (evidence.sampledTimelineFrames.length === 0 && ocrCoverage.observedMs !== 0) ||
          ocrObservations.some((item) => item.provenance.source !== evidence.envelopeId ||
            item.provenance.version !== evidence.envelopeHash ||
            !evidence.sampledTimelineFrames.includes((item.value as Record<string, unknown>).timelineFrame as number) ||
            evidence.emptyTextTimelineFrames.includes((item.value as Record<string, unknown>).timelineFrame as number)) ||
          evidence.sampledTimelineFrames.some((frame) =>
            !evidence.emptyTextTimelineFrames.includes(frame) &&
            !ocrObservations.some((item) => (item.value as Record<string, unknown>).timelineFrame === frame))) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director OCR snapshot evidence is invalid')
      }
    } else if (ocrObservations.length > 0 || ocrCoverage?.observedMs !== 0 ||
        stored.summary.visualCoverage !== 'absent') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director OCR observations lack an envelope')
    }
  }
  return Object.freeze(stored)
}

function parseDirectorPerceptionSnapshot(input: {
  contentJson: string; contentHash: string; schemaVersion: number; baseVersionId: string
}): Readonly<DirectorPerceptionSnapshot> {
  try {
    return parseDirectorPerceptionSnapshotUnchecked(input)
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director perception snapshot is invalid')
  }
}

async function editPlanOriginIsInVersionLineage(input: {
  client: PrismaClient
  workspaceId: string
  projectId: string
  currentVersionId: string
  originVersionId: string
  editPlanSnapshotId: string
}): Promise<boolean> {
  const rows = await input.client.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    WITH RECURSIVE "lineage" AS (
      SELECT "id", "parentVersionId", "sequence", "editPlanSnapshotId"
      FROM "project_versions"
      WHERE
        "id" = ${input.currentVersionId} AND
        "workspaceId" = ${input.workspaceId} AND
        "projectId" = ${input.projectId}

      UNION ALL

      SELECT
        parent."id", parent."parentVersionId", parent."sequence",
        parent."editPlanSnapshotId"
      FROM "project_versions" parent
      INNER JOIN "lineage" child
        ON parent."id" = child."parentVersionId"
        AND parent."workspaceId" = ${input.workspaceId}
        AND parent."projectId" = ${input.projectId}
        AND parent."sequence" < child."sequence"
    )
    SELECT "id"
    FROM "lineage"
    WHERE
      "id" = ${input.originVersionId} AND
      "editPlanSnapshotId" = ${input.editPlanSnapshotId}
    LIMIT 1
  `)
  return rows.length === 1
}

export function parseDirectorQualityReport(input: {
  contentJson: string
  contentHash: string
  contentSchemaVersion: number
  objective: string
  rubricRef: string
}): Readonly<DirectorQualityReport> {
  const record = parseRecord(input.contentJson, 'Director quality report')
  const objective = resolveStrategicObjective(input.objective)
  const strategic = parseStrategicQualityReport(record.strategic)
  const hardChecks = record.hardChecks as Record<string, unknown> | undefined
  const expectedHardChecks = [
    'openingMotionProtected', 'automaticZoomDisabled', 'subtitlesFaceSafe',
    'subtitlesBounded', 'forbiddenSpeechAbsent', 'timelineContinuous',
  ]
  const issues = record.issues
  const issuesValid = Array.isArray(issues) && issues.length <= 500 && issues.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false
    const issue = candidate as Record<string, unknown>
    const allowedKeys = new Set(['code', 'severity', 'category', 'message', 'rangeMs', 'targetId', 'correctable'])
    const range = issue.rangeMs
    return Object.keys(issue).every((key) => allowedKeys.has(key)) &&
      typeof issue.code === 'string' && issue.code.length >= 1 && issue.code.length <= 128 &&
      ['hard', 'warning'].includes(String(issue.severity)) &&
      ['technical', 'policy', 'integrity', 'editorial'].includes(String(issue.category)) &&
      typeof issue.message === 'string' && issue.message.length >= 1 && issue.message.length <= 2_000 &&
      typeof issue.correctable === 'boolean' &&
      (issue.targetId === undefined || typeof issue.targetId === 'string') &&
      (range === undefined || (
        Array.isArray(range) && range.length === 2 &&
        range.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      ))
  })
  if (
    input.contentSchemaVersion !== 3 ||
    record.schemaVersion !== 'director-quality-report/v3' ||
    typeof record.id !== 'string' ||
    !['approved', 'approved-with-warnings', 'review-required', 'blocked'].includes(String(record.status)) ||
    typeof record.score !== 'number' || !Number.isFinite(record.score) ||
    record.score !== strategic.score / 100 ||
    strategic.rubric.objective !== objective.id ||
    `${strategic.rubric.id}/v${strategic.rubric.version}` !== input.rubricRef ||
    (strategic.passed !== ['approved', 'approved-with-warnings', 'review-required'].includes(String(record.status))) ||
    !hasConsistentFaceSafetyClaim(record) ||
    typeof hardChecks !== 'object' || hardChecks === null ||
    Object.keys(hardChecks).sort().join('|') !== [...expectedHardChecks].sort().join('|') ||
    !expectedHardChecks.every((key) => typeof hardChecks[key] === 'boolean') ||
    !issuesValid ||
    typeof record.criticVersion !== 'string' || record.criticVersion.length < 1 ||
    typeof record.evaluatedAt !== 'string' || record.evaluatedAt !== strategic.evaluatedAt ||
    Number.isNaN(new Date(record.evaluatedAt).getTime())
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director quality report is inconsistent')
  const report = Object.freeze({ ...record, strategic }) as unknown as Readonly<DirectorQualityReport>
  if (calculateCanonicalHash(report) !== input.contentHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director quality report hash is inconsistent')
  }
  return report
}

function hydrateStoredRun(row: StoredDirectorRun, replayed: boolean): Readonly<DirectorRunResult> {
  hydrateEditCommandExternalActorAudit(row.command)
  const payload = parseRecord(row.command.payloadJson, 'Director command payload') as unknown as RunDirectorCommandPayload
  const impact = parseDirectorRunImpact(payload.impact)
  const scope = parseRecord(row.command.scopeJson, 'Director command scope') as EditScope
  const command = createEditCommand<RunDirectorCommandPayload>({
    id: row.command.id,
    workspaceId: row.command.workspaceId,
    projectId: row.command.projectId,
    baseVersionId: row.command.baseVersionId,
    baseHash: row.command.baseHash,
    author: {
      type: row.command.actorType as 'user' | 'director' | 'system' | 'api-client',
      id: row.command.actorId,
      ...(row.command.delegatedUserId ? { delegatedUserId: row.command.delegatedUserId } : {}),
    },
    type: requireEditCommandType(row.command.type),
    scope,
    payload,
    ...(row.command.reason ? { reason: row.command.reason } : {}),
    idempotencyKey: row.command.idempotencyKey,
    createdAt: row.command.createdAt.toISOString(),
  })
  if (row.command.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director command seal is invalid')
  const version = hydrateProjectVersionRowV3(row.resultVersion)
  const perception = parseDirectorPerceptionSnapshot({
    contentJson: row.perceptionSnapshot.contentJson,
    contentHash: row.perceptionSnapshot.contentHash,
    schemaVersion: row.perceptionSnapshot.schemaVersion,
    baseVersionId: row.baseVersionId,
  })
  const treatmentPlanRecord = parseRecord(row.treatmentSnapshot.contentJson, 'TreatmentPlan') as unknown as TreatmentPlan & { id: string }
  validateTreatmentPlan(treatmentPlanRecord)
  const treatmentPlan = Object.freeze(treatmentPlanRecord)
  const storyPlan = parseRecord(row.storySnapshot.contentJson, 'StoryPlan') as unknown as StoryPlan & { id: string }
  const editPlan = parseRecord(row.editPlanSnapshot.contentJson, 'Director EditPlan') as unknown as DirectedEditPlan
  const qualityReport = parseDirectorQualityReport({
    contentJson: row.qualitySnapshot.contentJson,
    contentHash: row.qualitySnapshot.contentHash,
    contentSchemaVersion: row.qualitySnapshot.schemaVersion,
    objective: row.objective,
    rubricRef: row.rubricRef,
  })
  const brief = parseRecord(row.resultVersion.briefSnapshot.contentJson, 'Director brief')
  const decisions = validateDirectorDecisions(parseArray(row.decisionsJson, 'Director decisions') as unknown as DirectorRun['decisions'])
  if (!row.decisionLogJson || !row.decisionLogHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log is missing')
  let decisionLog: ReturnType<typeof parseDirectorDecisionLog>
  try { decisionLog = parseDirectorDecisionLog(JSON.parse(row.decisionLogJson) as unknown) } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log JSON is invalid') }
  if (
    decisionLog.logHash !== row.decisionLogHash ||
    decisionLog.workspaceId !== row.workspaceId ||
    decisionLog.projectId !== row.projectId ||
    decisionLog.runId !== row.id ||
    decisionLog.commandId !== row.commandId ||
    decisionLog.resultVersionId !== row.resultVersionId ||
    stableSerialize(decisionLog.entries.map((entry) => entry.id)) !== stableSerialize(decisions.map((decision) => decision.id))
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision log bindings are inconsistent')
  const assumptions = Object.freeze(parseArray(row.assumptionsJson, 'Director assumptions').map((item) => String(item)))
  const objective = resolveStrategicObjective(row.objective)
  const previousObjective = resolveStrategicObjective(payload.previousObjective)
  validateDirectedEditPlan(editPlan)
  if (
    row.command.type !== 'run-director' || payload.schemaVersion !== 3 || payload.directorRunId !== row.id ||
    row.baseVersionId !== row.command.baseVersionId || row.resultVersionId !== version.id ||
    payload.objective !== objective.id || payload.objective !== row.objective ||
    payload.previousObjective !== previousObjective.id ||
    payload.objectiveVersion !== row.objectiveVersion ||
    !Number.isSafeInteger(row.objectiveVersion) || row.objectiveVersion < 1 ||
    payload.rubricRef !== row.rubricRef || row.rubricRef !== `${objective.rubricId}/v1` ||
    payload.supersedesRunId !== (row.supersedesRunId ?? undefined) ||
    impact.commandId !== row.command.id || impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.resultVersionId || impact.sourceTranscriptId !== payload.sourceTranscriptId ||
    impact.plannerVersion !== payload.plannerVersion || impact.criticVersion !== payload.criticVersion ||
    payload.snapshotRefs.perception !== row.perceptionSnapshotId ||
    payload.snapshotRefs.treatment !== row.treatmentSnapshotId ||
    payload.snapshotRefs.story !== row.storySnapshotId ||
    payload.snapshotRefs.editPlan !== row.editPlanSnapshotId ||
    payload.snapshotRefs.quality !== row.qualitySnapshotId ||
    payload.snapshotRefs.brief !== version.snapshotRefs.brief ||
    brief.objective !== objective.id ||
    editPlan.projectVersionId !== version.id || editPlan.directorRunId !== row.id ||
    treatmentPlan.id !== editPlan.treatmentPlanId || storyPlan.id !== editPlan.storyPlanId ||
    treatmentPlan.objective !== objective.id || storyPlan.objective !== objective.id ||
    qualityReport.schemaVersion !== 'director-quality-report/v3' ||
    !qualityReport.strategic ||
    qualityReport.strategic.rubric.id + `/v${qualityReport.strategic.rubric.version}` !== row.rubricRef ||
    qualityReport.strategic.rubric.objective !== objective.id ||
    qualityReport.strategic.rubric.purpose !== 'editorial-quality-proxy' ||
    qualityReport.score !== qualityReport.strategic.score / 100 ||
    qualityReport.strategic.passed !== ['approved', 'approved-with-warnings', 'review-required'].includes(qualityReport.status) ||
    row.qualitySnapshot.schemaVersion !== 3 ||
    qualityReport.status === 'blocked' || row.initiatedByType !== 'api-client'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored DirectorRun references are inconsistent')
  const run: DirectorRun = Object.freeze({
    schemaVersion: 2 as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    commandId: row.commandId,
    baseVersionId: row.baseVersionId,
    resultVersionId: row.resultVersionId,
    status: row.status as DirectorRun['status'],
    plannerVersion: row.plannerVersion,
    criticVersion: row.criticVersion,
    objective: objective.id,
    objectiveVersion: row.objectiveVersion,
    rubricRef: row.rubricRef,
    ...(row.supersedesRunId
      ? { supersedesRunId: row.supersedesRunId }
      : {}),
    perception: Object.freeze(perception),
    treatmentPlan: Object.freeze(treatmentPlan),
    storyPlan: Object.freeze(storyPlan),
    editPlan: Object.freeze(editPlan),
    qualityReport: Object.freeze(qualityReport),
    decisions,
    assumptions,
    initiatedBy: Object.freeze({ type: 'api-client' as const, id: row.initiatedById }),
    createdAt: row.createdAt.toISOString(),
  })
  const expectedInvalidations = createDirectorRunInvalidations({ impact, createdAt: row.command.createdAt.toISOString() })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.command.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status,
    commandId: item.commandId, baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId, artifactId: item.artifactId,
    kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'Director invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'Director invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director invalidations are inconsistent')
  }
  return Object.freeze({ run, command, version, impact, invalidations: Object.freeze(invalidations), replayed })
}

/** The sealed bundle carries the Command, audit, request fingerprint and Version; the transaction below reads them by their old names. */
function commitView(commit: Readonly<DirectorRunCommit>) {
  const sealed = childCommandOf<RunDirectorCommandPayload>(commit.bundle)
  if (!sealed.audit) throw new DomainError('AUTH_INVALID', 'A Director run requires an authenticated external actor')
  if (sealed.command.type !== 'run-director' || commit.bundle.version.commandId !== sealed.command.id) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director Version does not belong to its Command')
  }
  return { ...commit, command: sealed.command, authenticationAudit: sealed.audit, requestFingerprint: sealed.requestFingerprint, version: commit.bundle.version }
}
type DirectorCommitView = ReturnType<typeof commitView>

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaDirectorRunRepository implements DirectorRunRepository {
  private readonly client: PrismaClient
  private readonly clock: () => Date

  constructor(client: PrismaClient = getV2PostgresClient(), clock: () => Date = () => new Date()) {
    this.client = client
    this.clock = clock
  }

  async readQualityReport(input: {
    workspaceId: string
    projectId: string
    directorRunId: string
  }) {
    const row = await this.client.v2DirectorRun.findFirst({
      where: {
        id: input.directorRunId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      },
      include: { qualitySnapshot: true },
    })
    if (!row) return null
    const objective = resolveStrategicObjective(row.objective)
    const report = parseDirectorQualityReport({
      contentJson: row.qualitySnapshot.contentJson,
      contentHash: row.qualitySnapshot.contentHash,
      contentSchemaVersion: row.qualitySnapshot.schemaVersion,
      objective: objective.id,
      rubricRef: row.rubricRef,
    })
    return Object.freeze({
      directorRunId: row.id,
      projectId: row.projectId,
      objective: objective.id,
      objectiveVersion: row.objectiveVersion,
      rubricRef: row.rubricRef,
      qualitySnapshot: Object.freeze({
        id: row.qualitySnapshot.id,
        contentSchemaVersion: row.qualitySnapshot.schemaVersion,
        contentHash: row.qualitySnapshot.contentHash,
      }),
      report,
    })
  }

  async findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const key = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    }
    const command = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: key },
      include: { directorRun: { include: directorRunInclude } },
    })
    if (!command) return null
    if (!command.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency key belongs to a different command type')
    if (
      hydrateEditCommandExternalActorAudit(command).contextHash !==
      input.actorContextHash
    ) throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Director idempotency key belongs to another authentication context',
    )
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrateStoredRun(command.directorRun, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string }): Promise<Readonly<DirectorRunContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: {
        currentVersion: { include: { briefSnapshot: true, policiesSnapshot: true } },
        mediaAssets: {
          where: { role: 'source-master' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { artifact: { include: { currentRightsSnapshot: true } } },
        },
        directorRuns: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          include: { qualitySnapshot: true },
        },
      },
    })
    const versionRow = project?.currentVersion
    const master = project?.mediaAssets[0]
    if (!project || !versionRow || !master) return null
    if (!project.objective || !project.format || !project.locale) throw new DomainError('PERSISTENCE_CONFLICT', 'Project direction metadata is incomplete')
    const projectObjective = resolveStrategicObjective(project.objective)
    const latestDirectorRun = project.directorRuns[0]
    const latestDirectorObjective = latestDirectorRun
      ? (() => {
          const storedObjective = resolveStrategicObjective(latestDirectorRun.objective)
          const quality = parseRecord(
            latestDirectorRun.qualitySnapshot.contentJson,
            'latest Director quality report',
          ) as unknown as DirectorQualityReport
          if (
            latestDirectorRun.rubricRef !== `${storedObjective.rubricId}/v1` ||
            !Number.isSafeInteger(latestDirectorRun.objectiveVersion) ||
            latestDirectorRun.objectiveVersion < 1 ||
            latestDirectorRun.qualitySnapshot.schemaVersion !== 3 ||
            quality.schemaVersion !== 'director-quality-report/v3' ||
            !quality.strategic ||
            quality.strategic.rubric.id + `/v${quality.strategic.rubric.version}` !== latestDirectorRun.rubricRef ||
            quality.strategic.rubric.objective !== storedObjective.id ||
            quality.score !== quality.strategic.score / 100 ||
            !['approved', 'approved-with-warnings', 'review-required', 'blocked'].includes(String(quality.status))
          ) throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Latest Director objective evidence is invalid',
          )
          return Object.freeze({
            runId: latestDirectorRun.id,
            objective: storedObjective.id,
            objectiveVersion: latestDirectorRun.objectiveVersion,
            rubricRef: latestDirectorRun.rubricRef,
            ...(latestDirectorRun.supersedesRunId
              ? { supersedesRunId: latestDirectorRun.supersedesRunId }
              : {}),
            approved: ['approved', 'approved-with-warnings'].includes(
              String(quality.status),
            ),
          })
        })()
      : undefined
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: project.workspaceId, projectId: project.id, versionId: versionRow.id })
    if (!parent) return null
    const editPlan = parseRecord(operationalBundlePlanV3(parent).contentJson, 'current EditPlan') as unknown as EditorialCutEditPlan
    const retimedTranscript = editPlan.retimedTranscript as unknown
    if (typeof retimedTranscript !== 'object' || retimedTranscript === null || !('sourceTranscriptId' in retimedTranscript) || typeof retimedTranscript.sourceTranscriptId !== 'string') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan has no valid transcript selection')
    }
    const transcriptRow = await this.client.v2MediaTranscript.findFirst({
      where: {
        id: retimedTranscript.sourceTranscriptId,
        projectId: project.id,
        workspaceId: project.workspaceId,
      },
    })
    if (!transcriptRow) return null
    if (master.artifactId !== transcriptRow.sourceArtifactId) throw new DomainError('PERSISTENCE_CONFLICT', 'Current transcript does not belong to the project source master')
    const planTranscriptHash = 'sourceTranscriptHash' in retimedTranscript
      ? String(retimedTranscript.sourceTranscriptHash)
      : undefined
    const editPlanOriginIsCurrentOrAncestor =
      typeof editPlan.projectVersionId === 'string' &&
      await editPlanOriginIsInVersionLineage({
        client: this.client,
        workspaceId: project.workspaceId,
        projectId: project.id,
        currentVersionId: versionRow.id,
        originVersionId: editPlan.projectVersionId,
        editPlanSnapshotId: versionRow.editPlanSnapshotId,
      })
    if (
      editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' ||
      !editPlanOriginIsCurrentOrAncestor ||
      retimedTranscript.sourceTranscriptId !== transcriptRow.id ||
      (planTranscriptHash !== undefined && planTranscriptHash !== transcriptRow.transcriptHash)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan is not aligned to the current transcript')
    const [proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: project.workspaceId, projectId: project.id, projectVersionId: versionRow.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: project.workspaceId, projectId: project.id, projectVersionId: versionRow.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    const currentDurationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames <= 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan duration is invalid')
    }
    const latestOcr = await this.client.v2PerceptionProducerEnvelope.findFirst({
      where: { workspaceId: project.workspaceId, projectId: project.id,
        projectVersionId: versionRow.id, sourceArtifactId: transcriptRow.sourceArtifactId,
        modality: 'ocr' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
    })
    const ocrEnvelope = latestOcr
      ? await readPerceptionProducerEnvelope(this.client, { id: latestOcr.id,
          workspaceId: project.workspaceId, projectId: project.id,
          inputVersionId: versionRow.id, now: this.clock() })
      : null
    if (latestOcr && !ocrEnvelope) throw new DomainError('PERSISTENCE_CONFLICT', 'Selected OCR envelope disappeared')
    return Object.freeze({
      workspaceId: project.workspaceId,
      project: Object.freeze({ id: project.id, objective: projectObjective.id, format: project.format, locale: project.locale }),
      ...(latestDirectorObjective ? { latestDirectorObjective } : {}),
      parent,
      currentVersion: parent.version,
      brief: Object.freeze(parseRecord(versionRow.briefSnapshot.contentJson, 'project brief')),
      policies: Object.freeze(parseRecord(versionRow.policiesSnapshot.contentJson, 'project policies')),
      editPlan: Object.freeze(editPlan),
      currentDurationFrames,
      proxyVariantId: project.format,
      sourceRights: master.artifact.currentRightsSnapshot
        ? Object.freeze({
            state: 'present' as const,
            snapshotId: master.artifact.currentRightsSnapshot.id,
            snapshotHash: master.artifact.currentRightsSnapshot.snapshotHash,
            status: master.artifact.currentRightsSnapshot.status,
            consentStatus: master.artifact.currentRightsSnapshot.consentStatus,
            ...(master.artifact.currentRightsSnapshot.expiresAt
              ? { expiresAt: master.artifact.currentRightsSnapshot.expiresAt.toISOString() }
              : {}),
            ...(master.artifact.currentRightsSnapshot.consentExpiresAt
              ? { consentExpiresAt: master.artifact.currentRightsSnapshot.consentExpiresAt.toISOString() }
              : {}),
          })
        : Object.freeze({ state: 'missing' as const }),
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: versionRow.id, variantId: project.format! })),
        ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: versionRow.id, variantId: output.outputAspectRatio })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
      transcript: Object.freeze({
        id: transcriptRow.id,
        sourceArtifactId: transcriptRow.sourceArtifactId,
        language: transcriptRow.language,
        provider: transcriptRow.provider,
        model: transcriptRow.model,
        transcriptHash: transcriptRow.transcriptHash,
      }),
      ...(ocrEnvelope ? { ocrEnvelope } : {}),
    })
  }

  async commitWithCanonicalSnapshots(
    scope: Readonly<DirectorSnapshotCommitScope>,
    prepare: (resolve: ResolveDirectorSnapshots) => Promise<Readonly<DirectorRunCommit>>,
  ): Promise<Readonly<DirectorRunResult>> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
          // Every publisher takes operation before project. No resolver, content
          // write or snapshot lock may precede these owner locks.
          if (scope.operationFence) {
            const operations = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
              SELECT "id" FROM "public_operations"
              WHERE "id" = ${scope.operationFence.operationId}
                AND "workspaceId" = ${scope.workspaceId} AND "projectId" = ${scope.projectId}
              FOR UPDATE
            `)
            if (operations.length !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation owner disappeared')
          }
          const projects = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
            SELECT "id" FROM "projects"
            WHERE "id" = ${scope.projectId} AND "workspaceId" = ${scope.workspaceId}
            FOR UPDATE
          `)
          if (projects.length !== 1) throw new DomainError('PROJECT_NOT_FOUND', 'Director project owner disappeared')
          const replay = await transaction.v2EditCommand.findUnique({
            where: { workspaceId_projectId_idempotencyKey: {
              workspaceId: scope.workspaceId, projectId: scope.projectId, idempotencyKey: scope.idempotencyKey,
            } },
            include: { directorRun: { include: directorRunInclude } },
          })
          if (replay) {
            if (replay.requestFingerprint !== scope.requestFingerprint ||
              hydrateEditCommandExternalActorAudit(replay).contextHash !== scope.actorContextHash) {
              throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Director replay identity changed')
            }
            if (!replay.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Director idempotency result is missing')
            if (scope.operationFence) {
              const settled = await transaction.v2PublicOperation.findFirst({ where: {
                id: scope.operationFence.operationId, workspaceId: scope.workspaceId, projectId: scope.projectId,
                type: 'project-director-run', status: 'succeeded', phase: 'completed',
                targetType: 'project-version', targetId: replay.directorRun.resultVersionId,
              } })
              if (!settled || replay.directorRun.operationId !== settled.id) throw new DomainError(
                'PERSISTENCE_CONFLICT', 'Director replay is not bound to the settled operation',
              )
            }
            return hydrateStoredRun(replay.directorRun, true)
          }
          await this.assertSnapshotOwner(transaction, scope)
          const resolvedIds = new Set<string>()
          const resolve: ResolveDirectorSnapshots = async (candidates) => {
            await this.assertSnapshotOwner(transaction, scope)
            if (candidates.length < 1 || candidates.length > 6 ||
              new Set(candidates.map((item) => item.kind)).size !== candidates.length) {
              throw new DomainError('PERSISTENCE_CONFLICT', 'Director snapshot candidates are incomplete')
            }
            const rows: Readonly<ProjectSnapshot>[] = []
            // Brief is resolved first by the application; each remaining batch
            // takes canonical rows in UTF-8 kind order under the same project lock.
            for (const candidate of [...candidates].sort((left, right) =>
              Buffer.compare(Buffer.from(left.kind, 'utf8'), Buffer.from(right.kind, 'utf8')))) {
              assertDirectorSnapshotAuthority(candidate)
              if (candidate.workspaceId !== scope.workspaceId || candidate.projectId !== scope.projectId) {
                throw new DomainError('PERSISTENCE_CONFLICT', 'Director snapshot candidate is outside owner scope')
              }
              const byId = await transaction.v2ProjectSnapshot.findUnique({ where: { id: candidate.id } })
              if (byId) assertDirectorSnapshotContent(candidate, this.snapshotFromRow(byId))
              const key = { projectId_kind_contentHash: {
                projectId: candidate.projectId, kind: candidate.kind, contentHash: candidate.contentHash,
              } }
              let row = await transaction.v2ProjectSnapshot.findUnique({ where: key })
              if (!row) {
                await transaction.$executeRaw(Prisma.sql`
                  INSERT INTO "project_snapshots"
                    ("id", "workspaceId", "projectId", "kind", "schemaVersion", "contentJson", "contentHash", "createdAt")
                  VALUES (${candidate.id}, ${candidate.workspaceId}, ${candidate.projectId}, ${candidate.kind},
                    ${candidate.contentSchemaVersion}, ${candidate.contentJson}, ${candidate.contentHash}, ${new Date(candidate.createdAt)})
                  ON CONFLICT ("projectId", "kind", "contentHash") DO NOTHING
                `)
                row = await transaction.v2ProjectSnapshot.findUnique({ where: key })
              }
              if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Canonical Director snapshot was not resolved')
              const locked = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
                SELECT "id" FROM "project_snapshots"
                WHERE "id" = ${row.id} AND "workspaceId" = ${scope.workspaceId} AND "projectId" = ${scope.projectId}
                  AND "kind" = ${candidate.kind} AND "contentHash" = ${candidate.contentHash}
                FOR SHARE
              `)
              row = await transaction.v2ProjectSnapshot.findUnique({ where: key })
              if (locked.length !== 1 || !row || row.id !== locked[0].id) throw new DomainError(
                'PERSISTENCE_CONFLICT', 'Canonical Director snapshot changed while acquiring its row lock',
              )
              const resolved = this.snapshotFromRow(row)
              assertDirectorSnapshotContent(candidate, resolved)
              if (byId && byId.id !== row.id) throw new DomainError('PERSISTENCE_CONFLICT', 'Director snapshot ID belongs to another tuple')
              resolvedIds.add(resolved.id)
              rows.push(resolved)
            }
            return bindDirectorSnapshotIdentities(candidates, rows)
          }
          // This callback only projects fixed planner output and seals it.
          const bundle = commitView(await prepare(resolve))
          if (new Set(bundle.snapshots.map((item) => item.id)).size !== bundle.snapshots.length ||
            resolvedIds.size !== bundle.snapshots.length || !bundle.snapshots.every((item) => resolvedIds.has(item.id))) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Director bundle omitted or added resolved snapshot identities')
          }
          if (bundle.command.workspaceId !== scope.workspaceId || bundle.command.projectId !== scope.projectId ||
            bundle.command.baseVersionId !== scope.baseVersionId || bundle.command.baseHash !== scope.baseHash ||
            bundle.command.idempotencyKey !== scope.idempotencyKey || bundle.requestFingerprint !== scope.requestFingerprint ||
            bundle.authenticationAudit.contextHash !== scope.actorContextHash || bundle.version.id !== scope.resultVersionId ||
            (bundle.operationFence === undefined) !== (scope.operationFence === undefined) ||
            (bundle.operationFence !== undefined && stableSerialize(bundle.operationFence) !== stableSerialize(scope.operationFence))) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Director prepared bundle changed its transaction owner')
          }
          const authorityNow = await this.assertSnapshotOwner(transaction, scope)
          return this.commitBundle(transaction, {
            ...bundle,
            ...(bundle.operationFence ? { operationFence: { ...bundle.operationFence, now: authorityNow.toISOString() } } : {}),
          })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      } catch (error) {
        const serialization = isPrismaCode(error, 'P2034') ||
          isPrismaCode(error, 'P2010') && typeof error === 'object' && error !== null &&
          'meta' in error && typeof error.meta === 'object' && error.meta !== null &&
          'code' in error.meta && error.meta.code === '40001'
        if (!serialization || attempt === 3) throw error
      }
    }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director snapshot owner retry exhausted')
  }

  private snapshotFromRow(row: V2ProjectSnapshot): Readonly<ProjectSnapshot> {
    try {
      return createProjectSnapshot({ id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
        kind: row.kind as ProjectSnapshot['kind'], contentSchemaVersion: row.schemaVersion,
        contentJson: row.contentJson, contentHash: row.contentHash, createdAt: row.createdAt.toISOString() })
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director canonical snapshot row is invalid')
    }
  }

  private async assertSnapshotOwner(
    transaction: Prisma.TransactionClient, scope: Readonly<DirectorSnapshotCommitScope>,
  ): Promise<Date> {
    const project = await transaction.v2Project.findFirst({
      where: { id: scope.projectId, workspaceId: scope.workspaceId }, include: { currentVersion: true },
    })
    const operation = scope.operationFence ? await transaction.v2PublicOperation.findFirst({
      where: { id: scope.operationFence.operationId, workspaceId: scope.workspaceId, projectId: scope.projectId },
    }) : null
    // Queries (and any lock waits) precede the authoritative clock. No caller's
    // earlier clock is used to accept a lease that expired while waiting.
    const clocks = await transaction.$queryRaw<readonly { now: Date }[]>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
    const now = clocks[0]?.now
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError(
      'PERSISTENCE_CONFLICT', 'Director transaction clock is unavailable',
    )
    if (!project?.currentVersion || project.currentVersion.id !== scope.baseVersionId ||
      project.currentVersion.baseHash !== scope.baseHash) throw new DomainError(
        'VERSION_CONFLICT', 'Project version changed before canonical Director snapshot preparation',
      )
    if (scope.operationFence && (!operation || operation.type !== 'project-director-run' ||
      operation.status !== 'running' || operation.phase !== 'directing' ||
      operation.attempt !== scope.operationFence.attempt || operation.leaseOwner !== scope.operationFence.leaseOwner ||
      operation.actorContextHash !== scope.actorContextHash || operation.targetType !== 'project-version' ||
      operation.targetId !== scope.resultVersionId || operation.leaseExpiresAt === null ||
      operation.leaseExpiresAt.getTime() <= now.getTime())) throw new DomainError(
        'PERSISTENCE_CONFLICT', 'Director operation lease changed before canonical snapshot preparation',
      )
    return now
  }

  private async commitBundle(transaction: Prisma.TransactionClient, bundle: DirectorCommitView): Promise<Readonly<DirectorRunResult>> {
    const decisionLog = parseDirectorDecisionLog(bundle.decisionLog)
    if (
      decisionLog.workspaceId !== bundle.run.workspaceId ||
      decisionLog.projectId !== bundle.run.projectId ||
      decisionLog.runId !== bundle.run.id ||
      decisionLog.commandId !== bundle.command.id ||
      decisionLog.resultVersionId !== bundle.version.id ||
      stableSerialize(decisionLog.entries.map((entry) => entry.id)) !== stableSerialize(bundle.run.decisions.map((decision) => decision.id))
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Director decision log does not match its immutable run')
    const fenceNow = bundle.operationFence
      ? new Date(bundle.operationFence.now)
      : undefined
    if (bundle.operationFence && (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(bundle.operationFence.operationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(bundle.operationFence.leaseOwner) ||
      !Number.isSafeInteger(bundle.operationFence.attempt) ||
      bundle.operationFence.attempt < 1 ||
      !fenceNow || Number.isNaN(fenceNow.getTime())
    )) throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation fence is invalid')
    const key = {
      workspaceId_projectId_idempotencyKey: {
        workspaceId: bundle.command.workspaceId,
        projectId: bundle.command.projectId,
        idempotencyKey: bundle.command.idempotencyKey,
      },
    }
    const existing = await transaction.v2EditCommand.findUnique({
      where: key,
      include: { directorRun: { include: directorRunInclude } },
    })
    if (existing) {
      if (existing.requestFingerprint !== bundle.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with different Director input')
      if (
        hydrateEditCommandExternalActorAudit(existing).contextHash !==
        bundle.authenticationAudit.contextHash
      ) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Director replay belongs to another authentication context')
      if (!existing.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Director idempotency result is missing')
      if (bundle.operationFence) {
        const settled = await transaction.v2PublicOperation.findFirst({
          where: {
            id: bundle.operationFence.operationId,
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            type: 'project-director-run',
            status: 'succeeded',
            phase: 'completed',
            targetType: 'project-version',
            targetId: existing.directorRun.resultVersionId,
          },
          select: { id: true },
        })
        if (!settled || existing.directorRun.operationId !== settled.id) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Director replay is not bound to the settled operation')
        }
      }
      return hydrateStoredRun(existing.directorRun, true)
    }
    if (bundle.operationFence) {
      const origin = await transaction.v2PublicOperation.findFirst({
        where: {
          id: bundle.operationFence.operationId,
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          type: 'project-director-run',
          status: 'running',
          phase: 'directing',
          attempt: bundle.operationFence.attempt,
          leaseOwner: bundle.operationFence.leaseOwner,
          leaseExpiresAt: { gt: fenceNow! },
          targetType: 'project-version',
          targetId: bundle.version.id,
        },
        include: { projectDirectorRun: true },
      })
      const originContext = origin?.projectDirectorRun
      if (
        !origin ||
        !originContext ||
        originContext.baseVersionId !== bundle.command.baseVersionId ||
        originContext.baseHash !== bundle.command.baseHash ||
        originContext.baseObjective !== bundle.command.payload.previousObjective ||
        originContext.objective !== bundle.command.payload.objective ||
        originContext.objectiveVersion !== bundle.command.payload.objectiveVersion ||
        originContext.rubricRef !== bundle.command.payload.rubricRef ||
        (originContext.supersedesRunId ?? undefined) !== bundle.command.payload.supersedesRunId ||
        hydrateExternalActorAudit(origin, origin.clientId).contextHash !==
          bundle.authenticationAudit.contextHash
      ) throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Director worker provenance does not match its originating operation',
      )
      const enteredPersisting = await transaction.v2PublicOperation.updateMany({
        where: {
          id: bundle.operationFence.operationId,
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          type: 'project-director-run',
          status: 'running',
          phase: 'directing',
          attempt: bundle.operationFence.attempt,
          leaseOwner: bundle.operationFence.leaseOwner,
          leaseExpiresAt: { gt: fenceNow! },
          targetType: 'project-version',
          targetId: bundle.version.id,
        },
        data: {
          phase: 'persisting',
          progressCompleted: 1,
          progressTotal: 2,
          progressUnit: 'stage',
          updatedAt: fenceNow!,
        },
      })
      if (enteredPersisting.count !== 1) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation lease was lost before commit')
      }
    }
    const [project, transcript, sourceMaster] = await Promise.all([
      transaction.v2Project.findFirst({
        where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
        include: {
          currentVersion: true,
          directorRuns: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            include: { qualitySnapshot: true },
          },
        },
      }),
      transaction.v2MediaTranscript.findFirst({ where: {
        id: bundle.sourceEvidence.transcriptId,
        projectId: bundle.command.projectId,
        workspaceId: bundle.command.workspaceId,
        sourceArtifactId: bundle.sourceEvidence.sourceArtifactId,
        transcriptHash: bundle.sourceEvidence.transcriptHash,
      } }),
      transaction.v2ProjectMediaAsset.findFirst({ where: {
        projectId: bundle.command.projectId,
        workspaceId: bundle.command.workspaceId,
        artifactId: bundle.sourceEvidence.sourceArtifactId,
        role: 'source-master',
      } }),
    ])
    if (!project?.currentVersion || !transcript || !sourceMaster) throw new DomainError('PERSISTENCE_CONFLICT', 'Director source evidence disappeared before commit')
    const latestOcr = await transaction.v2PerceptionProducerEnvelope.findFirst({
      where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
        projectVersionId: bundle.command.baseVersionId,
        sourceArtifactId: bundle.sourceEvidence.sourceArtifactId, modality: 'ocr' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
    })
    if ((latestOcr?.id ?? undefined) !== bundle.sourceEvidence.ocrEnvelope?.id) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director OCR selection changed before commit')
    }
    if (latestOcr) {
      const resolvedOcr = await readPerceptionProducerEnvelope(transaction, {
        id: latestOcr.id, workspaceId: bundle.command.workspaceId,
        projectId: bundle.command.projectId, inputVersionId: bundle.command.baseVersionId,
        now: this.clock(),
      })
      const selected = bundle.sourceEvidence.ocrEnvelope
      if (!resolvedOcr) throw new DomainError('PERSISTENCE_CONFLICT',
        'Selected OCR envelope disappeared before Director commit')
      const expectedOcr = expectedOcrTimeline(resolvedOcr,
        bundle.run.editPlan.fps, bundle.run.editPlan.durationFrames)
      if (!selected || resolvedOcr.envelopeHash !== selected.envelopeHash ||
          resolvedOcr.projectVersionId !== selected.inputVersionId ||
          resolvedOcr.sourceArtifactId !== selected.sourceArtifactId ||
          resolvedOcr.timeMapHash !== selected.timeMapHash ||
          bundle.run.perception.schemaVersion !== 2 ||
          bundle.run.perception.inputVersionId !== bundle.command.baseVersionId ||
          stableSerialize(bundle.run.perception.ocrEvidence) !== stableSerialize(ocrSnapshotEvidence(resolvedOcr)) ||
          !bundle.run.decisions.some((decision) => decision.evidenceRefs.includes(resolvedOcr.id)) ||
          stableSerialize(bundle.run.perception.timeline.observations
            .filter((item) => item.kind === 'ocr')) !==
            stableSerialize(expectedOcr.observations) ||
          stableSerialize(bundle.run.perception.timeline.coverage.find((entry) =>
            entry.kind === 'ocr')) !== stableSerialize(expectedOcr.coverage.find((entry) =>
            entry.kind === 'ocr'))) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director OCR evidence is not bound to the sealed input')
      }
    } else if (bundle.run.perception.schemaVersion !== 2 ||
        bundle.run.perception.inputVersionId !== bundle.command.baseVersionId ||
        bundle.run.perception.ocrEvidence !== undefined ||
        bundle.run.perception.timeline.coverage.find((item) => item.kind === 'ocr')?.observedMs !== 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director perception claims OCR without a sealed envelope')
    }
    const targetObjective = resolveStrategicObjective(bundle.command.payload.objective)
    const latestRun = project.directorRuns[0]
    const latestQuality = latestRun
      ? parseRecord(latestRun.qualitySnapshot.contentJson, 'latest Director quality report')
      : undefined
    const objectiveBinding = bindDirectorObjective({
      objective: targetObjective.id,
      ...(latestRun
        ? {
            previous: {
              runId: latestRun.id,
              objective: resolveStrategicObjective(latestRun.objective).id,
              objectiveVersion: latestRun.objectiveVersion,
              rubricRef: latestRun.rubricRef,
              ...(latestRun.supersedesRunId
                ? { supersedesRunId: latestRun.supersedesRunId }
                : {}),
              approved: ['approved', 'approved-with-warnings'].includes(
                String(latestQuality?.status),
              ),
            },
          }
        : {}),
    })
    const changedObjective = targetObjective.id !== project.objective
    const briefSnapshotChanged =
      bundle.command.payload.snapshotRefs.brief !== project.currentVersion.briefSnapshotId
    const proposedBrief = bundle.snapshots.find(
      (item) => item.id === bundle.command.payload.snapshotRefs.brief,
    )
    if (
      project.objective !== bundle.command.payload.previousObjective ||
      bundle.run.objective !== targetObjective.id ||
      bundle.run.objectiveVersion !== objectiveBinding.objectiveVersion ||
      bundle.run.rubricRef !== objectiveBinding.rubricRef ||
      bundle.run.supersedesRunId !== objectiveBinding.supersedesRunId ||
      (changedObjective && !briefSnapshotChanged) ||
      (briefSnapshotChanged && proposedBrief?.kind !== 'brief')
    ) throw new DomainError(
      'VERSION_CONFLICT',
      'Project strategic objective changed before Director commit',
    )
    if (proposedBrief) {
      const brief = parseRecord(proposedBrief.contentJson, 'proposed Director brief')
      if (brief.objective !== targetObjective.id) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director brief objective is inconsistent')
      }
    }
    if (
      project.currentVersion.id !== bundle.command.baseVersionId ||
      project.currentVersion.baseHash !== bundle.command.baseHash ||
      bundle.version.parentVersionId !== project.currentVersion.id ||
      bundle.version.sequence !== project.currentVersion.sequence + 1 ||
      bundle.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash
    ) throw new DomainError('VERSION_CONFLICT', 'Project version changed before Director commit', { currentVersionId: project.currentVersion.id, currentBaseHash: project.currentVersion.baseHash })
    const [proxyOutputs, finalOutputs] = await Promise.all([
      transaction.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      transaction.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    const currentOutputs = [
      ...proxyOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: bundle.command.baseVersionId, variantId: project.format ?? '9:16' })),
      ...finalOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: bundle.command.baseVersionId, variantId: output.outputAspectRatio })),
    ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
    if (stableSerialize(currentOutputs) !== stableSerialize(bundle.command.payload.impact.affectedArtifacts)) {
      throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before Director impact commit')
    }
    // Lock only the rows returned by this owner, in a deterministic order,
    // then confront IDs and tuples again before any Command/Version seal is stored.
    for (const item of [...bundle.snapshots].sort((left, right) =>
      Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8')))) {
      const locked = await transaction.$queryRaw<readonly { id: string }[]>(Prisma.sql`
        SELECT "id" FROM "project_snapshots"
        WHERE "id" = ${item.id} AND "workspaceId" = ${item.workspaceId} AND "projectId" = ${item.projectId}
        FOR SHARE
      `)
      const row = await transaction.v2ProjectSnapshot.findUnique({ where: { id: item.id } })
      const tuple = await transaction.v2ProjectSnapshot.findUnique({ where: {
        projectId_kind_contentHash: { projectId: item.projectId, kind: item.kind, contentHash: item.contentHash },
      } })
      if (locked.length !== 1 || !row || !tuple || row.id !== tuple.id ||
        row.createdAt.toISOString() !== item.createdAt) throw new DomainError(
          'PERSISTENCE_CONFLICT', 'Director canonical snapshot identity changed before commit',
        )
      assertDirectorSnapshotContent(item, this.snapshotFromRow(row))
    }
    await commitProjectVersionWithOutputState(transaction, bundle.bundle)
    const refs = bundle.command.payload.snapshotRefs
    await transaction.v2DirectorRun.create({ data: {
      id: bundle.run.id,
      workspaceId: bundle.run.workspaceId,
      projectId: bundle.run.projectId,
      commandId: bundle.run.commandId,
      baseVersionId: bundle.run.baseVersionId,
      resultVersionId: bundle.run.resultVersionId,
      status: bundle.run.status,
      plannerVersion: bundle.run.plannerVersion,
      criticVersion: bundle.run.criticVersion,
      objective: bundle.run.objective,
      objectiveVersion: bundle.run.objectiveVersion,
      rubricRef: bundle.run.rubricRef,
      supersedesRunId: bundle.run.supersedesRunId,
      perceptionSnapshotId: refs.perception,
      treatmentSnapshotId: refs.treatment,
      storySnapshotId: refs.story,
      editPlanSnapshotId: refs.editPlan,
      qualitySnapshotId: refs.quality,
      decisionsJson: stableSerialize(bundle.run.decisions),
      decisionLogJson: stableSerialize(decisionLog),
      decisionLogHash: decisionLog.logHash,
      assumptionsJson: stableSerialize(bundle.run.assumptions),
      initiatedByType: bundle.run.initiatedBy.type,
      initiatedById: bundle.run.initiatedBy.id,
      operationId: bundle.operationFence?.operationId,
      createdAt: new Date(bundle.run.createdAt),
    } })
    const invalidations = createDirectorRunInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
    if (invalidations.length > 0) {
      await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
        id: item.id, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
        commandId: item.commandId, baseVersionId: item.baseVersionId, resultVersionId: item.resultVersionId,
        artifactId: item.artifactId, kind: item.kind, variantId: item.variantId, status: item.status,
        dependencyTypesJson: stableSerialize(item.dependencyTypes), affectedRangesJson: stableSerialize(item.affectedRanges),
        impactHash: item.impactHash, createdAt: new Date(item.createdAt),
      })) })
    }
    const updated = await transaction.v2Project.updateMany({
      where: {
        id: bundle.command.projectId,
        workspaceId: bundle.command.workspaceId,
        currentVersionId: bundle.command.baseVersionId,
        objective: bundle.command.payload.previousObjective,
      },
      data: {
        currentVersionId: bundle.version.id,
        objective: bundle.command.payload.objective,
      },
    })
    if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during Director commit')
    await transaction.v2PublicEventOutbox.create({ data: {
      id: bundle.event.id,
      workspaceId: bundle.event.workspaceId,
      type: bundle.event.type,
      version: bundle.event.version,
      occurredAt: new Date(bundle.event.occurredAt),
      sequence: bundle.event.sequence,
      actorClientId: bundle.event.actor?.clientId,
      actorUserId: bundle.event.actor?.userId,
      resourceType: bundle.event.resource.type,
      resourceId: bundle.event.resource.id,
      dataJson: stableSerialize(bundle.event.data),
    } })
    if (bundle.operationFence) {
      const clocks = await transaction.$queryRaw<readonly { now: Date }[]>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
      const completedAt = clocks[0]?.now
      if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) throw new DomainError(
        'PERSISTENCE_CONFLICT', 'Director settlement clock is unavailable',
      )
      const settled = await transaction.v2PublicOperation.updateMany({
        where: {
          id: bundle.operationFence.operationId,
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          type: 'project-director-run',
          status: 'running',
          phase: 'persisting',
          attempt: bundle.operationFence.attempt,
          leaseOwner: bundle.operationFence.leaseOwner,
          leaseExpiresAt: { gt: completedAt },
          targetType: 'project-version',
          targetId: bundle.version.id,
        },
        data: {
          status: 'succeeded',
          phase: 'completed',
          progressCompleted: 2,
          progressTotal: 2,
          progressUnit: 'stage',
          cancelable: false,
          retryable: false,
          resultJson: stableSerialize({
            resource: { type: 'project-version', id: bundle.version.id },
          }),
          updatedAt: completedAt,
          completedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          nextAttemptAt: null,
          deadLetteredAt: null,
        },
      })
      if (settled.count !== 1) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation lease was lost during commit')
      }
      const settledOperation = await transaction.v2PublicOperation.findUnique({
        where: { id: bundle.operationFence.operationId },
        select: { clientId: true },
      })
      if (!settledOperation) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Settled Director operation disappeared during commit',
        )
      }
      await persistOperationStatusEvents(
        transaction,
        'running',
        {
          id: bundle.operationFence.operationId,
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          clientId: settledOperation.clientId,
          type: 'project-director-run',
          status: 'succeeded',
          phase: 'completed',
          attempt: bundle.operationFence.attempt,
          updatedAt: completedAt.toISOString(),
        },
        randomUUID,
      )
    }
    const stored = await transaction.v2DirectorRun.findUniqueOrThrow({ where: { id: bundle.run.id }, include: directorRunInclude })
    return hydrateStoredRun(stored, false)
  }
}
