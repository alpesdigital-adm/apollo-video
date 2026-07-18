import type { Prisma, PrismaClient, V2MediaArtifact } from '../../../../generated/prisma-v2/index.js'

import type {
  MediaArtifactPersistenceBundle,
  MediaArtifactPersistenceRepository,
  MediaArtifactPersistenceResult,
} from '../../application/ports/media-artifact-repository.ts'
import type {
  MediaArtifactQueryRepository,
  MediaArtifactRecord,
} from '../../application/ports/media-artifact-query-repository.ts'
import type { RecipeParameterCipher } from '../../application/ports/recipe-parameter-cipher.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifest,
} from '../../domain/media-artifact.ts'
import {
  assertRecipeParameterPayload,
  type RecipeParameterPayload,
} from '../../domain/recipe-parameters.ts'
import {
  assertRenderInputPayload,
  type RenderInputPayload,
} from '../../domain/render-input-payload.ts'
import {
  recipeParameterCipherContext,
  renderInputCipherContext,
} from '../security/recipe-parameter-cipher.ts'

type PersistenceClient = Pick<
  PrismaClient,
  | 'v2MediaArtifact'
  | 'v2MediaArtifactManifest'
  | 'v2MediaArtifactLineage'
  | 'v2RecipeParameterPayload'
  | 'v2RenderInputPayload'
>

function sourceExecution(manifest: MediaArtifactManifest, index: number) {
  return manifest.schemaVersion === 'media-artifact-manifest/v2' ||
    manifest.schemaVersion === 'media-artifact-manifest/v3' ||
    manifest.schemaVersion === 'media-artifact-manifest/v4'
    ? manifest.sources[index].execution
    : undefined
}

function executionMatches(
  edge: {
    toolId: string | null
    toolVersion: string | null
    toolDigest: string | null
    modelProvider: string | null
    modelId: string | null
    modelVersion: string | null
    modelConfigHash: string | null
  },
  expected: ReturnType<typeof sourceExecution>,
): boolean {
  return (
    edge.toolId === (expected?.tool.id ?? null) &&
    edge.toolVersion === (expected?.tool.version ?? null) &&
    edge.toolDigest === (expected?.tool.digest ?? null) &&
    edge.modelProvider === (expected?.model?.provider ?? null) &&
    edge.modelId === (expected?.model?.id ?? null) &&
    edge.modelVersion === (expected?.model?.version ?? null) &&
    edge.modelConfigHash === (expected?.model?.configHash ?? null)
  )
}

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
  manifest: MediaArtifactManifest,
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
  cipher?: RecipeParameterCipher,
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

  await assertStoredRecipeParameters(
    client,
    bundle.workspaceId,
    storedManifest.recipeParametersRef,
    bundle.recipeParameters,
    cipher,
  )
  await assertStoredRenderInput(
    client,
    bundle.workspaceId,
    storedManifest.renderInputRef,
    storedManifest.renderInputHash,
    bundle.renderInput,
    cipher,
  )

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
        edge.sourceArtifact.sha256 === expected.sha256 &&
        executionMatches(edge, sourceExecution(bundle.manifest, index))
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

function storedRecipeParametersMatch(stored: {
  ref: string
  parametersHash: string
  canonicalByteSize: number
  algorithm: string
  keyId: string
  nonce: string
  ciphertext: string
  authTag: string
}): boolean {
  return (
    stored.ref === `recipe-parameters/sha256/${stored.parametersHash}` &&
    stored.canonicalByteSize > 0 &&
    stored.canonicalByteSize <= 1024 * 1024 &&
    stored.algorithm === 'aes-256-gcm' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(stored.keyId) &&
    /^[A-Za-z0-9_-]{16}$/.test(stored.nonce) &&
    stored.ciphertext.length > 0 &&
    /^[A-Za-z0-9_-]{22}$/.test(stored.authTag)
  )
}

