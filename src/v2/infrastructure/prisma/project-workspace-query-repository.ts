import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ProjectWorkspaceQueryRepository,
  ProjectWorkspaceMediaRecord,
  ProjectWorkspaceOutput,
  ProjectWorkspaceOutputPurposeVerdict,
  ProjectReviewAvailability,
} from '../../application/ports/project-workspace-query-repository.ts'
import { readReviewPreviewAvailability, readStoredProjectionManifest } from './review-annotation-repository.ts'
import { readStoredOutputStateV3 } from './output-state-consumption.ts'
import {
  outputConsumptionVerdictV3,
  outputEntryAspectRatio,
  publishedConsumptionReason,
  type OutputConsumptionEntry,
  type OutputConsumptionPurpose,
  type OutputConsumptionState,
} from '../../domain/output-consumption.ts'
import { readCurrentProxyReview } from './proxy-review-repository.ts'
import { readPublicOperation } from './public-operation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'
import {
  CONFIDENCE_BAND_POLICY_V2_SHA256,
  classifyConfidence,
  classifyConfidenceV2,
  createDecisionConfidence,
  isEvidenceGatedType,
  type ConfidenceDecisionType,
  type ConfidenceDecisionTypeV2,
} from '../../domain/decision-confidence.ts'
import { parseDecisionPerceptionEvidence } from '../../domain/director-evidence-rubric.ts'
import { PROJECT_STATUSES, type ProjectStatus } from '../../domain/project.ts'
import { parseProductionBrief } from '../../domain/production-brief.ts'
import { parseBriefCompilation } from '../../application/compile-brief.ts'

function hydrateProjectStatus(value: string): ProjectStatus {
  if (!PROJECT_STATUSES.includes(value as ProjectStatus)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project status is invalid')
  }
  return value as ProjectStatus
}

function parseJson(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseJsonArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

export function projectConfidenceUncertainties(values: readonly unknown[]) {
  try {
    return Object.freeze(values.flatMap((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
      const record = value as Record<string, unknown>
      const detail = record.confidenceDetail
      if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return []
      const confidence = createDecisionConfidence(detail as Parameters<typeof createDecisionConfidence>[0])
      if (confidence.confidenceHash !== (detail as Record<string, unknown>).confidenceHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director decision confidence hash is invalid')
      }
      const type = record.decisionType as ConfidenceDecisionTypeV2
      // W64. A decision graded by confidence-band-policy/v2 is graded on (tier, confidence); one that is not, by v1 as ever.
      const policy = record.bandPolicy as Record<string, unknown> | undefined
      let band
      if (policy === undefined) {
        band = classifyConfidence(type as ConfidenceDecisionType, confidence)
      } else {
        if (policy.schemaVersion !== 'confidence-band-policy/v2' || policy.policyHash !== CONFIDENCE_BAND_POLICY_V2_SHA256) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Director decision was graded by an unknown band policy')
        }
        band = isEvidenceGatedType(type)
          ? classifyConfidenceV2(type, confidence, parseDecisionPerceptionEvidence(record.perceptionEvidence).tier)
          : classifyConfidenceV2(type, confidence)
      }
      if (band === 'auto-apply') return []
      if (record.confidenceBand !== band || typeof record.id !== 'string' || typeof record.choice !== 'string') {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director decision confidence projection is invalid')
      }
      return [Object.freeze({
        id: record.id,
        label: record.choice,
        type,
        band,
        value: confidence.value,
        reasonCodes: confidence.reasonCodes,
        calibrationVersion: confidence.calibrationVersion,
        evidenceCount: confidence.evidence.length,
      })]
    }).toSorted((left, right) =>
      left.value - right.value || left.id.localeCompare(right.id)))
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director decision confidence is invalid')
  }
}

function probeFromManifest(manifest: Readonly<MediaArtifactManifest>): ProjectWorkspaceMediaRecord['probe'] {
  return manifest.probe ? { ...manifest.probe } : undefined
}

