import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('media artifacts persist atomically with workspace-scoped immutable lineage', async () => {
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const {
    createMediaArtifactManifest,
    createReconstructableMediaArtifactManifest,
    createReplayableMediaArtifactManifest,
  } = await import(
    '../../src/v2/domain/media-artifact.ts'
  )
  const { createRenderInputSpec } = await import('../../src/v2/domain/render-input.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaMediaArtifactRepository } = await import(
    '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
  )
  const { PrismaProtectedRenderInputStore } = await import(
    '../../src/v2/infrastructure/prisma/protected-render-input-store.ts'
  )
  const { PrismaRenderInputAssetAvailability } = await import(
    '../../src/v2/infrastructure/prisma/render-input-asset-availability.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { createAesRecipeParameterCipher } = await import(
    '../../src/v2/infrastructure/security/recipe-parameter-cipher.ts'
  )

  const client = new PrismaClient()
  const workspaceA = 'artifact-integration-workspace-a'
  const workspaceB = 'artifact-integration-workspace-b'
  const workspaceIds = [workspaceA, workspaceB]
  const sha = (character) => character.repeat(64)
  const createManifest = ({ artifactKey, artifactSha256, sources = [], parameters = {} }) =>
    createMediaArtifactManifest({
      artifactKey,
      artifactSha256,
      byteSize: 1024,
      mediaType: 'video',
      container: 'mp4',
      recipe: { id: sources.length === 0 ? 'ingest-source' : 'normalize-video', version: 'v1', parameters },
      sources,
      probe: { width: 320, height: 240, duration: 3, fps: 30 },
    })
  const expectDomainCode = async (promise, code) => {
    await assert.rejects(promise, (error) => error instanceof DomainError && error.code === code)
  }
  const cleanup = async () => {
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2RenderInputPayload.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2RecipeParameterPayload.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2Workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  }

  try {
    await cleanup()
    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(
      createWorkspace({
        id: workspaceA,
        slug: 'artifact-integration-a',
        name: 'Artifact Integration A',
        status: 'active',
        createdAt: '2026-07-13T00:40:00.000Z',
      }),
    )
    await workspaces.create(
      createWorkspace({
        id: workspaceB,
        slug: 'artifact-integration-b',
        name: 'Artifact Integration B',
        status: 'active',
        createdAt: '2026-07-13T00:40:00.000Z',
      }),
    )

    const recipeCipher = createAesRecipeParameterCipher({
      keyId: 'artifact-integration-key-v1',
      key: Buffer.alloc(32, 7),
    })
    const repository = new PrismaMediaArtifactRepository(client, recipeCipher)
    const sourceKey = 'workspaces/a/masters/source.mp4'
    const sourceManifest = createManifest({ artifactKey: sourceKey, artifactSha256: sha('a') })
    const source = await repository.persistOrReplay({
      workspaceId: workspaceA,
      artifactId: 'artifact-source-a',
      manifestId: 'manifest-source-a',
      lineageIds: [],
      manifest: sourceManifest,
      createdAt: '2026-07-13T00:41:00.000Z',
    })
    assert.equal(source.replayed, false)

    const derivedRenderInput = createRenderInputSpec({
      schemaVersion: 'render-input/v1',
      renderer: { id: 'remotion', version: '4.0.489', digest: sha('7') },
      composition: {
        id: 'apollo-video',
        version: 'v1',
        propsSchemaRef: 'apollo://render-props/apollo-video/v1',
      },
      plan: {
        id: 'artifact-integration-plan',
        versionId: 'artifact-integration-plan-version',
        hash: sha('5'),
      },
      output: {
        id: 'preset-4x5',
        locale: 'pt-BR',
        aspectRatio: '4:5',
        width: 1080,
        height: 1350,
        fps: 30,
        safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
        durationInFrames: 90,
      },
      assets: [
        {
          id: 'asset-source-a',
          artifactId: 'artifact-source-a',
          artifactKey: sourceKey,
          kind: 'video',
          role: 'primary',
          ordinal: 0,
          sha256: sha('a'),
          byteSize: 1024,
        },
      ],
      props: {
        primaryAssetId: 'asset-source-a',
        title: 'protected-render-input-title',
      },
    })
    const derivedReplayable = createReconstructableMediaArtifactManifest({
      artifactKey: 'workspaces/a/artifacts/normalized.mp4',
      artifactSha256: sha('b'),
      byteSize: 1024,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'normalize-video',
        version: 'v3',
        parameters: { crf: 23, instruction: 'protected-recipe-instruction' },
      },
      sources: [
        {
          artifactKey: sourceKey,
          sha256: sha('a'),
          role: 'primary',
          execution: {
            tool: { id: 'ffmpeg', version: '7.1.1', digest: sha('7') },
            model: {
              provider: 'openai',
              id: 'gpt-5',
              version: '2026.07',
              config: { privatePrompt: 'must-not-persist', temperature: 0 },
            },
          },
        },
      ],
      probe: { width: 320, height: 240, duration: 3, fps: 30 },
      renderInput: derivedRenderInput,
    })
    const derivedBundle = {
      workspaceId: workspaceA,
      artifactId: 'artifact-derived-a',
      manifestId: 'manifest-derived-a',
      lineageIds: ['lineage-derived-a-0'],
      manifest: derivedReplayable.manifest,
      recipeParameters: derivedReplayable.recipeParameters,
      renderInput: derivedReplayable.renderInput,
      createdAt: '2026-07-13T00:42:00.000Z',
    }
    const first = await repository.persistOrReplay(derivedBundle)
    const replay = await repository.persistOrReplay({
      ...derivedBundle,
      artifactId: 'ignored-artifact-id',
      manifestId: 'ignored-manifest-id',
      lineageIds: ['ignored-lineage-id'],
    })
    assert.deepEqual(first, {
      artifactId: 'artifact-derived-a',
      manifestId: 'manifest-derived-a',
      replayed: false,
    })
    assert.deepEqual(replay, { ...first, replayed: true })
    const storedProvenance = await client.v2MediaArtifactLineage.findUnique({
      where: { id: 'lineage-derived-a-0' },
    })
    assert.equal(storedProvenance.toolId, 'ffmpeg')
    assert.equal(storedProvenance.toolVersion, '7.1.1')
    assert.equal(storedProvenance.toolDigest, sha('7'))
    assert.equal(storedProvenance.modelProvider, 'openai')
    assert.equal(storedProvenance.modelId, 'gpt-5')
    assert.equal(storedProvenance.modelVersion, '2026.07')
    assert.equal(storedProvenance.modelConfigHash.length, 64)
    const storedDerivedManifest = await client.v2MediaArtifactManifest.findUnique({
      where: { id: 'manifest-derived-a' },
    })
    assert.equal(storedDerivedManifest.manifestJson.includes('must-not-persist'), false)
    assert.equal(
      storedDerivedManifest.manifestJson.includes('protected-recipe-instruction'),
      false,
    )
    assert.equal(
      storedDerivedManifest.recipeParametersRef,
      derivedReplayable.recipeParameters.ref,
    )
    assert.equal(storedDerivedManifest.schemaVersion, 'media-artifact-manifest/v4')
    assert.equal(storedDerivedManifest.renderInputRef, derivedReplayable.renderInput.ref)
    assert.equal(storedDerivedManifest.renderInputHash, derivedRenderInput.inputHash)
    assert.equal(
      storedDerivedManifest.manifestJson.includes('protected-render-input-title'),
      false,
    )
    const storedRecipeParameters = await client.v2RecipeParameterPayload.findUnique({
      where: {
        workspaceId_ref: {
          workspaceId: workspaceA,
          ref: derivedReplayable.recipeParameters.ref,
        },
      },
    })
    assert.ok(storedRecipeParameters)
    assert.equal(
      JSON.stringify(storedRecipeParameters).includes('protected-recipe-instruction'),
      false,
    )
    assert.equal(
      await recipeCipher.open(
        {
          algorithm: storedRecipeParameters.algorithm,
          keyId: storedRecipeParameters.keyId,
          nonce: storedRecipeParameters.nonce,
          ciphertext: storedRecipeParameters.ciphertext,
          authTag: storedRecipeParameters.authTag,
        },
        `apollo-recipe-parameters/v1:${workspaceA}:${storedRecipeParameters.ref}`,
      ),
      derivedReplayable.recipeParameters.canonicalJson,
    )
    const storedRenderInput = await client.v2RenderInputPayload.findUnique({
      where: {
        workspaceId_ref: {
          workspaceId: workspaceA,
          ref: derivedReplayable.renderInput.ref,
        },
      },
    })
    assert.ok(storedRenderInput)
    assert.equal(
      JSON.stringify(storedRenderInput).includes('protected-render-input-title'),
      false,
    )
    assert.equal(
      await recipeCipher.open(
        {
          algorithm: storedRenderInput.algorithm,
          keyId: storedRenderInput.keyId,
          nonce: storedRenderInput.nonce,
          ciphertext: storedRenderInput.ciphertext,
          authTag: storedRenderInput.authTag,
        },
        `apollo-render-input/v1:${workspaceA}:${storedRenderInput.ref}`,
      ),
      derivedReplayable.renderInput.canonicalJson,
    )
    const protectedRenderInputs = new PrismaProtectedRenderInputStore(client, recipeCipher)
    assert.deepEqual(
      await protectedRenderInputs.read(
        workspaceA,
        derivedReplayable.renderInput.ref,
        derivedReplayable.renderInput.inputHash,
      ),
      derivedRenderInput,
    )
    assert.equal(
      await protectedRenderInputs.read(
        workspaceB,
        derivedReplayable.renderInput.ref,
        derivedReplayable.renderInput.inputHash,
      ),
      null,
    )
    const originalCiphertext = storedRenderInput.ciphertext
    await client.v2RenderInputPayload.update({
      where: {
        workspaceId_ref: {
          workspaceId: workspaceA,
          ref: derivedReplayable.renderInput.ref,
        },
      },
      data: {
        ciphertext: `${originalCiphertext[0] === 'A' ? 'B' : 'A'}${originalCiphertext.slice(1)}`,
      },
    })
    await expectDomainCode(
      protectedRenderInputs.read(
        workspaceA,
        derivedReplayable.renderInput.ref,
        derivedReplayable.renderInput.inputHash,
      ),
      'PERSISTENCE_CONFLICT',
    )
    await client.v2RenderInputPayload.update({
      where: {
        workspaceId_ref: {
          workspaceId: workspaceA,
          ref: derivedReplayable.renderInput.ref,
        },
      },
      data: { ciphertext: originalCiphertext },
    })
    const assetAvailability = new PrismaRenderInputAssetAvailability(client)
    assert.deepEqual(
      await assetAvailability.inspect(workspaceA, derivedRenderInput.assets[0]),
      { available: true },
    )
    assert.deepEqual(
      await assetAvailability.inspect(workspaceA, {
        ...derivedRenderInput.assets[0],
        sha256: sha('f'),
      }),
      { available: false, code: 'ASSET_IDENTITY_MISMATCH' },
    )
    assert.equal(
      await client.v2RenderInputPayload.count({ where: { workspaceId: workspaceA } }),
      1,
    )
    const queriedDerived = await repository.findById(workspaceA, 'artifact-derived-a')
    assert.deepEqual(queriedDerived.manifests[0].renderInput, {
      ref: derivedReplayable.renderInput.ref,
      inputHash: derivedReplayable.renderInput.inputHash,
      canonicalByteSize: derivedReplayable.renderInput.canonicalByteSize,
      algorithm: 'aes-256-gcm',
    })

    const copiedReconstructable = createReconstructableMediaArtifactManifest({
      artifactKey: 'workspaces/a/artifacts/normalized-copy.mp4',
      artifactSha256: sha('b'),
      byteSize: 1024,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'normalize-video',
        version: 'v3',
        parameters: { instruction: 'protected-recipe-instruction', crf: 23 },
      },
      sources: [
        {
          artifactKey: sourceKey,
          sha256: sha('a'),
          role: 'primary',
          execution: {
            tool: { id: 'ffmpeg', version: '7.1.1', digest: sha('7') },
            model: {
              provider: 'openai',
              id: 'gpt-5',
              version: '2026.07',
              config: { temperature: 0, privatePrompt: 'must-not-persist' },
            },
          },
        },
      ],
      probe: { width: 320, height: 240, duration: 3, fps: 30 },
      renderInput: derivedRenderInput,
    })
    await repository.persistOrReplay({
      workspaceId: workspaceA,
      artifactId: 'artifact-derived-copy-a',
      manifestId: 'manifest-derived-copy-a',
      lineageIds: ['lineage-derived-copy-a-0'],
      manifest: copiedReconstructable.manifest,
      recipeParameters: copiedReconstructable.recipeParameters,
      renderInput: copiedReconstructable.renderInput,
      createdAt: '2026-07-13T00:42:15.000Z',
    })
    assert.equal(
      await client.v2RenderInputPayload.count({ where: { workspaceId: workspaceA } }),
      1,
    )

    const reusedReplayable = createReplayableMediaArtifactManifest({
      artifactKey: 'workspaces/a/artifacts/reused-recipe.mp4',
      artifactSha256: sha('6'),
      byteSize: 2048,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'normalize-video',
        version: 'v3',
        parameters: { instruction: 'protected-recipe-instruction', crf: 23 },
      },
      sources: [],
    })
    assert.equal(
      reusedReplayable.recipeParameters.ref,
      derivedReplayable.recipeParameters.ref,
    )
    await repository.persistOrReplay({
      workspaceId: workspaceA,
      artifactId: 'artifact-reused-recipe-a',
      manifestId: 'manifest-reused-recipe-a',
      lineageIds: [],
      manifest: reusedReplayable.manifest,
      recipeParameters: reusedReplayable.recipeParameters,
      createdAt: '2026-07-13T00:42:30.000Z',
    })
    assert.equal(
      await client.v2RecipeParameterPayload.count({ where: { workspaceId: workspaceA } }),
      1,
    )
    const otherWorkspaceReplayable = createReplayableMediaArtifactManifest({
      artifactKey: 'workspaces/b/artifacts/same-recipe.mp4',
      artifactSha256: sha('8'),
      byteSize: 2048,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'normalize-video',
        version: 'v3',
        parameters: { crf: 23, instruction: 'protected-recipe-instruction' },
      },
      sources: [],
    })
    await repository.persistOrReplay({
      workspaceId: workspaceB,
      artifactId: 'artifact-same-recipe-b',
      manifestId: 'manifest-same-recipe-b',
      lineageIds: [],
      manifest: otherWorkspaceReplayable.manifest,
      recipeParameters: otherWorkspaceReplayable.recipeParameters,
      createdAt: '2026-07-13T00:42:45.000Z',
    })
    assert.equal(
      otherWorkspaceReplayable.recipeParameters.ref,
      derivedReplayable.recipeParameters.ref,
    )
    assert.equal(
      await client.v2RecipeParameterPayload.count({
        where: { ref: derivedReplayable.recipeParameters.ref },
      }),
      2,
    )

    await expectDomainCode(
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'conflicting-source',
        manifestId: 'conflicting-source-manifest',
        lineageIds: [],
        manifest: createManifest({ artifactKey: sourceKey, artifactSha256: sha('c') }),
        createdAt: '2026-07-13T00:43:00.000Z',
      }),
      'PERSISTENCE_CONFLICT',
    )

    const missingSourceOutputKey = 'workspaces/b/artifacts/should-rollback.mp4'
    await expectDomainCode(
      repository.persistOrReplay({
        workspaceId: workspaceB,
        artifactId: 'artifact-rollback-b',
        manifestId: 'manifest-rollback-b',
        lineageIds: ['lineage-rollback-b-0'],
        manifest: createManifest({
          artifactKey: missingSourceOutputKey,
          artifactSha256: sha('d'),
          sources: [{ artifactKey: sourceKey, sha256: sha('a'), role: 'primary' }],
        }),
        createdAt: '2026-07-13T00:44:00.000Z',
      }),
      'MEDIA_ARTIFACT_SOURCE_NOT_FOUND',
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId: workspaceB, artifactKey: missingSourceOutputKey },
      }),
      0,
    )

    const checksumMismatchKey = 'workspaces/a/artifacts/checksum-rollback.mp4'
    await expectDomainCode(
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-checksum-rollback',
        manifestId: 'manifest-checksum-rollback',
        lineageIds: ['lineage-checksum-rollback-0'],
        manifest: createManifest({
          artifactKey: checksumMismatchKey,
          artifactSha256: sha('f'),
          sources: [{ artifactKey: sourceKey, sha256: sha('9'), role: 'primary' }],
        }),
        createdAt: '2026-07-13T00:44:30.000Z',
      }),
      'PERSISTENCE_CONFLICT',
    )
    assert.equal(
      await client.v2MediaArtifact.count({
        where: { workspaceId: workspaceA, artifactKey: checksumMismatchKey },
      }),
      0,
    )

    {
      await assert.rejects(
        client.v2MediaArtifact.create({
          data: {
            id: 'artifact-invalid-key',
            workspaceId: workspaceA,
            artifactKey: '/absolute/path.mp4',
            sha256: sha('1'),
            byteSize: 1n,
            mediaType: 'video',
            container: 'mp4',
            status: 'available',
          },
        }),
      )
    }

    const concurrentManifest = createManifest({
      artifactKey: 'workspaces/a/artifacts/concurrent.mp4',
      artifactSha256: sha('e'),
      sources: [{ artifactKey: sourceKey, sha256: sha('a'), role: 'primary' }],
    })
    const concurrent = await Promise.all([
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-concurrent-1',
        manifestId: 'manifest-concurrent-1',
        lineageIds: ['lineage-concurrent-1'],
        manifest: concurrentManifest,
        createdAt: '2026-07-13T00:45:00.000Z',
      }),
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-concurrent-2',
        manifestId: 'manifest-concurrent-2',
        lineageIds: ['lineage-concurrent-2'],
        manifest: concurrentManifest,
        createdAt: '2026-07-13T00:45:00.000Z',
      }),
    ])
    assert.deepEqual(concurrent.map((result) => result.replayed).sort(), [false, true])

    const concurrentRecipeA = createReplayableMediaArtifactManifest({
      artifactKey: 'workspaces/a/artifacts/concurrent-recipe-a.mp4',
      artifactSha256: sha('2'),
      byteSize: 2048,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'render-video',
        version: 'v3',
        parameters: { quality: 'high', instruction: 'concurrent-protected-value' },
      },
      sources: [],
    })
    const concurrentRecipeB = createReplayableMediaArtifactManifest({
      artifactKey: 'workspaces/a/artifacts/concurrent-recipe-b.mp4',
      artifactSha256: sha('3'),
      byteSize: 2048,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'render-video',
        version: 'v3',
        parameters: { instruction: 'concurrent-protected-value', quality: 'high' },
      },
      sources: [],
    })
    const concurrentRecipes = await Promise.all([
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-concurrent-recipe-a',
        manifestId: 'manifest-concurrent-recipe-a',
        lineageIds: [],
        manifest: concurrentRecipeA.manifest,
        recipeParameters: concurrentRecipeA.recipeParameters,
        createdAt: '2026-07-13T00:46:00.000Z',
      }),
      repository.persistOrReplay({
        workspaceId: workspaceA,
        artifactId: 'artifact-concurrent-recipe-b',
        manifestId: 'manifest-concurrent-recipe-b',
        lineageIds: [],
        manifest: concurrentRecipeB.manifest,
        recipeParameters: concurrentRecipeB.recipeParameters,
        createdAt: '2026-07-13T00:46:00.000Z',
      }),
    ])
    assert.deepEqual(concurrentRecipes.map((result) => result.replayed), [false, false])
    assert.equal(
      await client.v2RecipeParameterPayload.count({
        where: {
          workspaceId: workspaceA,
          parametersHash: concurrentRecipeA.recipeParameters.parametersHash,
        },
      }),
      1,
    )

    assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId: workspaceA } }), 7)
    assert.equal(await client.v2MediaArtifactManifest.count({ where: { workspaceId: workspaceA } }), 7)
    assert.equal(await client.v2MediaArtifactLineage.count({ where: { workspaceId: workspaceA } }), 3)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
