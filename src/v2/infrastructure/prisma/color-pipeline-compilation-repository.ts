import {
  Prisma,
  type PrismaClient,
  type V2ColorPipelineCompilation,
  type V2MediaColorProbe,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ColorPipelineCompilationRepository,
  PersistedColorPipelineCompilation,
} from '../../application/ports/color-pipeline-compilation-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import {
  createColorPipelineCompilation,
} from '../../domain/color-pipeline-compilation.ts'
import {
  createMediaColorProbe,
  type ColorMetadata,
  type ColorTransform,
} from '../../domain/color-and-export.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'

type CompilationRow = V2ColorPipelineCompilation & {
  colorProbe: V2MediaColorProbe
}

function canonical<T>(value: string, field: string): Readonly<T> {
  try {
    const parsed = JSON.parse(value) as T
    if (stableSerialize(parsed) !== value) throw new Error('non-canonical')
    return Object.freeze(parsed)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateProbe(row: V2MediaColorProbe) {
  const detection = row.state === 'ready'
    ? {
        state: 'ready' as const,
        metadata: canonical<ColorMetadata>(row.metadataJson, 'color metadata'),
        pixelFormat: row.pixelFormat ?? '',
        hdrMode: row.hdrMode as 'sdr' | 'hlg' | 'pq',
      }
    : {
        state: 'unavailable' as const,
        ...(row.pixelFormat ? { pixelFormat: row.pixelFormat } : {}),
        reasons: canonical<readonly string[]>(row.reasonsJson, 'color probe reasons'),
      }
  const probe = createMediaColorProbe({
    id: row.id,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    manifestId: row.manifestId,
    detection,
    producer: {
      provider: 'ffprobe',
      version: row.producerVersion,
      binaryDigest: row.producerBinaryDigest,
    },
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.schemaVersion !== probe.schemaVersion ||
    row.producerProvider !== probe.producer.provider ||
    row.probeHash !== probe.probeHash
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored color probe failed integrity validation')
  }
  return probe
}

function hydrate(row: CompilationRow): Readonly<PersistedColorPipelineCompilation> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const stored = canonical<{
    pipeline: {
      outputMetadata: ColorMetadata
      stages: ColorTransform[]
    }
  }>(row.compilationJson, 'color pipeline compilation')
  const compilation = createColorPipelineCompilation({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceArtifactId: row.sourceArtifactId,
    sourceManifestId: row.sourceManifestId,
    probe: hydrateProbe(row.colorProbe),
    outputMetadata: stored.pipeline.outputMetadata,
    stages: stored.pipeline.stages,
    createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(),
  })
  const versions = compilation.pipeline.stages.map((stage) => ({
    kind: stage.kind,
    transformId: stage.id,
    transformVersion: stage.version,
    provider: stage.implementation.provider,
    providerVersion: stage.implementation.version,
    parametersHash: stage.implementation.parametersHash,
  }))
  if (
    row.schemaVersion !== compilation.schemaVersion ||
    row.pipelineHash !== compilation.pipeline.pipelineHash ||
    row.compilationHash !== compilation.compilationHash ||
    stableSerialize(compilation) !== row.compilationJson ||
    stableSerialize(versions) !== row.transformVersionsJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored color pipeline compilation failed integrity validation',
    )
  }
  return Object.freeze({
    compilation,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

function includeProbe() {
  return { colorProbe: true } as const
}

export class PrismaColorPipelineCompilationRepository
implements ColorPipelineCompilationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async loadTrustedProbe(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
  }) {
    const [project, asset, probe] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        select: { id: true },
      }),
      this.client.v2ProjectMediaAsset.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          artifactId: input.sourceArtifactId,
        },
        select: { id: true },
      }),
      this.client.v2MediaColorProbe.findUnique({
        where: {
          workspaceId_artifactId_manifestId: {
            workspaceId: input.workspaceId,
            artifactId: input.sourceArtifactId,
            manifestId: input.sourceManifestId,
          },
        },
      }),
    ])
    return project && asset && probe ? hydrateProbe(probe) : null
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2ColorPipelineCompilation.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.createdByClientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: includeProbe(),
    })
    if (!row) return null
    const audit = hydrateExternalActorAudit(row, row.createdByClientId)
    if (audit.contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
    }
    return hydrate(row)
  }

  async persist(value: Readonly<PersistedColorPipelineCompilation>, authenticationAudit: Parameters<ColorPipelineCompilationRepository['persist']>[1]) {
    const item = value.compilation
    const versions = item.pipeline.stages.map((stage) => ({
      kind: stage.kind,
      transformId: stage.id,
      transformVersion: stage.version,
      provider: stage.implementation.provider,
      providerVersion: stage.implementation.version,
      parametersHash: stage.implementation.parametersHash,
    }))
    try {
      const row = await this.client.v2ColorPipelineCompilation.create({
        data: {
          id: item.id,
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          sourceArtifactId: item.sourceArtifactId,
          sourceManifestId: item.sourceManifestId,
          colorProbeId: item.colorProbeId,
          schemaVersion: item.schemaVersion,
          pipelineHash: item.pipeline.pipelineHash,
          transformVersionsJson: stableSerialize(versions),
          compilationJson: stableSerialize(item),
          compilationHash: item.compilationHash,
          requestFingerprint: value.requestFingerprint,
          idempotencyKey: value.idempotencyKey,
          createdByClientId: item.createdBy.id,
          ...externalActorAuditData(authenticationAudit, item.workspaceId, item.createdBy.id),
          createdAt: new Date(item.createdAt),
        },
        include: includeProbe(),
      })
      return Object.freeze({ value: hydrate(row), replayed: false })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          createdByClientId: item.createdBy.id,
          idempotencyKey: value.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (replay && replay.requestFingerprint === value.requestFingerprint) {
          return Object.freeze({ value: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    compilationId: string
  }) {
    const row = await this.client.v2ColorPipelineCompilation.findFirst({
      where: {
        id: input.compilationId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: includeProbe(),
    })
    return row ? hydrate(row) : null
  }

  async listForSource(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
  }) {
    const rows = await this.client.v2ColorPipelineCompilation.findMany({
      where: input,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: includeProbe(),
      take: 2,
    })
    return Object.freeze(rows.map(hydrate))
  }
}