/**
 * What each consumer purpose answers for one output of a State, as a description: the domain verdict (`outputConsumptionVerdictV3`)
 * with the reason it publishes when the output is blocked. A critic also needs a format to critique, so an output whose spec carries
 * no aspect ratio is `output-not-consumable` for it (the same refusal the critic readers publish). Never throws for a blocked
 * entry; the consumer still evaluates its own fences when it is asked.
 */
function describeOutputConsumption(state: OutputConsumptionState, entry: OutputConsumptionEntry, aspectRatio: string | null,
  targetPerceptionAuthority: boolean): ProjectWorkspaceOutput['consumption'] {
  const describe = (purpose: OutputConsumptionPurpose): ProjectWorkspaceOutputPurposeVerdict => {
    const verdict = outputConsumptionVerdictV3(state, entry.variantId, purpose, purpose === 'final' && targetPerceptionAuthority)
    if (verdict.status === 'blocked') return Object.freeze({ status: 'blocked' as const, reason: publishedConsumptionReason(verdict.reasons) })
    if (purpose === 'critic' && aspectRatio === null) return Object.freeze({ status: 'blocked' as const, reason: 'output-not-consumable' })
    return Object.freeze({ status: 'allowed' as const })
  }
  return Object.freeze({ render: describe('render'), critic: describe('critic'), final: describe('final') })
}

/**
 * The outputs of the State the head Version seals, in State order, each with its stable variant, its aspect ratio and what every
 * consumer purpose would answer for it. A head whose State is not a consumable document (a Creation fork root, or an unsealed
 * historical Version) has none. The project's own `format` is derived from this list (the ratio of the only output), never from the
 * stored `projects.format` column, which a project created under contract 6 never had.
 *
 * This is a description, not a consumption: a copy no editorial cut has materialized, or an entry the State blocks, is listed with
 * the format it was copied or configured with and the reason it is blocked. A State that fails its own seal is an integrity
 * failure and propagates.
 */
async function readHeadOutputs(client: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>,
  scope: Readonly<{ workspaceId: string; projectId: string; versionId: string }>): Promise<readonly ProjectWorkspaceOutput[]> {
  let stored
  try {
    stored = await readStoredOutputStateV3(client, scope)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED') return Object.freeze([])
    throw error
  }
  if (!stored) return Object.freeze([])
  const targetPerceptionAuthority = stored.targetPerceptionAuthority
  // A Creation fork root (State2) still lists the outputs it was copied with, every purpose blocked by the reason its State records.
  return Object.freeze(stored.state.document.entries.map((entry) => {
    const aspectRatio = outputEntryAspectRatio(entry as OutputConsumptionEntry)
    return Object.freeze({
      variantId: entry.variantId,
      ...(aspectRatio === null ? {} : { aspectRatio }),
      consumption: describeOutputConsumption(stored.state, entry as OutputConsumptionEntry, aspectRatio, targetPerceptionAuthority),
    })
  }))
}

/**
 * The proxy review the workspace reports for the head Version. A review belongs to one output: with at most one output that is the
 * Version's review; with several, the first output (State order) that has one is reported, because the workspace only says whether a
 * report exists to open. The report of a given output is read with that output's `variantId` (`outputs` lists them).
 */
async function readHeadProxyReview(client: Parameters<typeof readCurrentProxyReview>[0],
  scope: Readonly<{ workspaceId: string; projectId: string }>, versionId: string, outputs: readonly ProjectWorkspaceOutput[]) {
  if (outputs.length === 0) return null
  if (outputs.length === 1) return readCurrentProxyReview(client, { ...scope, projectVersionId: versionId })
  for (const output of outputs) {
    const found = await readCurrentProxyReview(client, { ...scope, projectVersionId: versionId, variantId: output.variantId })
    if (found) return found
  }
  return null
}

