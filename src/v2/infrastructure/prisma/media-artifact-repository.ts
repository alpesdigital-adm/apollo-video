import type { Prisma, PrismaClient, V2MediaArtifact } from '@prisma/client'

import type {
  MediaArtifactPersistenceBundle,
  MediaArtifactPersistenceRepository,
  MediaArtifactPersistenceResult,
} from '../../application/ports/media-artifact-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifestV1,
} from '../../domain/media-artifact.ts'

type PersistenceClient = Pick<
  PrismaClient,
  'v2MediaArtifact' | 'v2MediaArtifactManifest' | 'v2MediaArtifactLineage'
>

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  )
}

function assertArtifactIdentity(
  artifact: V2MediaArtifact,
  manifest: MediaArtifactManifestV1,
): void {
  const expected = manifest.artifact
  if (
    artifact.sha256 !== expected.sha256 ||
    artifact.byteSize !== BigInt(expected.byteSize) ||
    artifact.mediaType !== expected.mediaType ||
    artifact.container !== expected.container
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Artifact key already points to different immutable content',
      { artifactId: artifact.id },
    )
  }
}

async function findReplay(
  client: PersistenceClient,
  bundle: MediaArtifactPersistenceBundle,
  manifestJson: string,
): Promise<MediaArtifactPersistenceResult | null> {
  const artifact = await client.v2MediaArtifact.findUnique({
    where: {
      workspaceId_artifactKey: {
        workspaceId: bundle.workspaceId,
        artifactKey: bundle.manifest.artifact.artifactKey,
      },
    },
  })
  if (!artifact) return null
  assertArtifactIdentity(artifact, bundle.manifest)

  const storedManifest = await client.v2MediaArtifactManifest.findUnique({
    where: {
      artifactId_manifestHash: {
        artifactId: artifact.id,
        manifestHash: bundle.manifest.manifestHash,
      },
    },
  })
  if (!storedManifest) return null
  if (storedManifest.manifestJson !== manifestJson) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored manifest does not match its immutable hash',
      { manifestId: storedManifest.id },
    )
  }

  const lineage = await client.v2MediaArtifactLineage.findMany({
    where: { workspaceId: bundle.workspaceId, manifestId: storedManifest.id },
    orderBy: { ordinal: 'asc' },
    include: { sourceArtifact: { select: { artifactKey: true, sha256: true } } },
  })
  const lineageMatches =
    lineage.length === bundle.manifest.sources.length &&
    lineage.every((edge, index) => {
      const expected = bundle.manifest.sources[index]
      return (
        edge.ordinal === index &&
        edge.role === expected.role &&
        edge.sourceArtifact.artifactKey === expected.artifactKey &&
        edge.sourceArtifact.sha256 === expected.sha256
      )
    })
  if (!lineageMatches) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored artifact lineage does not match the manifest',
      { manifestId: storedManifest.id },
    )
  }

  return { artifactId: artifact.id, manifestId: storedManifest.id, replayed: true }
}

export class PrismaMediaArtifactRepository implements MediaArtifactPersistenceRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async persistOrReplay(
    bundle: MediaArtifactPersistenceBundle,
  ): Promise<MediaArtifactPersistenceResult> {
    assertMediaArtifactManifest(bundle.manifest)
    if (
      bundle.lineageIds.length !== bundle.manifest.sources.length ||
      new Set(bundle.lineageIds).size !== bundle.lineageIds.length
    ) {
      throw new DomainError(
        'INVALID_MEDIA_ARTIFACT',
        'One unique lineage id is required for each manifest source',
      )
    }
    const createdAt = new Date(bundle.createdAt)
    if (Number.isNaN(createdAt.getTime())) {
      throw new DomainError('INVALID_MEDIA_ARTIFACT', 'Artifact createdAt is invalid')
    }
    const manifestJson = stableSerialize(bundle.manifest)

    try {
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
        const workspace = await transaction.v2Workspace.findUnique({
          where: { id: bundle.workspaceId },
          select: { id: true, status: true },
        })
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found', {
            workspaceId: bundle.workspaceId,
          })
        }

        const artifactWhere = {
          workspaceId_artifactKey: {
            workspaceId: bundle.workspaceId,
            artifactKey: bundle.manifest.artifact.artifactKey,
          },
        }
        let artifact = await transaction.v2MediaArtifact.findUnique({ where: artifactWhere })
        if (artifact) {
          assertArtifactIdentity(artifact, bundle.manifest)
          const replay = await findReplay(transaction, bundle, manifestJson)
          if (replay) return replay
        } else {
          artifact = await transaction.v2MediaArtifact.create({
            data: {
              id: bundle.artifactId,
              workspaceId: bundle.workspaceId,
              artifactKey: bundle.manifest.artifact.artifactKey,
              sha256: bundle.manifest.artifact.sha256,
              byteSize: BigInt(bundle.manifest.artifact.byteSize),
              mediaType: bundle.manifest.artifact.mediaType,
              container: bundle.manifest.artifact.container,
              status: 'available',
              createdAt,
            },
          })
        }

        const sources = await Promise.all(
          bundle.manifest.sources.map(async (source) => {
            const row = await transaction.v2MediaArtifact.findUnique({
              where: {
                workspaceId_artifactKey: {
                  workspaceId: bundle.workspaceId,
                  artifactKey: source.artifactKey,
                },
              },
            })
            if (!row) {
              throw new DomainError(
                'MEDIA_ARTIFACT_SOURCE_NOT_FOUND',
                'Manifest source artifact was not found in the workspace',
              )
            }
            if (row.sha256 !== source.sha256) {
              throw new DomainError(
                'PERSISTENCE_CONFLICT',
                'Manifest source checksum does not match stored content',
                { sourceArtifactId: row.id },
              )
            }
            return row
          }),
        )

        const storedManifest = await transaction.v2MediaArtifactManifest.create({
          data: {
            id: bundle.manifestId,
            workspaceId: bundle.workspaceId,
            artifactId: artifact.id,
            schemaVersion: bundle.manifest.schemaVersion,
            manifestHash: bundle.manifest.manifestHash,
            recipeId: bundle.manifest.recipe.id,
            recipeVersion: bundle.manifest.recipe.version,
            parametersHash: bundle.manifest.recipe.parametersHash,
            manifestJson,
            createdAt,
          },
        })

        if (sources.length > 0) {
          await transaction.v2MediaArtifactLineage.createMany({
            data: sources.map((source, index) => ({
              id: bundle.lineageIds[index],
              workspaceId: bundle.workspaceId,
              manifestId: storedManifest.id,
              sourceArtifactId: source.id,
              role: bundle.manifest.sources[index].role,
              ordinal: index,
              createdAt,
            })),
          })
        }

        return { artifactId: artifact.id, manifestId: storedManifest.id, replayed: false }
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const replay = await findReplay(this.client, bundle, manifestJson)
        if (replay) return replay
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Artifact persistence collided with a different immutable record',
        )
      }
      throw error
    }
  }
}
