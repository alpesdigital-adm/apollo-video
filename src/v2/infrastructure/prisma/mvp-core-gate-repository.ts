import {
  Prisma,
  type PrismaClient,
  type V2MvpCoreGate,
} from '../../../../generated/prisma-v2/index.js'

import {
  calculateMvpCoreGateRecordHash,
  type MvpCoreGateReport,
} from '../../application/run-mvp-core-gate.ts'
import type {
  MvpCoreGateEvidenceQuery,
  MvpCoreGateRepository,
  PersistedMvpCoreGate,
} from '../../application/ports/mvp-core-gate-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  evaluateMvpCoreGate,
  type MvpCoreCheckCode,
  type MvpCoreCheckEvidenceInput,
  type MvpCoreCriterion,
  type MvpCoreCriterionEvidenceInput,
  type MvpCoreEvidenceReferenceInput,
  type MvpCoreEvidenceResourceType,
} from '../../domain/mvp-core-gate.ts'
import { hydrateAssetSelection } from './asset-selection-repository.ts'
import { hydrateProxyReview } from './proxy-review-repository.ts'
import { hydrateQualityIteration } from './quality-iteration-repository.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

const SHA_256_PATTERN = /^[a-f0-9]{64}$/

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function ref(
  type: MvpCoreEvidenceResourceType,
  id: string,
  hash?: string | null,
): Readonly<MvpCoreEvidenceReferenceInput> {
  return Object.freeze({
    type,
    id,
    ...(hash && SHA_256_PATTERN.test(hash) ? { hash } : {}),
  })
}

function derivedRef(
  type: MvpCoreEvidenceResourceType,
  label: string,
  value: unknown,
): Readonly<MvpCoreEvidenceReferenceInput> {
  const hash = calculateCanonicalHash(value)
  return ref(type, `${label}-${hash.slice(0, 20)}`, hash)
}

function check(
  code: MvpCoreCheckCode,
  passed: boolean,
  references: readonly Readonly<MvpCoreEvidenceReferenceInput>[],
): Readonly<MvpCoreCheckEvidenceInput> {
  return Object.freeze({
    code,
    passed,
    references: Object.freeze([...references]),
  })
}

function criterion(
  value: MvpCoreCriterion,
  checks: readonly Readonly<MvpCoreCheckEvidenceInput>[],
): Readonly<MvpCoreCriterionEvidenceInput> {
  return Object.freeze({
    criterion: value,
    checks: Object.freeze([...checks]),
  })
}