async function assertStoredRecipeParameters(
  client: PersistenceClient,
  workspaceId: string,
  storedId: string | null,
  expected: RecipeParameterPayload | undefined,
  cipher?: RecipeParameterCipher,
): Promise<void> {
  if (!expected) {
    if (storedId !== null) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Unexpected recipe parameter payload link')
    }
    return
  }
  if (storedId !== expected.ref) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Recipe parameter payload link is invalid')
  }
  const stored = await client.v2RecipeParameterPayload.findUnique({
    where: { workspaceId_ref: { workspaceId, ref: storedId } },
  })
  if (
    !stored ||
    stored.workspaceId !== workspaceId ||
    stored.parametersHash !== expected.parametersHash ||
    stored.canonicalByteSize !== expected.canonicalByteSize ||
    !storedRecipeParametersMatch(stored)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Recipe parameter payload metadata is invalid')
  }
  if (cipher) {
    const plaintext = await cipher.open(
      {
        algorithm: stored.algorithm as 'aes-256-gcm',
        keyId: stored.keyId,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
        authTag: stored.authTag,
      },
      recipeParameterCipherContext(workspaceId, expected.ref),
    )
    if (plaintext !== expected.canonicalJson) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Recipe parameter plaintext is invalid')
    }
  }
}

function storedRenderInputMatches(stored: {
  ref: string
  inputHash: string
  canonicalByteSize: number
  algorithm: string
  keyId: string
  nonce: string
  ciphertext: string
  authTag: string
}): boolean {
  return (
    stored.ref === `render-input/sha256/${stored.inputHash}` &&
    stored.canonicalByteSize > 0 &&
    stored.canonicalByteSize <= 4 * 1024 * 1024 &&
    stored.algorithm === 'aes-256-gcm' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(stored.keyId) &&
    /^[A-Za-z0-9_-]{16}$/.test(stored.nonce) &&
    stored.ciphertext.length > 0 &&
    /^[A-Za-z0-9_-]{22}$/.test(stored.authTag)
  )
}

async function assertStoredRenderInput(
  client: PersistenceClient,
  workspaceId: string,
  storedRef: string | null,
  storedHash: string | null,
  expected: RenderInputPayload | undefined,
  cipher?: RecipeParameterCipher,
): Promise<void> {
  if (!expected) {
    if (storedRef !== null || storedHash !== null) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Unexpected RenderInput payload link')
    }
    return
  }
  if (storedRef !== expected.ref || storedHash !== expected.inputHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'RenderInput payload link is invalid')
  }
  const stored = await client.v2RenderInputPayload.findUnique({
    where: { workspaceId_ref: { workspaceId, ref: storedRef } },
  })
  if (
    !stored ||
    stored.workspaceId !== workspaceId ||
    stored.inputHash !== expected.inputHash ||
    stored.canonicalByteSize !== expected.canonicalByteSize ||
    !storedRenderInputMatches(stored)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'RenderInput payload metadata is invalid')
  }
  if (cipher) {
    const plaintext = await cipher.open(
      {
        algorithm: stored.algorithm as 'aes-256-gcm',
        keyId: stored.keyId,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
        authTag: stored.authTag,
      },
      renderInputCipherContext(workspaceId, expected.ref),
    )
    if (plaintext !== expected.canonicalJson) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'RenderInput plaintext is invalid')
    }
  }
}

