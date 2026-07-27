import { randomUUID } from 'node:crypto'

import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  AssetSelectionRepository,
  PersistedAssetSelection,
} from '../../application/ports/asset-selection-repository.ts'
import {
  calculateAssetSelectionRecordHash,
  createAssetBrief,
  createAssetCandidate,
  selectAsset,
  type AssetCandidateRightsEvidence,
} from '../../domain/asset-selection.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type StoredSelection = Prisma.V2AssetSelectionGetPayload<Record<string, never>>

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid JSON`)
  }
}

function parseRightsEvidence(
  value: string,
  candidateIds: readonly string[],
): readonly Readonly<AssetCandidateRightsEvidence>[] {
  const parsed = parseJson(value, 'asset selection rights evidence')
  if (!Array.isArray(parsed) || parsed.length !== candidateIds.length) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset selection rights evidence is invalid')
  }
  const evidence = parsed.map((candidate, index) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      candidate.artifactId !== candidateIds[index] ||
      typeof candidate.artifactSha256 !== 'string' ||
      !SHA_256_PATTERN.test(candidate.artifactSha256) ||
      !['allow', 'deny'].includes(String(candidate.outcome)) ||
      !Array.isArray(candidate.reasonCodes) ||
      !candidate.reasonCodes.every((reason: unknown) => typeof reason === 'string') ||
      (candidate.rightsSnapshotId !== undefined &&
        (typeof candidate.rightsSnapshotId !== 'string' ||
          !ID_PATTERN.test(candidate.rightsSnapshotId))) ||
      (candidate.rightsSnapshotHash !== undefined &&
        (typeof candidate.rightsSnapshotHash !== 'string' ||
          !SHA_256_PATTERN.test(candidate.rightsSnapshotHash))) ||
      ((candidate.rightsSnapshotId === undefined) !==
        (candidate.rightsSnapshotHash === undefined)) ||
      (candidate.validUntil !== undefined &&
        (typeof candidate.validUntil !== 'string' ||
          Number.isNaN(new Date(candidate.validUntil).getTime()))) ||
      (candidate.outcome === 'allow' &&
        (!candidate.rightsSnapshotId ||
          !candidate.rightsSnapshotHash ||
          !candidate.validUntil ||
          candidate.reasonCodes.length !== 0))
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset selection rights evidence is invalid')
    }
    return Object.freeze({
      artifactId: candidate.artifactId as string,
      artifactSha256: candidate.artifactSha256,
      outcome: candidate.outcome as 'allow' | 'deny',
      reasonCodes: Object.freeze([...candidate.reasonCodes] as string[]),
      ...(candidate.rightsSnapshotId
        ? { rightsSnapshotId: candidate.rightsSnapshotId as string }
        : {}),
      ...(candidate.rightsSnapshotHash
        ? { rightsSnapshotHash: candidate.rightsSnapshotHash as string }
        : {}),
      ...(candidate.validUntil ? { validUntil: candidate.validUntil as string } : {}),
    })
  })
  return Object.freeze(evidence)
}

export function hydrateAssetSelection(row: StoredSelection): Readonly<PersistedAssetSelection> {
  const briefValue = parseJson(row.briefJson, 'asset brief')
  if (typeof briefValue !== 'object' || briefValue === null || Array.isArray(briefValue)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset brief is invalid')
  }
  const brief = createAssetBrief(briefValue as never)
  const candidateValue = parseJson(row.candidatesJson, 'asset candidates')
  if (!Array.isArray(candidateValue)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset candidates are invalid')
  }
  const candidates = Object.freeze(candidateValue.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset candidate is invalid')
    }
    return createAssetCandidate(candidate as never)
  }))
  const rightsEvidence = parseRightsEvidence(
    row.rightsEvidenceJson,
    candidates.map((candidate) => candidate.id),
  )
  const recomputed = selectAsset(brief, candidates)
  const storedEvaluations = parseJson(row.evaluationsJson, 'asset evaluations')
  const storedStopped = parseJson(row.searchStoppedBeforeJson, 'asset search boundary')
  if (
    stableSerialize(brief) !== row.briefJson ||
    stableSerialize(candidates) !== row.candidatesJson ||
    stableSerialize(rightsEvidence) !== row.rightsEvidenceJson ||
    stableSerialize(recomputed.evaluations) !== stableSerialize(storedEvaluations) ||
    stableSerialize(recomputed.searchStoppedBefore) !== stableSerialize(storedStopped) ||
    calculateCanonicalHash(brief) !== row.briefHash ||
    calculateCanonicalHash(candidates) !== row.candidatesHash ||
    recomputed.decision !== row.decision ||
    recomputed.selectedId !== row.selectedArtifactId ||
    recomputed.source !== row.selectedSource ||
    recomputed.auditId !== row.auditId
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset selection failed integrity validation')
  }
  const createdAt = row.createdAt.toISOString()
  const content = Object.freeze({
    schemaVersion: 'asset-selection/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    brief,
    briefHash: row.briefHash,
    candidates,
    candidatesHash: row.candidatesHash,
    rightsEvidence,
    result: recomputed,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdBy: Object.freeze({
      type: row.createdByType as 'api-client',
      id: row.createdById,
    }),
    createdAt,
  })
  if (
    row.createdByType !== 'api-client' ||
    calculateAssetSelectionRecordHash(content) !== row.selectionHash
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset selection hash is inconsistent')
  }
  return Object.freeze({ ...content, selectionHash: row.selectionHash })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaAssetSelectionRepository implements AssetSelectionRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async readProjectContext(input: {
    workspaceId: string
    projectId: string
  }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: true },
    })
    if (!project) return null
    if (!project.currentVersion || !project.locale) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Asset selection requires a current project version and locale',
      )
    }
    return Object.freeze({
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectVersionId: project.currentVersion.id,
      projectVersionHash: project.currentVersion.baseHash,
      locale: project.locale,
    })
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2AssetSelection.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    return row ? hydrateAssetSelection(row) : null
  }

  async persist(
    selection: Readonly<PersistedAssetSelection>,
    serializationAttempt = 1,
  ): ReturnType<AssetSelectionRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_projectId_idempotencyKey: {
            workspaceId: selection.workspaceId,
            projectId: selection.projectId,
            idempotencyKey: selection.idempotencyKey,
          },
        }
        const existing = await transaction.v2AssetSelection.findUnique({ where: key })
        if (existing) {
          if (existing.requestFingerprint !== selection.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different asset selection request',
            )
          }
          return Object.freeze({ selection: hydrateAssetSelection(existing), replayed: true })
        }
        const [project, artifacts] = await Promise.all([
          transaction.v2Project.findFirst({
            where: {
              id: selection.projectId,
              workspaceId: selection.workspaceId,
            },
            include: { currentVersion: true },
          }),
          transaction.v2MediaArtifact.findMany({
            where: {
              workspaceId: selection.workspaceId,
              id: { in: selection.candidates.map((candidate) => candidate.id) },
            },
            include: { currentRightsSnapshot: true },
          }),
        ])
        if (
          !project?.currentVersion ||
          project.currentVersion.id !== selection.projectVersionId ||
          project.currentVersion.baseHash !== selection.projectVersionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project version changed before asset selection commit',
          )
        }
        const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
        for (const evidence of selection.rightsEvidence) {
          const artifact = artifactsById.get(evidence.artifactId)
          if (
            !artifact ||
            artifact.status !== 'available' ||
            artifact.sha256 !== evidence.artifactSha256 ||
            (artifact.currentRightsSnapshotId ?? undefined) !== evidence.rightsSnapshotId ||
            (artifact.currentRightsSnapshot?.snapshotHash ?? undefined) !==
              evidence.rightsSnapshotHash
          ) {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              'Asset or rights changed before selection commit',
              { artifactId: evidence.artifactId },
            )
          }
        }
        if (selection.result.selectedId) {
          const selectedEvidence = selection.rightsEvidence.find(
            (evidence) => evidence.artifactId === selection.result.selectedId,
          )
          if (!selectedEvidence || selectedEvidence.outcome !== 'allow') {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              'Selected asset does not have approved rights evidence',
            )
          }
        }
        const row = await transaction.v2AssetSelection.create({
          data: {
            id: selection.id,
            workspaceId: selection.workspaceId,
            projectId: selection.projectId,
            projectVersionId: selection.projectVersionId,
            projectVersionHash: selection.projectVersionHash,
            briefJson: stableSerialize(selection.brief),
            briefHash: selection.briefHash,
            candidatesJson: stableSerialize(selection.candidates),
            candidatesHash: selection.candidatesHash,
            rightsEvidenceJson: stableSerialize(selection.rightsEvidence),
            evaluationsJson: stableSerialize(selection.result.evaluations),
            decision: selection.result.decision,
            selectedArtifactId: selection.result.selectedId,
            selectedSource: selection.result.source,
            searchStoppedBeforeJson: stableSerialize(selection.result.searchStoppedBefore),
            auditId: selection.result.auditId,
            selectionHash: selection.selectionHash,
            idempotencyKey: selection.idempotencyKey,
            requestFingerprint: selection.requestFingerprint,
            createdByType: selection.createdBy.type,
            createdById: selection.createdBy.id,
            createdAt: new Date(selection.createdAt),
          },
        })
        if (selection.result.selectedId) {
          const selectedArtifact = artifactsById.get(selection.result.selectedId)!
          await transaction.v2ProjectMediaAsset.upsert({
            where: {
              projectId_artifactId_role: {
                projectId: selection.projectId,
                artifactId: selectedArtifact.id,
                role: 'selected-insert',
              },
            },
            create: {
              id: randomUUID(),
              workspaceId: selection.workspaceId,
              projectId: selection.projectId,
              artifactId: selectedArtifact.id,
              role: 'selected-insert',
              originalFileName: `${selectedArtifact.id}.${selectedArtifact.container}`,
              createdAt: new Date(selection.createdAt),
            },
            update: {},
          })
        }
        return Object.freeze({ selection: hydrateAssetSelection(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.persist(selection, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: selection.workspaceId,
          projectId: selection.projectId,
          idempotencyKey: selection.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== selection.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different asset selection request',
            )
          }
          return Object.freeze({ selection: replay, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Asset selection collided with persisted state',
        )
      }
      throw error
    }
  }

  async list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit: number
  }) {
    const rows = await this.client.v2AssetSelection.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateAssetSelection))
  }
}