function canonicalSnapshot(row: {
  id: string
  contentJson: string
  contentHash: string
}) {
  const content = parseJson(row.contentJson, `snapshot ${row.id}`)
  if (
    stableSerialize(content) !== row.contentJson ||
    calculateCanonicalHash(content) !== row.contentHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored snapshot ${row.id} failed integrity validation`,
    )
  }
  return content
}

function containsReference(value: unknown, identity: string): boolean {
  if (value === identity) return true
  if (Array.isArray(value)) {
    return value.some((item) => containsReference(item, identity))
  }
  const object = record(value)
  return object
    ? Object.values(object).some((item) => containsReference(item, identity))
    : false
}

function transcriptIntegrity(row: {
  id: string
  transcriptJson: string
  transcriptHash: string
}) {
  const value = record(parseJson(row.transcriptJson, `transcript ${row.id}`))
  if (!value) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored transcript ${row.id} is invalid`,
    )
  }
  const { transcriptHash: embeddedHash, ...body } = value
  if (
    embeddedHash !== row.transcriptHash ||
    calculateCanonicalHash(body) !== row.transcriptHash ||
    stableSerialize(value) !== row.transcriptJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored transcript ${row.id} failed integrity validation`,
    )
  }
  return value
}

function normalizedSpeech(value: unknown): string {
  return typeof value === 'string'
    ? value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
    : ''
}

function transcriptSignals(transcript: Record<string, unknown> | null) {
  const words = transcript ? array(transcript.words) : []
  const normalizedWords = words.map(record)
  const wordTimestamps =
    normalizedWords.length > 0 &&
    normalizedWords.every((word, index) =>
      word !== null &&
      typeof word.word === 'string' &&
      typeof word.start === 'number' &&
      Number.isFinite(word.start) &&
      typeof word.end === 'number' &&
      Number.isFinite(word.end) &&
      word.start >= 0 &&
      word.end >= word.start &&
      (index === 0 ||
        word.start + 0.05 >= Number(normalizedWords[index - 1]?.start)))
  const silenceRanges = normalizedWords.slice(1).flatMap((word, index) => {
    const previous = normalizedWords[index]
    if (
      !word ||
      !previous ||
      typeof word.start !== 'number' ||
      typeof previous.end !== 'number'
    ) return []
    const gap = word.start - previous.end
    return gap >= 0.45
      ? [{ start: previous.end, end: word.start, duration: gap }]
      : []
  })
  const segments = transcript ? array(transcript.segments).map(record) : []
  const seen = new Set<string>()
  const repeatedSegments = segments.flatMap((segment) => {
    const text = normalizedSpeech(segment?.text)
    if (text.length < 8) return []
    if (seen.has(text)) return [text]
    seen.add(text)
    return []
  })
  return Object.freeze({
    wordTimestamps,
    silenceDetectionRecorded: wordTimestamps,
    retakeDetectionRecorded:
      segments.length > 0 &&
      segments.every((segment) =>
        segment !== null &&
        typeof segment.id === 'number' &&
        typeof segment.start === 'number' &&
        typeof segment.end === 'number' &&
        typeof segment.text === 'string'),
    silenceRanges: Object.freeze(silenceRanges),
    repeatedSegments: Object.freeze(repeatedSegments),
  })
}

function outputResultArtifactId(value: string | null): string | null {
  if (!value) return null
  const result = record(parseJson(value, 'operation result'))
  const resource = record(result?.resource)
  return typeof resource?.id === 'string' ? resource.id : null
}

function manualPayload(value: string): Record<string, unknown> {
  const parsed = record(parseJson(value, 'manual edit payload'))
  if (!parsed) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored manual edit payload is invalid',
    )
  }
  return parsed
}

function manifestComplete(row: {
  schemaVersion: string
  manifestHash: string
  recipeId: string
  recipeVersion: string
  parametersHash: string
  recipeParametersRef: string | null
  renderInputRef: string | null
  renderInputHash: string | null
  manifestJson: string
}) {
  const manifest = record(parseJson(row.manifestJson, 'final manifest'))
  const artifact = record(manifest?.artifact)
  const probe = record(manifest?.probe)
  return Boolean(
    row.schemaVersion === 'media-artifact-manifest/v4' &&
    SHA_256_PATTERN.test(row.manifestHash) &&
    row.recipeId &&
    row.recipeVersion &&
    SHA_256_PATTERN.test(row.parametersHash) &&
    row.recipeParametersRef &&
    row.renderInputRef &&
    row.renderInputHash &&
    SHA_256_PATTERN.test(row.renderInputHash) &&
    artifact &&
    typeof artifact.artifactKey === 'string' &&
    artifact.mediaType === 'video' &&
    artifact.container === 'mp4' &&
    probe &&
    typeof probe.width === 'number' &&
    typeof probe.height === 'number' &&
    typeof probe.duration === 'number' &&
    typeof probe.fps === 'number',
  )
}

function hydrateGate(row: V2MvpCoreGate): Readonly<PersistedMvpCoreGate> {
  hydrateExternalActorAudit(row, row.createdById)
  const reportValue = record(parseJson(row.reportJson, 'MVP core gate report'))
  if (!reportValue || !Array.isArray(reportValue.evidence)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored MVP core gate report is invalid',
    )
  }
  const recomputed = evaluateMvpCoreGate({
    workspaceId: row.workspaceId,
    primaryProjectId: row.primaryProjectId,
    companionProjectId: row.companionProjectId,
    evidence: reportValue.evidence as never,
    evaluatedAt: String(reportValue.evaluatedAt),
  })
  if (
    stableSerialize(recomputed) !== row.reportJson ||
    recomputed.fingerprint !== row.reportFingerprint ||
    recomputed.approved !== row.approved ||
    recomputed.covered !== row.covered ||
    recomputed.passed !== row.passed ||
    recomputed.total !== row.total ||
    row.createdByType !== 'api-client'
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored MVP core gate report failed integrity validation',
    )
  }
  const content = Object.freeze({
    schemaVersion: 'mvp-core-gate/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    primaryProjectId: row.primaryProjectId,
    companionProjectId: row.companionProjectId,
    primaryVersionId: row.primaryVersionId,
    companionVersionId: row.companionVersionId,
    primaryVersionHash: row.primaryVersionHash,
    companionVersionHash: row.companionVersionHash,
    report: recomputed as MvpCoreGateReport,
    reportFingerprint: row.reportFingerprint,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (calculateMvpCoreGateRecordHash(content) !== row.recordHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored MVP core gate record hash is inconsistent',
    )
  }
  return Object.freeze({ ...content, recordHash: row.recordHash })
}

export class PrismaMvpCoreGateRepository implements MvpCoreGateRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async findIdempotent(input: {
    workspaceId: string
    primaryProjectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2MvpCoreGate.findUnique({
      where: {
        workspaceId_primaryProjectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          primaryProjectId: input.primaryProjectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (!row) return null
    const audit = hydrateExternalActorAudit(row, row.createdById)
    if (audit.contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
    return hydrateGate(row)
  }

  async readEvidence(input: Readonly<MvpCoreGateEvidenceQuery>) {
    const [workspace, primary, companion, duplicate, actor] =
      await Promise.all([
        this.client.v2Workspace.findUnique({
          where: { id: input.workspaceId },
        }),
        this.client.v2Project.findFirst({
          where: {
            id: input.primaryProjectId,
            workspaceId: input.workspaceId,
          },
          include: { currentVersion: true },
        }),
        this.client.v2Project.findFirst({
          where: {
            id: input.companionProjectId,
            workspaceId: input.workspaceId,
          },
          include: { currentVersion: true },
        }),
        this.client.v2Project.findFirst({
          where: {
            id: input.duplicateProjectId,
            workspaceId: input.workspaceId,
          },
          include: {
            currentVersion: true,
            mediaAssets: true,
          },
        }),
        this.client.v2ApiClient.findFirst({
          where: {
            id: input.actorId,
            workspaceId: input.workspaceId,
          },
        }),
      ])
    if (!workspace || !primary?.currentVersion || !companion?.currentVersion) {
      return null
    }
    const primaryVersion = primary.currentVersion
    const companionVersion = companion.currentVersion
    if (
      primaryVersion.id !== input.primaryVersionId ||
      primaryVersion.baseHash !== input.primaryVersionHash ||
      companionVersion.id !== input.companionVersionId ||
      companionVersion.baseHash !== input.companionVersionHash
    ) {
      return Object.freeze({
        primaryVersionId: primaryVersion.id,
        primaryVersionHash: primaryVersion.baseHash,
        companionVersionId: companionVersion.id,
        companionVersionHash: companionVersion.baseHash,
        evidence: Object.freeze([]),
      })
    }

    const projectIds = [primary.id, companion.id]
    const [
      snapshots,
      media,
      transcripts,
      directorRuns,
      storedSelections,
      storedReviews,
      storedQualityIterations,
      annotations,
      commands,
      commandResultVersions,
      finalExports,
      operations,
      allDuplicateMedia,
    ] = await Promise.all([
      this.client.v2ProjectSnapshot.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
      }),
      this.client.v2ProjectMediaAsset.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
        include: {
          artifact: {
            include: {
              manifests: {
                include: { lineageEdges: true },
              },
            },
          },
        },
      }),
      this.client.v2MediaTranscript.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
      }),
      this.client.v2DirectorRun.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2AssetSelection.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2ProxyReview.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2QualityIteration.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
        include: { assetSelections: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2ReviewAnnotation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: primary.id,
        },
        include: { patchProposals: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2EditCommand.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: primary.id,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.client.v2ProjectVersion.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: primary.id,
          commandId: { not: null },
        },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: { in: projectIds },
        },
        include: {
          operation: true,
          attempts: { orderBy: { attempt: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2PublicOperation.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: 'desc' },
      }),
      duplicate
        ? this.client.v2ProjectMediaAsset.findMany({
            where: {
              workspaceId: input.workspaceId,
              projectId: { in: [primary.id, duplicate.id] },
            },
          })
        : Promise.resolve([]),
    ])

    const snapshotById = new Map(snapshots.map((snapshot) => [
      snapshot.id,
      { row: snapshot, content: canonicalSnapshot(snapshot) },
    ]))
    const primaryBrief = snapshotById.get(primaryVersion.briefSnapshotId)
    const primaryPolicies = snapshotById.get(primaryVersion.policiesSnapshotId)
    const primaryEditPlan = snapshotById.get(primaryVersion.editPlanSnapshotId)
    const primaryTreatment = primaryVersion.treatmentSnapshotId
      ? snapshotById.get(primaryVersion.treatmentSnapshotId)
      : undefined
    const primaryStory = primaryVersion.storySnapshotId
      ? snapshotById.get(primaryVersion.storySnapshotId)
      : undefined
    const companionEditPlan = snapshotById.get(
      companionVersion.editPlanSnapshotId,
    )
    const companionPolicies = snapshotById.get(
      companionVersion.policiesSnapshotId,
    )
    const briefRecord = record(primaryBrief?.content)
    const productionBrief = record(briefRecord?.productionBrief)
    const briefSummary = record(productionBrief?.summary)
    const briefingOptional =
      briefSummary?.supplied === false &&
      productionBrief?.ownerInput === undefined

    const mediaFor = (projectId: string) =>
      media.filter((item) => item.projectId === projectId)
    const primaryMedia = mediaFor(primary.id)
    const companionMedia = mediaFor(companion.id)
    const primaryMaster = primaryMedia.find((item) =>
      item.role === 'source-master' &&
      item.artifact.status === 'available')
    const primaryProxy = primaryMedia.find((item) =>
      item.role === 'editorial-proxy' &&
      item.artifact.status === 'available')
    const primaryProxyManifest = primaryProxy?.artifact.manifests.find(
      (manifest) => manifest.lineageEdges.some(
        (edge) => edge.sourceArtifactId === primaryMaster?.artifactId,
      ),
    )
    const sourceLineage = Boolean(
      primaryMaster &&
      primaryProxy &&
      primaryProxyManifest,
    )

    const primaryTranscriptRow = transcripts.find(
      (transcript) => transcript.projectId === primary.id,
    )
    const primaryTranscript = primaryTranscriptRow
      ? transcriptIntegrity(primaryTranscriptRow)
      : null
    const signals = transcriptSignals(primaryTranscript)
    const primaryDirector = directorRuns.find(
      (run) => run.projectId === primary.id,
    )
    const companionDirector = directorRuns.find(
      (run) => run.projectId === companion.id,
    )

    const selections = storedSelections.map(hydrateAssetSelection)
    const primarySelections = selections.filter(
      (selection) => selection.projectId === primary.id,
    )
    const companionSelections = selections.filter(
      (selection) => selection.projectId === companion.id,
    )
    const selectedPrimary = primarySelections.find(
      (selection) =>
        selection.result.decision === 'use_asset' &&
        selection.result.selectedId &&
        containsReference(
          primaryEditPlan?.content,
          selection.result.selectedId,
        ),
    )
    const selectedCompanion = companionSelections.find(
      (selection) =>
        selection.result.decision === 'use_asset' &&
        selection.result.selectedId &&
        containsReference(
          companionEditPlan?.content,
          selection.result.selectedId,
        ),
    )
    const primaryTalkingHead =
      primary.format === '9:16' &&
      primaryMaster?.artifact.mediaType === 'video' &&
      Boolean(selectedPrimary)
    const companionMaster = companionMedia.find((item) =>
      item.role === 'source-master' &&
      item.artifact.status === 'available')
    const companionVoiceover =
      companion.format === '16:9' &&
      companionMaster?.artifact.mediaType === 'audio' &&
      Boolean(selectedCompanion)

    const generatedRejection = primarySelections.find((selection) => {
      const generated = selection.candidates.filter(
        (candidate) => candidate.source === 'generated',
      )
      return generated.length > 0 &&
        generated.every((candidate) =>
          selection.result.evaluations.some(
            (evaluation) =>
              evaluation.candidateId === candidate.id &&
              evaluation.verdict === 'rejected',
          ))
    })
    const generatedCandidate = generatedRejection?.candidates.find(
      (candidate) => candidate.source === 'generated',
    )
    const generatedReplacement = selectedPrimary &&
      generatedRejection &&
      selectedPrimary.result.selectedId !== generatedCandidate?.id
      ? selectedPrimary
      : undefined

    const reviews = storedReviews.map(hydrateProxyReview)
    const primaryReview = reviews.find(
      (review) =>
        review.projectId === primary.id &&
        review.projectVersionId === primaryVersion.id,
    ) ?? reviews.find((review) => review.projectId === primary.id)
    const qualityIterations = storedQualityIterations.map(
      hydrateQualityIteration,
    )
    const primaryQuality = qualityIterations.find(
      (iteration) => iteration.projectId === primary.id,
    )
    const localizedCriticIssues = [
      ...(primaryReview?.criticIssues ?? []),
      ...(primaryQuality?.issues ?? []),
    ]
    const localizedCritic = localizedCriticIssues.some(
      (issue) => Boolean(issue.rangeMs || issue.targetId),
    )
    const hardValidationPassed = Boolean(
      primaryReview?.finalAllowed &&
      primaryReview.technicalIssues.every(
        (issue) => issue.severity !== 'hard',
      ) &&
      primaryReview.criticIssues.every(
        (issue) => issue.severity !== 'hard',
      ) &&
      (!primaryQuality || primaryQuality.validation.finalBlocked === false),
    )

    const appliedAnnotation = annotations.find((annotation) =>
      ['region', 'scene'].includes(annotation.scope) &&
      annotation.patchProposals.some(
        (proposal) =>
          proposal.status === 'applied' &&
          proposal.resultVersionId !== null &&
          proposal.resultCommandId !== null,
      ))
    const appliedProposal = appliedAnnotation?.patchProposals.find(
      (proposal) => proposal.status === 'applied',
    )

    const resultCommandIds = new Set(
      commandResultVersions.flatMap((version) =>
        version.commandId ? [version.commandId] : []),
    )
    const manual = commands
      .filter((command) =>
        command.type === 'manual-edit' &&
        command.actorType === 'api-client' &&
        resultCommandIds.has(command.id))
      .map((command) => ({
        command,
        payload: manualPayload(command.payloadJson),
      }))
    const appliedOperation = (kind: string) =>
      manual.find(({ payload }) => {
        const operation = record(payload.operation)
        return payload.action === 'apply' && operation?.kind === kind
      })
    const trim = appliedOperation('trim')
    const replace = appliedOperation('replace')
    const inspector = manual.filter(({ payload }) => {
      const operation = record(payload.operation)
      return payload.action === 'apply' && operation?.kind === 'inspect'
    })
    const inspectorWith = (field: string) =>
      inspector.find(({ payload }) =>
        record(record(payload.operation)?.patch)?.[field] !== undefined)
    const undo = manual.find(({ payload }) => payload.action === 'undo')

    const duplicateValid = Boolean(
      duplicate?.currentVersion &&
      duplicate.duplicatedFromProjectId === primary.id &&
      duplicate.currentVersion.forkedFromProjectId === primary.id &&
      duplicate.currentVersion.forkedFromVersionId &&
      duplicate.currentVersion.briefSnapshotId === primaryVersion.briefSnapshotId &&
      duplicate.currentVersion.treatmentSnapshotId ===
        primaryVersion.treatmentSnapshotId &&
      duplicate.currentVersion.storySnapshotId === primaryVersion.storySnapshotId &&
      duplicate.currentVersion.editPlanSnapshotId ===
        primaryVersion.editPlanSnapshotId &&
      duplicate.currentVersion.policiesSnapshotId ===
        primaryVersion.policiesSnapshotId,
    )
    const sourceArtifactIds = new Set(
      allDuplicateMedia
        .filter((item) => item.projectId === primary.id)
        .map((item) => item.artifactId),
    )
    const duplicateArtifactIds = allDuplicateMedia
      .filter((item) => item.projectId === duplicate?.id)
      .map((item) => item.artifactId)
    const mastersNotCopied =
      duplicateValid &&
      duplicateArtifactIds.length > 0 &&
      duplicateArtifactIds.every((artifactId) =>
        sourceArtifactIds.has(artifactId))

    const exportFor = (projectId: string, aspectRatio: string) =>
      finalExports.find((item) =>
        item.projectId === projectId &&
        item.outputAspectRatio === aspectRatio &&
        item.operation.status === 'succeeded' &&
        item.attempts.some((attempt) => attempt.status === 'promoted'))
    const primaryExport = exportFor(primary.id, '9:16')
    const companionExport = exportFor(companion.id, '16:9')
    const exportValidated = (
      value: typeof primaryExport,
      width: number,
      height: number,
    ) => Boolean(
      value &&
      value.outputWidth === width &&
      value.outputHeight === height &&
      value.operation.completedAt &&
      value.operation.resultJson &&
      outputResultArtifactId(value.operation.resultJson) ===
        value.outputArtifactId &&
      value.attempts.some((attempt) =>
        attempt.status === 'promoted' &&
        attempt.outputArtifactId === value.outputArtifactId &&
        attempt.outputManifestId === value.outputManifestId &&
        attempt.outputSha256 &&
        attempt.outputByteSize &&
        attempt.outputByteSize > 0),
    )
    const primaryExportValidated = exportValidated(
      primaryExport,
      1080,
      1920,
    )
    const companionExportValidated = exportValidated(
      companionExport,
      1920,
      1080,
    )
    const layoutsIndependent = Boolean(
      primaryEditPlan &&
      companionEditPlan &&
      primaryEditPlan.row.id !== companionEditPlan.row.id &&
      primaryEditPlan.row.contentHash !== companionEditPlan.row.contentHash,
    )

    const outputArtifactIds = [primaryExport, companionExport]
      .flatMap((item) => item ? [item.outputArtifactId] : [])
    const outputArtifacts = await this.client.v2MediaArtifact.findMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: outputArtifactIds },
      },
      include: {
        manifests: {
          include: {
            lineageEdges: {
              include: { sourceArtifact: true },
            },
          },
        },
      },
    })
    const outputManifestFor = (value: typeof primaryExport) =>
      value
        ? outputArtifacts
          .find((artifact) => artifact.id === value.outputArtifactId)
          ?.manifests.find((manifest) =>
            manifest.id === value.outputManifestId)
        : undefined
    const primaryFinalManifest = outputManifestFor(primaryExport)
    const companionFinalManifest = outputManifestFor(companionExport)
    const manifestsComplete = Boolean(
      primaryFinalManifest &&
      companionFinalManifest &&
      manifestComplete(primaryFinalManifest) &&
      manifestComplete(companionFinalManifest),
    )
    const reconstructable = Boolean(
      manifestsComplete &&
      [primaryFinalManifest, companionFinalManifest].every((manifest) =>
        manifest &&
        manifest.lineageEdges.length > 0 &&
        manifest.lineageEdges.every(
          (edge) => edge.sourceArtifact.status === 'available',
        )),
    )

    const retryExport = finalExports.find((item) =>
      item.attempts.length >= 2 &&
      item.attempts.some((attempt) => attempt.status === 'failed') &&
      item.attempts.some((attempt) => attempt.status === 'promoted') &&
      item.operation.status === 'succeeded' &&
      item.operation.attempt >= 2)
    const projectNotStuck =
      !['failed', 'ingesting'].includes(primary.status) &&
      !['failed', 'ingesting'].includes(companion.status) &&
      !operations.some((operation) =>
        ['queued', 'running'].includes(operation.status) &&
        operation.leaseExpiresAt &&
        operation.leaseExpiresAt < new Date())

    const progressOperation = operations.find((operation) =>
      operation.progressCompleted !== null &&
      operation.progressTotal !== null &&
      operation.progressTotal > 0 &&
      operation.progressCompleted >= 0 &&
      operation.progressCompleted <= operation.progressTotal)
    const reviewStateTruthful = Boolean(
      primaryReview &&
      (
        (primaryReview.status === 'ready-for-final' &&
          primaryReview.finalAllowed) ||
        (primaryReview.status === 'blocked' &&
          !primaryReview.finalAllowed) ||
        (primaryReview.status === 'warning-ack-required' &&
          !primaryReview.finalAllowed)
      ),
    )
    const completionStateTruthful = Boolean(
      primaryExportValidated &&
      companionExportValidated,
    )
    const failedAttempt = finalExports
      .flatMap((item) => item.attempts)
      .find((attempt) =>
        attempt.status === 'failed' &&
        Boolean(attempt.errorCode) &&
        Boolean(attempt.errorMessage))
    const failureStateTruthful = Boolean(failedAttempt)
    const dashboardState = Object.freeze({
      progress: progressOperation
        ? {
            operationId: progressOperation.id,
            completed: progressOperation.progressCompleted,
            total: progressOperation.progressTotal,
          }
        : null,
      review: primaryReview
        ? {
            id: primaryReview.id,
            status: primaryReview.status,
            finalAllowed: primaryReview.finalAllowed,
          }
        : null,
      completion: {
        primary: primaryExport?.operation.status ?? null,
        companion: companionExport?.operation.status ?? null,
      },
      failure: failedAttempt
        ? {
            operationId: failedAttempt.operationId,
            attempt: failedAttempt.attempt,
            code: failedAttempt.errorCode,
          }
        : null,
    })

    const scopes = actor
      ? array(parseJson(actor.scopeGrantsJson, 'API client scope grants'))
      : []
    const externalActorAuthorized = Boolean(
      actor?.status === 'active' &&
      scopes.includes('projects:read') &&
      scopes.includes('projects:write'),
    )
    const relevantDirectorRuns = [primaryDirector, companionDirector].filter(
      (value): value is NonNullable<typeof value> => Boolean(value),
    )
    const relevantSelections = [
      selectedPrimary,
      selectedCompanion,
      generatedRejection,
    ].filter((value): value is NonNullable<typeof value> => Boolean(value))
    const publicApiOnly = Boolean(
      primary.createdByType === 'api-client' &&
      companion.createdByType === 'api-client' &&
      relevantDirectorRuns.length === 2 &&
      relevantDirectorRuns.every((run) =>
        run.initiatedByType === 'api-client') &&
      commands.every((command) => command.actorType === 'api-client') &&
      relevantSelections.every((selection) =>
        selection.createdBy.type === 'api-client') &&
      finalExports.every((item) => Boolean(item.operation.clientId)),
    )
    const versionPolicyParity = Boolean(
      primaryPolicies &&
      companionPolicies &&
      primaryVersion.id === input.primaryVersionId &&
      companionVersion.id === input.companionVersionId &&
      primaryVersion.policiesSnapshotId === primaryPolicies.row.id &&
      companionVersion.policiesSnapshotId === companionPolicies.row.id,
    )
    const jobArtifactParity = [primaryExport, companionExport].every((item) =>
      item &&
      item.operation.targetId === item.outputArtifactId &&
      outputResultArtifactId(item.operation.resultJson) ===
        item.outputArtifactId &&
      item.attempts.some((attempt) =>
        attempt.status === 'promoted' &&
        attempt.outputArtifactId === item.outputArtifactId &&
        attempt.outputManifestId === item.outputManifestId))

    const workspaceReference = ref('workspace', workspace.id)
    const primaryProjectReference = ref('project', primary.id)
    const companionProjectReference = ref('project', companion.id)
    const primaryVersionReference = ref(
      'version',
      primaryVersion.id,
      primaryVersion.baseHash,
    )
    const companionVersionReference = ref(
      'version',
      companionVersion.id,
      companionVersion.baseHash,
    )
    const fallback = Object.freeze([primaryProjectReference])
    const evidence = Object.freeze([
      criterion('AC-001', [
        check('workspace-active', workspace.status === 'active', [
          workspaceReference,
        ]),
        check('project-created', Boolean(primary && companion), [
          primaryProjectReference,
          companionProjectReference,
        ]),
        check('policy-snapshot-bound', Boolean(primaryPolicies), [
          primaryPolicies
            ? ref(
                'snapshot',
                primaryPolicies.row.id,
                primaryPolicies.row.contentHash,
              )
            : primaryVersionReference,
        ]),
      ]),
      criterion('AC-002', [
        check('objective-bound', Boolean(primary.objective), [
          primaryProjectReference,
          primaryBrief
            ? ref(
                'snapshot',
                primaryBrief.row.id,
                primaryBrief.row.contentHash,
              )
            : primaryVersionReference,
        ]),
        check('briefing-optional-contract', briefingOptional, [
          primaryBrief
            ? ref(
                'snapshot',
                primaryBrief.row.id,
                primaryBrief.row.contentHash,
              )
            : primaryVersionReference,
        ]),
      ]),
      criterion('AC-003', [
        check('immutable-master', Boolean(primaryMaster), [
          primaryMaster
            ? ref(
                'artifact',
                primaryMaster.artifact.id,
                primaryMaster.artifact.sha256,
              )
            : primaryProjectReference,
        ]),
        check('derived-proxy', Boolean(primaryProxy), [
          primaryProxy
            ? ref(
                'artifact',
                primaryProxy.artifact.id,
                primaryProxy.artifact.sha256,
              )
            : primaryProjectReference,
        ]),
        check('source-lineage', sourceLineage, [
          primaryProxyManifest
            ? ref(
                'manifest',
                primaryProxyManifest.id,
                primaryProxyManifest.manifestHash,
              )
            : primaryProjectReference,
        ]),
      ]),
      criterion('AC-004', [
        check('word-timestamps', signals.wordTimestamps, [
          primaryTranscriptRow
            ? ref(
                'transcript',
                primaryTranscriptRow.id,
                primaryTranscriptRow.transcriptHash,
              )
            : primaryProjectReference,
        ]),
        check('silence-detection-recorded', signals.silenceDetectionRecorded, [
          primaryTranscriptRow
            ? ref(
                'transcript',
                primaryTranscriptRow.id,
                primaryTranscriptRow.transcriptHash,
              )
            : primaryProjectReference,
        ]),
        check('retake-detection-recorded', signals.retakeDetectionRecorded, [
          primaryTranscriptRow
            ? ref(
                'transcript',
                primaryTranscriptRow.id,
                primaryTranscriptRow.transcriptHash,
              )
            : primaryProjectReference,
        ]),
      ]),
      criterion('AC-005', [
        check('treatment-plan-persisted', Boolean(primaryTreatment), [
          primaryTreatment
            ? ref(
                'snapshot',
                primaryTreatment.row.id,
                primaryTreatment.row.contentHash,
              )
            : primaryVersionReference,
        ]),
        check('story-plan-persisted', Boolean(primaryStory), [
          primaryStory
            ? ref(
                'snapshot',
                primaryStory.row.id,
                primaryStory.row.contentHash,
              )
            : primaryVersionReference,
        ]),
        check(
          'edit-plan-persisted',
          Boolean(
            primaryEditPlan &&
            primaryDirector &&
            primaryDirector.status === 'succeeded',
          ),
          [
            primaryEditPlan
              ? ref(
                  'snapshot',
                  primaryEditPlan.row.id,
                  primaryEditPlan.row.contentHash,
                )
              : primaryVersionReference,
            primaryDirector
              ? ref('director-run', primaryDirector.id)
              : primaryProjectReference,
          ],
        ),
      ]),
      criterion('AC-006', [
        check('talking-head-broll', primaryTalkingHead, [
          selectedPrimary
            ? ref(
                'asset-selection',
                selectedPrimary.id,
                selectedPrimary.selectionHash,
              )
            : primaryProjectReference,
          primaryEditPlan
            ? ref(
                'snapshot',
                primaryEditPlan.row.id,
                primaryEditPlan.row.contentHash,
              )
            : primaryVersionReference,
        ]),
        check('voiceover-broll-no-person', companionVoiceover, [
          selectedCompanion
            ? ref(
                'asset-selection',
                selectedCompanion.id,
                selectedCompanion.selectionHash,
              )
            : companionProjectReference,
          companionEditPlan
            ? ref(
                'snapshot',
                companionEditPlan.row.id,
                companionEditPlan.row.contentHash,
              )
            : companionVersionReference,
        ]),
      ]),
      criterion('AC-007', [
        check('generated-candidate-evaluated', Boolean(generatedCandidate), [
          generatedRejection
            ? ref(
                'asset-selection',
                generatedRejection.id,
                generatedRejection.selectionHash,
              )
            : primaryProjectReference,
        ]),
        check('rejected-candidate-audited', Boolean(generatedCandidate), [
          generatedRejection
            ? ref(
                'asset-selection',
                generatedRejection.id,
                generatedRejection.selectionHash,
              )
            : primaryProjectReference,
        ]),
        check('replacement-selected', Boolean(generatedReplacement), [
          generatedReplacement
            ? ref(
                'asset-selection',
                generatedReplacement.id,
                generatedReplacement.selectionHash,
              )
            : primaryProjectReference,
        ]),
      ]),
      criterion('AC-008', [
        check('proxy-rendered', Boolean(primaryReview), [
          primaryReview
            ? ref(
                'proxy-review',
                primaryReview.id,
                primaryReview.reviewHash,
              )
            : primaryProjectReference,
        ]),
        check('hard-validation-passed', hardValidationPassed, [
          primaryReview
            ? ref(
                'proxy-review',
                primaryReview.id,
                primaryReview.reviewHash,
              )
            : primaryProjectReference,
          primaryQuality
            ? ref(
                'quality-iteration',
                primaryQuality.id,
                primaryQuality.recordHash,
              )
            : primaryVersionReference,
        ]),
        check('localized-critic-recorded', localizedCritic, [
          primaryQuality
            ? ref(
                'quality-iteration',
                primaryQuality.id,
                primaryQuality.recordHash,
              )
            : primaryReview
              ? ref(
                  'proxy-review',
                  primaryReview.id,
                  primaryReview.reviewHash,
                )
              : primaryProjectReference,
        ]),
      ]),
      criterion('AC-009', [
        check('annotation-bound', Boolean(appliedAnnotation), [
          appliedAnnotation
            ? ref('annotation', appliedAnnotation.id)
            : primaryProjectReference,
        ]),
        check('correction-version-created', Boolean(appliedProposal), [
          appliedProposal
            ? ref('patch-proposal', appliedProposal.id)
            : primaryVersionReference,
        ]),
      ]),
      criterion('AC-010', [
        check('trim-versioned', Boolean(trim), [
          trim ? ref('command', trim.command.id) : primaryProjectReference,
        ]),
        check('broll-replaced', Boolean(replace), [
          replace
            ? ref('command', replace.command.id)
            : primaryProjectReference,
        ]),
        check('text-edited', Boolean(inspectorWith('text')), [
          inspectorWith('text')
            ? ref('command', inspectorWith('text')!.command.id)
            : primaryProjectReference,
        ]),
        check('subtitle-edited', Boolean(inspectorWith('subtitle')), [
          inspectorWith('subtitle')
            ? ref('command', inspectorWith('subtitle')!.command.id)
            : primaryProjectReference,
        ]),
        check('layout-edited', Boolean(inspectorWith('layout')), [
          inspectorWith('layout')
            ? ref('command', inspectorWith('layout')!.command.id)
            : primaryProjectReference,
        ]),
        check('undo-versioned', Boolean(undo), [
          undo ? ref('command', undo.command.id) : primaryProjectReference,
        ]),
      ]),
      criterion('AC-011', [
        check('copy-on-write-duplicate', duplicateValid, [
          duplicate ? ref('project', duplicate.id) : primaryProjectReference,
          duplicate?.currentVersion
            ? ref(
                'version',
                duplicate.currentVersion.id,
                duplicate.currentVersion.baseHash,
              )
            : primaryVersionReference,
        ]),
        check('master-bytes-not-copied', mastersNotCopied, [
          duplicate ? ref('project', duplicate.id) : primaryProjectReference,
          ...(primaryMaster
            ? [ref(
                'artifact',
                primaryMaster.artifact.id,
                primaryMaster.artifact.sha256,
              )]
            : fallback),
        ]),
      ]),
      criterion('AC-012', [
        check('export-9-16-validated', primaryExportValidated, [
          primaryExport
            ? ref('operation', primaryExport.operationId)
            : primaryProjectReference,
        ]),
        check('export-16-9-validated', companionExportValidated, [
          companionExport
            ? ref('operation', companionExport.operationId)
            : companionProjectReference,
        ]),
        check('layout-independent', layoutsIndependent, [
          primaryEditPlan
            ? ref(
                'snapshot',
                primaryEditPlan.row.id,
                primaryEditPlan.row.contentHash,
              )
            : primaryVersionReference,
          companionEditPlan
            ? ref(
                'snapshot',
                companionEditPlan.row.id,
                companionEditPlan.row.contentHash,
              )
            : companionVersionReference,
        ]),
      ]),
      criterion('AC-013', [
        check('final-manifest-complete', manifestsComplete, [
          primaryFinalManifest
            ? ref(
                'manifest',
                primaryFinalManifest.id,
                primaryFinalManifest.manifestHash,
              )
            : primaryProjectReference,
          companionFinalManifest
            ? ref(
                'manifest',
                companionFinalManifest.id,
                companionFinalManifest.manifestHash,
              )
            : companionProjectReference,
        ]),
        check('final-reconstructable', reconstructable, [
          primaryFinalManifest
            ? ref(
                'manifest',
                primaryFinalManifest.id,
                primaryFinalManifest.manifestHash,
              )
            : primaryProjectReference,
          companionFinalManifest
            ? ref(
                'manifest',
                companionFinalManifest.id,
                companionFinalManifest.manifestHash,
              )
            : companionProjectReference,
        ]),
      ]),
      criterion('AC-014', [
        check('restart-recovered', Boolean(retryExport), [
          retryExport
            ? ref('operation', retryExport.operationId)
            : primaryProjectReference,
        ]),
        check('retry-safe', Boolean(retryExport), [
          retryExport
            ? ref('operation', retryExport.operationId)
            : primaryProjectReference,
        ]),
        check('project-not-stuck', projectNotStuck, [
          primaryProjectReference,
          companionProjectReference,
        ]),
      ]),
      criterion('AC-015', [
        check('progress-state-truthful', Boolean(progressOperation), [
          derivedRef(
            'dashboard-state',
            'dashboard-progress',
            dashboardState.progress,
          ),
        ]),
        check('review-state-truthful', reviewStateTruthful, [
          derivedRef(
            'dashboard-state',
            'dashboard-review',
            dashboardState.review,
          ),
        ]),
        check('completion-state-truthful', completionStateTruthful, [
          derivedRef(
            'dashboard-state',
            'dashboard-completion',
            dashboardState.completion,
          ),
        ]),
        check('failure-state-truthful', failureStateTruthful, [
          derivedRef(
            'dashboard-state',
            'dashboard-failure',
            dashboardState.failure,
          ),
        ]),
      ]),
      criterion('AC-016', [
        check('external-actor-authorized', externalActorAuthorized, [
          actor ? ref('api-client', actor.id) : workspaceReference,
        ]),
        check('public-api-only', publicApiOnly, [
          actor ? ref('api-client', actor.id) : workspaceReference,
          primaryProjectReference,
          companionProjectReference,
        ]),
        check('version-policy-parity', versionPolicyParity, [
          primaryVersionReference,
          companionVersionReference,
        ]),
        check('job-artifact-parity', jobArtifactParity, [
          primaryExport
            ? ref('operation', primaryExport.operationId)
            : primaryProjectReference,
          companionExport
            ? ref('operation', companionExport.operationId)
            : companionProjectReference,
        ]),
      ]),
    ])

    return Object.freeze({
      primaryVersionId: primaryVersion.id,
      primaryVersionHash: primaryVersion.baseHash,
      companionVersionId: companionVersion.id,
      companionVersionHash: companionVersion.baseHash,
      evidence,
    })
  }

  async persist(
    gate: Readonly<PersistedMvpCoreGate>,
    authenticationAudit: Parameters<MvpCoreGateRepository['persist']>[1],
    attempt = 1,
  ): ReturnType<MvpCoreGateRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_primaryProjectId_idempotencyKey: {
            workspaceId: gate.workspaceId,
            primaryProjectId: gate.primaryProjectId,
            idempotencyKey: gate.idempotencyKey,
          },
        }
        const existing = await transaction.v2MvpCoreGate.findUnique({
          where: key,
        })
        if (existing) {
          const audit = hydrateExternalActorAudit(existing, existing.createdById)
          if (audit.contextHash !== authenticationAudit.contextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
          if (existing.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different MVP gate request',
            )
          }
          return Object.freeze({
            gate: hydrateGate(existing),
            replayed: true,
          })
        }
        const [primary, companion, actor] = await Promise.all([
          transaction.v2Project.findFirst({
            where: {
              id: gate.primaryProjectId,
              workspaceId: gate.workspaceId,
            },
            include: { currentVersion: true },
          }),
          transaction.v2Project.findFirst({
            where: {
              id: gate.companionProjectId,
              workspaceId: gate.workspaceId,
            },
            include: { currentVersion: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: gate.createdBy.id,
              workspaceId: gate.workspaceId,
              status: 'active',
            },
          }),
        ])
        if (!primary?.currentVersion || !companion?.currentVersion || !actor) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'MVP gate commit context is no longer available',
          )
        }
        if (
          primary.currentVersion.id !== gate.primaryVersionId ||
          primary.currentVersion.baseHash !== gate.primaryVersionHash ||
          companion.currentVersion.id !== gate.companionVersionId ||
          companion.currentVersion.baseHash !== gate.companionVersionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'MVP gate project versions changed before commit',
          )
        }
        const row = await transaction.v2MvpCoreGate.create({
          data: {
            id: gate.id,
            workspaceId: gate.workspaceId,
            primaryProjectId: gate.primaryProjectId,
            companionProjectId: gate.companionProjectId,
            primaryVersionId: gate.primaryVersionId,
            companionVersionId: gate.companionVersionId,
            primaryVersionHash: gate.primaryVersionHash,
            companionVersionHash: gate.companionVersionHash,
            approved: gate.report.approved,
            covered: gate.report.covered,
            passed: gate.report.passed,
            total: gate.report.total,
            reportJson: stableSerialize(gate.report),
            reportFingerprint: gate.reportFingerprint,
            recordHash: gate.recordHash,
            idempotencyKey: gate.idempotencyKey,
            requestFingerprint: gate.requestFingerprint,
            createdByType: gate.createdBy.type,
            createdById: gate.createdBy.id,
            ...externalActorAuditData(authenticationAudit, gate.workspaceId, gate.createdBy.id),
            createdAt: new Date(gate.createdAt),
          },
        })
        return Object.freeze({
          gate: hydrateGate(row),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(gate, authenticationAudit, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'MVP gate conflicted with another transaction',
        )
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: gate.workspaceId,
          primaryProjectId: gate.primaryProjectId,
          idempotencyKey: gate.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different MVP gate request',
            )
          }
          return Object.freeze({ gate: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async list(input: {
    workspaceId: string
    primaryProjectId: string
    limit: number
  }) {
    const rows = await this.client.v2MvpCoreGate.findMany({
      where: {
        workspaceId: input.workspaceId,
        primaryProjectId: input.primaryProjectId,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateGate))
  }
}