export class PrismaProjectWorkspaceQueryRepository implements ProjectWorkspaceQueryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async read(input: { workspaceId: string; projectId: string }) {
    return this.client.$transaction(async (transaction) => {
      const project = await transaction.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: {
          currentVersion: { include: { briefSnapshot: true, editPlanSnapshot: true } },
          editCommands: {
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { resultVersion: { select: { id: true } } },
          },
          directorRuns: {
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { qualitySnapshot: true, editPlanSnapshot: true },
          },
          mediaAssets: {
            orderBy: { createdAt: 'asc' },
            include: {
              artifact: {
                include: {
                  currentRightsSnapshot: { select: { status: true } },
                  manifests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
                    include: { recipeParameters: true, renderInput: true } },
                },
              },
            },
          },
          mediaTranscripts: { orderBy: { createdAt: 'desc' } },
          mediaIngestOperations: { orderBy: { createdAt: 'desc' }, select: { operationId: true, createdAt: true } },
          proxyRenderOperations: { orderBy: { createdAt: 'desc' }, select: { operationId: true, createdAt: true } },
          finalExportOperations: { orderBy: { createdAt: 'desc' }, select: { operationId: true, createdAt: true } },
        },
      })
      if (!project) return null
      if (Boolean(project.currentVersionId) !== Boolean(project.currentVersion) || (project.currentVersionId && (
        !project.currentVersion || project.currentVersion.id !== project.currentVersionId ||
        project.currentVersion.projectId !== input.projectId || project.currentVersion.workspaceId !== input.workspaceId
      ))) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace current version is inconsistent')
      const requestedVersionId = project.currentVersionId
      const outputs = requestedVersionId ? await readHeadOutputs(transaction, { ...input, versionId: requestedVersionId }) : Object.freeze([])
      const outputFormat = outputs.length === 1 ? outputs[0]!.aspectRatio ?? null : null
      const [preview, report] = requestedVersionId
        ? await Promise.all([
            readReviewPreviewAvailability(transaction, { ...input, projectVersionId: requestedVersionId }),
            readHeadProxyReview(transaction, input, requestedVersionId, outputs),
          ])
        : [null, null]
      if (preview && (preview.currentProjectVersionId !== requestedVersionId || preview.projectVersionId !== requestedVersionId)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace preview version is inconsistent')
      }
      if (report) {
        const published = await transaction.v2ProjectProxyRenderOperation.findFirst({
          where: { operationId: report.operationId, ...input },
          include: { operation: true },
        })
        const [artifact, manifest] = await Promise.all([
          transaction.v2MediaArtifact.findFirst({ where: { id: report.proxyArtifactId, workspaceId: input.workspaceId } }),
          transaction.v2MediaArtifactManifest.findFirst({ where: { id: report.proxyManifestId, artifactId: report.proxyArtifactId, workspaceId: input.workspaceId },
            include: { recipeParameters: true, renderInput: true } }),
        ])
        if (report.projectVersionId !== requestedVersionId || !published ||
          published.projectVersionId !== requestedVersionId || published.operation.workspaceId !== input.workspaceId ||
          published.operation.projectId !== input.projectId || published.operation.status !== 'succeeded' ||
          published.outputArtifactId !== report.proxyArtifactId || published.outputManifestId !== report.proxyManifestId ||
          !artifact || artifact.status !== 'available' || !manifest || published.inputHash !== report.inputHash
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace proxy review publication is inconsistent')
        readStoredProjectionManifest(input.workspaceId, artifact, manifest)
      }
      const reviewAvailability: Readonly<ProjectReviewAvailability> = Object.freeze({
        schemaVersion: 'project-review-availability/v1', requestedVersionId,
        annotations: preview
          ? Object.freeze({ state: 'available', sourceVersionId: preview.sourceVersionId,
              proxyArtifactId: preview.proxyArtifactId, proxyHash: preview.proxyHash, stale: preview.stale })
          : Object.freeze({ state: 'unavailable', reason: requestedVersionId ? 'no-proxy' : 'no-version' }),
        proxyReview: report
          ? Object.freeze({ state: 'available', sourceVersionId: report.projectVersionId,
              reviewId: report.id, proxyArtifactId: report.proxyArtifactId, reviewHash: report.reviewHash })
          : Object.freeze({ state: 'unavailable', reason: requestedVersionId ? 'no-report' : 'no-version' }),
      })
      const operationIds = Object.freeze([
        ...project.finalExportOperations, ...project.proxyRenderOperations, ...project.mediaIngestOperations,
      ].toSorted((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).map((item) => item.operationId))
      const operations = await Promise.all(operationIds.map(async (operationId) => {
        const record = await readPublicOperation(transaction, input.workspaceId, operationId)
        if (!record || record.operation.workspaceId !== input.workspaceId || record.operation.projectId !== input.projectId)
          throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace operation is missing or belongs to another project')
        return record.operation
      }))
      const media = project.mediaAssets.map((link) => {
        const storedManifest = link.artifact.manifests[0]
        if (!storedManifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Project media artifact has no manifest')
        const manifest = readStoredProjectionManifest(input.workspaceId, link.artifact, storedManifest)
        const probe = probeFromManifest(manifest)
        return Object.freeze({
          id: link.id,
          role: link.role as 'source-master' | 'editing-proxy' | 'editorial-proxy' | 'final-output',
          originalFileName: link.originalFileName,
          artifactId: link.artifactId,
          manifestId: storedManifest.id,
          mediaType: link.artifact.mediaType as 'video' | 'audio' | 'image',
          container: link.artifact.container,
          byteSize: link.artifact.byteSize.toString(),
          sha256: link.artifact.sha256,
          status: link.artifact.status,
          ...(link.artifact.currentRightsSnapshot ? { rightsStatus: link.artifact.currentRightsSnapshot.status } : {}),
          ...(probe ? { probe } : {}),
          createdAt: link.createdAt.toISOString(),
        })
      })
      const transcripts = project.mediaTranscripts.map((row) => {
        const transcript = parseJson(row.transcriptJson, 'media transcript')
        return Object.freeze({
          id: row.id, sourceArtifactId: row.sourceArtifactId, language: row.language,
          provider: row.provider, model: row.model, transcriptHash: row.transcriptHash,
          text: typeof transcript.text === 'string' ? transcript.text : '',
          wordCount: Array.isArray(transcript.words) ? transcript.words.length : 0,
          segmentCount: Array.isArray(transcript.segments) ? transcript.segments.length : 0,
          createdAt: row.createdAt.toISOString(),
        })
      })
      const editPlan = project.currentVersion
        ? parseJson(project.currentVersion.editPlanSnapshot.contentJson, 'project EditPlan')
        : undefined
      const brief = project.currentVersion
        ? parseJson(project.currentVersion.briefSnapshot.contentJson, 'project brief')
        : undefined
      if (brief) {
        brief.productionBrief = parseProductionBrief(brief.productionBrief)
        // The editorial request has its own read (apollo.projects.editorial-request.read); the workspace brief does not carry it.
        delete brief.editorialRequest
        if (brief.briefCompilation !== undefined) {
          brief.briefCompilation = parseBriefCompilation(brief.briefCompilation)
        }
      }
      const videoTracks = editPlan && Array.isArray(editPlan.videoTracks) ? editPlan.videoTracks : []
      const clipCount = videoTracks.reduce((total, track) => {
        if (typeof track !== 'object' || track === null || Array.isArray(track)) return total
        const clips = (track as Record<string, unknown>).clips
        return total + (Array.isArray(clips) ? clips.length : 0)
      }, 0)
      const markers = editPlan && Array.isArray(editPlan.markers) ? editPlan.markers : []
      const movementPolicy = editPlan && typeof editPlan.movementPolicy === 'object' && editPlan.movementPolicy !== null && !Array.isArray(editPlan.movementPolicy)
        ? editPlan.movementPolicy as Record<string, unknown>
        : {}
      const subtitlePolicy = editPlan && typeof editPlan.subtitlePolicy === 'object' && editPlan.subtitlePolicy !== null && !Array.isArray(editPlan.subtitlePolicy)
        ? editPlan.subtitlePolicy as Record<string, unknown>
        : {}
      const directorRuns = project.directorRuns.map((run) => {
        const quality = parseJson(run.qualitySnapshot.contentJson, 'Director quality report')
        const directedPlan = parseJson(run.editPlanSnapshot.contentJson, 'Director EditPlan')
        const decisions = parseJsonArray(run.decisionsJson, 'Director decisions')
        const assumptions = parseJsonArray(run.assumptionsJson, 'Director assumptions')
        const subtitleTracks = Array.isArray(directedPlan.subtitleTracks) ? directedPlan.subtitleTracks : []
        const subtitleCueCount = subtitleTracks.reduce((total, track) => {
          if (typeof track !== 'object' || track === null || Array.isArray(track)) return total
          const cues = (track as Record<string, unknown>).cues
          return total + (Array.isArray(cues) ? cues.length : 0)
        }, 0)
        return Object.freeze({
          id: run.id,
          status: run.status,
          plannerVersion: run.plannerVersion,
          criticVersion: run.criticVersion,
          objective: run.objective,
          objectiveVersion: run.objectiveVersion,
          rubricRef: run.rubricRef,
          ...(run.supersedesRunId ? { supersedesRunId: run.supersedesRunId } : {}),
          baseVersionId: run.baseVersionId,
          resultVersionId: run.resultVersionId,
          treatmentSnapshotId: run.treatmentSnapshotId,
          storySnapshotId: run.storySnapshotId,
          qualitySnapshotId: run.qualitySnapshotId,
          qualityStatus: typeof quality.status === 'string' ? quality.status : 'unknown',
          qualityScore: typeof quality.score === 'number' ? quality.score : 0,
          decisionCount: decisions.length,
          assumptionCount: assumptions.length,
          uncertainties: projectConfidenceUncertainties(decisions),
          subtitleCueCount,
          transitionCount: Array.isArray(directedPlan.transitions) ? directedPlan.transitions.length : 0,
          automaticZoom: typeof directedPlan.movementPolicy === 'object' && directedPlan.movementPolicy !== null && !Array.isArray(directedPlan.movementPolicy)
            ? (directedPlan.movementPolicy as Record<string, unknown>).automaticZoom === true
            : false,
          createdAt: run.createdAt.toISOString(),
        })
      })
      return Object.freeze({
        reviewAvailability,
        operations: Object.freeze(operations),
        project: Object.freeze({
          id: project.id, workspaceId: project.workspaceId, name: project.name,
          status: hydrateProjectStatus(project.status),
          ...(project.objective ? { objective: project.objective } : {}), ...(outputFormat ? { format: outputFormat } : {}),
          ...(project.locale ? { locale: project.locale } : {}), ...(project.currentVersionId ? { currentVersionId: project.currentVersionId } : {}),
          createdAt: project.createdAt.toISOString(),
        }),
        outputs,
        ...(project.currentVersion ? { version: Object.freeze({ id: project.currentVersion.id, sequence: project.currentVersion.sequence, baseHash: project.currentVersion.baseHash, createdAt: project.currentVersion.createdAt.toISOString() }) } : {}),
        ...(brief ? { brief: Object.freeze(brief) } : {}),
        ...(editPlan ? { editPlan: Object.freeze({
          id: typeof editPlan.id === 'string' ? editPlan.id : project.currentVersion!.editPlanSnapshotId,
          state: typeof editPlan.state === 'string' ? editPlan.state : 'unknown',
          fps: typeof editPlan.fps === 'number' ? editPlan.fps : 0,
          durationFrames: typeof editPlan.durationFrames === 'number' ? editPlan.durationFrames : 0,
          clipCount,
          cutCount: markers.filter((marker) => typeof marker === 'object' && marker !== null && !Array.isArray(marker) && (marker as Record<string, unknown>).kind === 'editorial-cut').length,
          automaticZoom: movementPolicy.automaticZoom === true,
          subtitleFaceProtection: subtitlePolicy.faceProtection === true,
        }) } : {}),
        commands: Object.freeze(project.editCommands.map((command) => Object.freeze({
          id: command.id,
          type: command.type,
          baseVersionId: command.baseVersionId,
          ...(command.resultVersion ? { resultVersionId: command.resultVersion.id } : {}),
          ...(command.reason ? { reason: command.reason } : {}),
          createdAt: command.createdAt.toISOString(),
        }))),
        directorRuns: Object.freeze(directorRuns),
        media: Object.freeze(media),
        transcripts: Object.freeze(transcripts),
        operationIds,
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 10_000 })
  }
}