export class PrismaMediaArtifactRepository
  implements MediaArtifactPersistenceRepository, MediaArtifactQueryRepository
{
  private readonly client: PrismaClient
  private readonly recipeParameterCipher?: RecipeParameterCipher

  constructor(client: PrismaClient, recipeParameterCipher?: RecipeParameterCipher) {
    this.client = client
    this.recipeParameterCipher = recipeParameterCipher
  }

  async findById(workspaceId: string, artifactId: string): Promise<MediaArtifactRecord | null> {
    const row = await this.client.v2MediaArtifact.findFirst({
      where: { id: artifactId, workspaceId },
      include: {
        manifests: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            recipeParameters: true,
            renderInput: true,
            lineageEdges: {
              orderBy: { ordinal: 'asc' },
              include: {
                sourceArtifact: {
                  select: { id: true, artifactKey: true, sha256: true },
                },
              },
            },
          },
        },
      },
    })
    if (!row) return null
    if (!['available', 'quarantined', 'deleted'].includes(row.status)) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored media artifact status is invalid',
        { artifactId: row.id },
      )
    }

    const manifests = row.manifests.map((stored) => {
      let manifest: MediaArtifactManifest
      try {
        manifest = JSON.parse(stored.manifestJson) as MediaArtifactManifest
        assertMediaArtifactManifest(manifest)
      } catch {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Stored media artifact manifest failed integrity validation',
          { manifestId: stored.id },
        )
      }

      const artifactMatches =
        manifest.artifact.artifactKey === row.artifactKey &&
        manifest.artifact.sha256 === row.sha256 &&
        BigInt(manifest.artifact.byteSize) === row.byteSize &&
        manifest.artifact.mediaType === row.mediaType &&
        manifest.artifact.container === row.container
      const protectedParametersMatch =
        manifest.schemaVersion === 'media-artifact-manifest/v3' ||
        manifest.schemaVersion === 'media-artifact-manifest/v4'
          ? manifest.recipe.parametersRef === stored.recipeParametersRef &&
            stored.recipeParameters?.parametersHash === manifest.recipe.parametersHash &&
            storedRecipeParametersMatch(stored.recipeParameters)
          : stored.recipeParametersRef === null && stored.recipeParameters === null
      const renderInputMatches =
        manifest.schemaVersion === 'media-artifact-manifest/v4'
          ? manifest.renderInput.ref === stored.renderInputRef &&
            manifest.renderInput.inputHash === stored.renderInputHash &&
            stored.renderInput?.inputHash === manifest.renderInput.inputHash &&
            storedRenderInputMatches(stored.renderInput)
          : stored.renderInputRef === null &&
            stored.renderInputHash === null &&
            stored.renderInput === null
      const manifestMatches =
        manifest.schemaVersion === stored.schemaVersion &&
        manifest.manifestHash === stored.manifestHash &&
        manifest.recipe.id === stored.recipeId &&
        manifest.recipe.version === stored.recipeVersion &&
        manifest.recipe.parametersHash === stored.parametersHash &&
        protectedParametersMatch &&
        renderInputMatches
      const lineageMatches =
        manifest.sources.length === stored.lineageEdges.length &&
        stored.lineageEdges.every((edge, index) => {
          const expected = manifest.sources[index]
          return (
            edge.ordinal === index &&
            edge.role === expected.role &&
            edge.sourceArtifact.artifactKey === expected.artifactKey &&
            edge.sourceArtifact.sha256 === expected.sha256 &&
            executionMatches(edge, sourceExecution(manifest, index))
          )
        })
      if (!artifactMatches || !manifestMatches || !lineageMatches) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Stored media artifact metadata does not match its immutable manifest',
          { manifestId: stored.id },
        )
      }

      return {
        id: stored.id,
        schemaVersion: stored.schemaVersion,
        manifestHash: stored.manifestHash,
        recipe: {
          id: stored.recipeId,
          version: stored.recipeVersion,
          parametersHash: stored.parametersHash,
          ...(stored.recipeParametersRef
            ? { parametersRef: stored.recipeParametersRef }
            : {}),
        },
        ...(stored.recipeParameters
          ? {
              recipeParameters: {
                ref: stored.recipeParameters.ref,
                parametersHash: stored.recipeParameters.parametersHash,
                canonicalByteSize: stored.recipeParameters.canonicalByteSize,
                algorithm: 'aes-256-gcm' as const,
              },
            }
          : {}),
        ...(stored.renderInput
          ? {
              renderInput: {
                ref: stored.renderInput.ref,
                inputHash: stored.renderInput.inputHash,
                canonicalByteSize: stored.renderInput.canonicalByteSize,
                algorithm: 'aes-256-gcm' as const,
              },
            }
          : {}),
        ...(manifest.probe ? { probe: { ...manifest.probe } } : {}),
        sources: stored.lineageEdges.map((edge) => ({
          artifactId: edge.sourceArtifact.id,
          artifactKey: edge.sourceArtifact.artifactKey,
          sha256: edge.sourceArtifact.sha256,
          role: edge.role,
          ordinal: edge.ordinal,
          ...(edge.toolId && edge.toolVersion && edge.toolDigest
            ? {
                execution: {
                  tool: {
                    id: edge.toolId,
                    version: edge.toolVersion,
                    digest: edge.toolDigest,
                  },
                  ...(edge.modelProvider &&
                  edge.modelId &&
                  edge.modelVersion &&
                  edge.modelConfigHash
                    ? {
                        model: {
                          provider: edge.modelProvider,
                          id: edge.modelId,
                          version: edge.modelVersion,
                          configHash: edge.modelConfigHash,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        })),
        createdAt: stored.createdAt.toISOString(),
      }
    })

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      artifactKey: row.artifactKey,
      sha256: row.sha256,
      byteSize: row.byteSize,
      mediaType: row.mediaType as MediaArtifactRecord['mediaType'],
      container: row.container,
      status: row.status as MediaArtifactRecord['status'],
      manifests,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async persistOrReplay(
    bundle: MediaArtifactPersistenceBundle,
  ): Promise<MediaArtifactPersistenceResult> {
    assertMediaArtifactManifest(bundle.manifest)
    if (
      bundle.manifest.schemaVersion === 'media-artifact-manifest/v3' ||
      bundle.manifest.schemaVersion === 'media-artifact-manifest/v4'
    ) {
      if (!bundle.recipeParameters) {
        throw new DomainError(
          'INVALID_MEDIA_ARTIFACT',
          'Manifest v3 or v4 requires protected recipe parameters',
        )
      }
      if (!this.recipeParameterCipher) {
        throw new DomainError(
          'PERSISTENCE_NOT_CONFIGURED',
          'Protected payload cipher is not configured',
        )
      }
      assertRecipeParameterPayload(bundle.recipeParameters)
      if (
        bundle.recipeParameters.ref !== bundle.manifest.recipe.parametersRef ||
        bundle.recipeParameters.parametersHash !== bundle.manifest.recipe.parametersHash
      ) {
        throw new DomainError(
          'INVALID_MEDIA_ARTIFACT',
          'Protected recipe parameters do not match manifest',
        )
      }
      if (bundle.manifest.schemaVersion === 'media-artifact-manifest/v4') {
        if (!bundle.renderInput) {
          throw new DomainError(
            'INVALID_MEDIA_ARTIFACT',
            'Manifest v4 requires a protected RenderInput',
          )
        }
        assertRenderInputPayload(bundle.renderInput)
        if (
          bundle.renderInput.ref !== bundle.manifest.renderInput.ref ||
          bundle.renderInput.inputHash !== bundle.manifest.renderInput.inputHash
        ) {
          throw new DomainError(
            'INVALID_MEDIA_ARTIFACT',
            'Protected RenderInput does not match manifest v4',
          )
        }
      } else if (bundle.renderInput) {
        throw new DomainError(
          'INVALID_MEDIA_ARTIFACT',
          'Manifest v3 cannot link a protected RenderInput',
        )
      }
    } else if (bundle.recipeParameters || bundle.renderInput) {
      throw new DomainError(
        'INVALID_MEDIA_ARTIFACT',
        'Legacy manifests cannot link protected payloads',
      )
    }
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

    for (let attempt = 0; attempt < 2; attempt += 1) {
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
          const replay = await findReplay(
            transaction,
            bundle,
            manifestJson,
            this.recipeParameterCipher,
          )
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

        let recipeParametersRef: string | undefined
        if (bundle.recipeParameters) {
          const recipeParameterCipher = this.recipeParameterCipher
          if (!recipeParameterCipher) {
            throw new DomainError(
              'PERSISTENCE_NOT_CONFIGURED',
              'Recipe parameter cipher is not configured',
            )
          }
          const existing = await transaction.v2RecipeParameterPayload.findUnique({
            where: {
              workspaceId_parametersHash: {
                workspaceId: bundle.workspaceId,
                parametersHash: bundle.recipeParameters.parametersHash,
              },
            },
          })
          if (existing) {
            await assertStoredRecipeParameters(
              transaction,
              bundle.workspaceId,
              existing.ref,
              bundle.recipeParameters,
              recipeParameterCipher,
            )
            recipeParametersRef = existing.ref
          } else {
            const sealed = await recipeParameterCipher.seal(
              bundle.recipeParameters.canonicalJson,
              recipeParameterCipherContext(bundle.workspaceId, bundle.recipeParameters.ref),
            )
            const created = await transaction.v2RecipeParameterPayload.upsert({
              where: {
                workspaceId_parametersHash: {
                  workspaceId: bundle.workspaceId,
                  parametersHash: bundle.recipeParameters.parametersHash,
                },
              },
              update: {},
              create: {
                ref: bundle.recipeParameters.ref,
                workspaceId: bundle.workspaceId,
                parametersHash: bundle.recipeParameters.parametersHash,
                canonicalByteSize: bundle.recipeParameters.canonicalByteSize,
                algorithm: sealed.algorithm,
                keyId: sealed.keyId,
                nonce: sealed.nonce,
                ciphertext: sealed.ciphertext,
                authTag: sealed.authTag,
                createdAt,
              },
            })
            await assertStoredRecipeParameters(
              transaction,
              bundle.workspaceId,
              created.ref,
              bundle.recipeParameters,
              recipeParameterCipher,
            )
            recipeParametersRef = created.ref
          }
        }

        let renderInputRef: string | undefined
        let renderInputHash: string | undefined
        if (bundle.renderInput) {
          const protectedPayloadCipher = this.recipeParameterCipher
          if (!protectedPayloadCipher) {
            throw new DomainError(
              'PERSISTENCE_NOT_CONFIGURED',
              'Protected payload cipher is not configured',
            )
          }
          const existing = await transaction.v2RenderInputPayload.findUnique({
            where: {
              workspaceId_inputHash: {
                workspaceId: bundle.workspaceId,
                inputHash: bundle.renderInput.inputHash,
              },
            },
          })
          if (existing) {
            await assertStoredRenderInput(
              transaction,
              bundle.workspaceId,
              existing.ref,
              existing.inputHash,
              bundle.renderInput,
              protectedPayloadCipher,
            )
            renderInputRef = existing.ref
            renderInputHash = existing.inputHash
          } else {
            const sealed = await protectedPayloadCipher.seal(
              bundle.renderInput.canonicalJson,
              renderInputCipherContext(bundle.workspaceId, bundle.renderInput.ref),
            )
            const created = await transaction.v2RenderInputPayload.upsert({
              where: {
                workspaceId_inputHash: {
                  workspaceId: bundle.workspaceId,
                  inputHash: bundle.renderInput.inputHash,
                },
              },
              update: {},
              create: {
                ref: bundle.renderInput.ref,
                workspaceId: bundle.workspaceId,
                inputHash: bundle.renderInput.inputHash,
                canonicalByteSize: bundle.renderInput.canonicalByteSize,
                algorithm: sealed.algorithm,
                keyId: sealed.keyId,
                nonce: sealed.nonce,
                ciphertext: sealed.ciphertext,
                authTag: sealed.authTag,
                createdAt,
              },
            })
            await assertStoredRenderInput(
              transaction,
              bundle.workspaceId,
              created.ref,
              created.inputHash,
              bundle.renderInput,
              protectedPayloadCipher,
            )
            renderInputRef = created.ref
            renderInputHash = created.inputHash
          }
        }

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
            recipeParametersRef,
            renderInputRef,
            renderInputHash,
            manifestJson,
            createdAt,
          },
        })

        if (sources.length > 0) {
          await transaction.v2MediaArtifactLineage.createMany({
            data: sources.map((source, index) => {
              const execution = sourceExecution(bundle.manifest, index)
              return {
                id: bundle.lineageIds[index],
                workspaceId: bundle.workspaceId,
                manifestId: storedManifest.id,
                sourceArtifactId: source.id,
                role: bundle.manifest.sources[index].role,
                ordinal: index,
                toolId: execution?.tool.id,
                toolVersion: execution?.tool.version,
                toolDigest: execution?.tool.digest,
                modelProvider: execution?.model?.provider,
                modelId: execution?.model?.id,
                modelVersion: execution?.model?.version,
                modelConfigHash: execution?.model?.configHash,
                createdAt,
              }
            }),
          })
        }

        return { artifactId: artifact.id, manifestId: storedManifest.id, replayed: false }
        })
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const replay = await findReplay(
            this.client,
            bundle,
            manifestJson,
            this.recipeParameterCipher,
          )
          if (replay) return replay
          if (attempt === 0) continue
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Artifact persistence collided with a different immutable record',
          )
        }
        throw error
      }
    }

    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Artifact persistence could not resolve a concurrent collision',
    )
  }
}
