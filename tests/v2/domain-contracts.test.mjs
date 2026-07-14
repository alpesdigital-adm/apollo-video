import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  OUTPUT_ASPECT_RATIOS,
  OUTPUT_PRESETS,
  createOutputSpec,
} from '../../src/v2/domain/output-spec.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import {
  assertMediaArtifactManifest,
  createMediaArtifactManifest,
  createMediaArtifactManifestV2,
  createReplayableMediaArtifactManifest,
} from '../../src/v2/domain/media-artifact.ts'
import {
  assertRecipeParameterPayload,
  createRecipeParameterPayload,
} from '../../src/v2/domain/recipe-parameters.ts'
import { createAesRecipeParameterCipher } from '../../src/v2/infrastructure/security/recipe-parameter-cipher.ts'
import {
  assertCommandMatchesVersion,
  createEditCommand,
  validateEditScope,
} from '../../src/v2/domain/edit-command.ts'
import {
  calculateVersionHash,
  stableSerialize,
} from '../../src/v2/application/version-hash.ts'
import { readMediaArtifactService } from '../../src/v2/application/read-media-artifact.ts'
import { diagnoseMediaArtifactLineageService } from '../../src/v2/application/diagnose-media-artifact-lineage.ts'
import { readMediaArtifactProvenanceService } from '../../src/v2/application/read-media-artifact-provenance.ts'
import { readMediaArtifactReplaySpecService } from '../../src/v2/application/read-media-artifact-replay-spec.ts'
import { materializeRenderInputService } from '../../src/v2/application/materialize-render-input.ts'
import { preflightRenderInputService } from '../../src/v2/application/preflight-render-input.ts'
import {
  assertRenderInputSpec,
  createRenderInputSpec,
} from '../../src/v2/domain/render-input.ts'

function expectDomainError(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code)
}

test('all required output presets satisfy the v2 contract', () => {
  for (const ratio of OUTPUT_ASPECT_RATIOS) {
    const spec = createOutputSpec({
      ...OUTPUT_PRESETS[ratio],
      safeArea: { ...OUTPUT_PRESETS[ratio].safeArea },
    })

    assert.equal(spec.aspectRatio, ratio)
    assert.equal(spec.schemaVersion, 1)
    assert.ok(Object.isFrozen(spec))
    assert.ok(Object.isFrozen(spec.safeArea))
  }
})

test('portable RenderInput hashes exact renderer, plan, output, assets and canonical props', async () => {
  const createInput = (props) => ({
    schemaVersion: 'render-input/v1',
    renderer: {
      id: 'remotion',
      version: '4.0.489',
      digest: '1'.repeat(64),
    },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: {
      id: 'plan-1',
      versionId: 'plan-version-1',
      hash: '2'.repeat(64),
    },
    output: {
      id: 'preset-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      durationInFrames: 900,
    },
    assets: [
      {
        id: 'asset-primary',
        artifactId: 'artifact-primary',
        artifactKey: 'workspaces/1/masters/source.mp4',
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: '3'.repeat(64),
        byteSize: 4096,
      },
    ],
    props,
  })
  const first = createRenderInputSpec(
    createInput({ title: 'Hook', primaryAssetId: 'asset-primary' }),
  )
  const reordered = createRenderInputSpec(
    createInput({ primaryAssetId: 'asset-primary', title: 'Hook' }),
  )

  assert.equal(first.inputHash, reordered.inputHash)
  assert.equal(first.composition.propsHash, reordered.composition.propsHash)
  assert.equal(JSON.stringify(first).includes('file://'), false)
  assert.doesNotThrow(() => assertRenderInputSpec(first))
  expectDomainError(
    () => assertRenderInputSpec({ ...first, inputHash: '4'.repeat(64) }),
    'INVALID_RENDER_INPUT',
  )
  expectDomainError(
    () => createRenderInputSpec({ ...createInput({}), implicitDatabaseId: 'unsafe' }),
    'INVALID_RENDER_INPUT',
  )

  const preflight = await preflightRenderInputService()(createInput({ title: 'Hook' }))
  assert.equal(preflight.schemaVersion, 'render-input/v1')
  assert.equal(preflight.validationScope, 'portable-envelope')
  assert.equal(preflight.materializationRequired, true)
  assert.equal(preflight.assetCount, 1)
  assert.equal(preflight.totalAssetBytes, '4096')
  assert.equal('props' in preflight, false)
  assert.equal('assets' in preflight, false)
})

test('RenderInput materialization resolves locations without changing portable identity', async () => {
  const spec = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: '5'.repeat(64) },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: { id: 'plan-2', versionId: 'plan-version-2', hash: '6'.repeat(64) },
    output: {
      id: 'preset-16x9',
      locale: 'pt-BR',
      aspectRatio: '16:9',
      width: 1920,
      height: 1080,
      fps: 30,
      safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      durationInFrames: 1800,
    },
    assets: [
      {
        id: 'font-primary',
        artifactId: 'artifact-font-primary',
        artifactKey: 'workspaces/1/fonts/inter.woff2',
        kind: 'font',
        role: 'subtitle-font',
        ordinal: 0,
        sha256: '7'.repeat(64),
        byteSize: 2048,
      },
    ],
    props: { fontAssetId: 'font-primary' },
  })
  const materialize = materializeRenderInputService({
    resolver: {
      async resolve(asset) {
        return {
          uri: 'file:///worker/materialized/inter.woff2',
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        }
      },
    },
  })
  const materialized = await materialize(spec)
  assert.equal(materialized.inputHash, spec.inputHash)
  assert.equal(materialized.assets[0].uri, 'file:///worker/materialized/inter.woff2')
  assert.equal('uri' in spec.assets[0], false)

  await assert.rejects(
    materializeRenderInputService({
      resolver: {
        async resolve(asset) {
          return { uri: 'https://cdn.example/input', sha256: '8'.repeat(64), byteSize: asset.byteSize }
        },
      },
    })(spec),
    (error) => error instanceof DomainError && error.code === 'INVALID_RENDER_INPUT',
  )
})
test('output dimensions must match the declared ratio', () => {
  expectDomainError(
    () =>
      createOutputSpec({
        ...OUTPUT_PRESETS['9:16'],
        width: 1920,
        height: 1080,
      }),
    'INVALID_OUTPUT_SPEC',
  )
})

test('safe areas are normalized and cannot overlap the canvas', () => {
  expectDomainError(
    () =>
      createOutputSpec({
        ...OUTPUT_PRESETS['1:1'],
        safeArea: { top: 0.5, right: 0.05, bottom: 0.05, left: 0.05 },
      }),
    'INVALID_OUTPUT_SPEC',
  )
})

test('project versions are immutable and require a parent after sequence one', () => {
  const first = createProjectVersion({
    id: 'version-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sequence: 1,
    snapshotRefs: { editPlan: 'edit-plan-1', policies: 'policy-1' },
    baseHash: 'hash-1',
    createdBy: 'user-1',
    createdAt: '2026-07-12T12:00:00.000Z',
  })

  assert.equal(first.schemaVersion, 1)
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.snapshotRefs))

  expectDomainError(
    () =>
      createProjectVersion({
        ...first,
        id: 'version-2',
        sequence: 2,
        baseHash: 'hash-2',
      }),
    'INVALID_PROJECT_VERSION',
  )
})

test('command scopes reject empty and contradictory targets', () => {
  expectDomainError(() => validateEditScope({}), 'INVALID_SCOPE')
  expectDomainError(
    () => validateEditScope({ applyToAllFormats: true, outputSpecIds: ['output-1'] }),
    'INVALID_SCOPE',
  )
  expectDomainError(
    () => validateEditScope({ project: true, clipIds: ['clip-1'] }),
    'INVALID_SCOPE',
  )
})

test('commands accept the exact base and reject stale versions', () => {
  const current = createProjectVersion({
    id: 'version-2',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sequence: 2,
    parentVersionId: 'version-1',
    snapshotRefs: { editPlan: 'edit-plan-2', policies: 'policy-1' },
    baseHash: 'hash-current',
    createdBy: 'user-1',
    createdAt: '2026-07-12T12:01:00.000Z',
  })
  const command = createEditCommand({
    id: 'command-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    baseVersionId: current.id,
    baseHash: current.baseHash,
    author: { type: 'api-client', id: 'client-1' },
    type: 'SetOutputSpec',
    scope: { outputSpecIds: ['output-1'] },
    payload: { fps: 30 },
    idempotencyKey: 'request-1',
    createdAt: '2026-07-12T12:02:00.000Z',
  })

  assert.doesNotThrow(() => assertCommandMatchesVersion(command, current))
  expectDomainError(
    () =>
      assertCommandMatchesVersion(
        { ...command, baseVersionId: 'version-1', baseHash: 'hash-old' },
        current,
      ),
    'VERSION_CONFLICT',
  )
})

test('version hashing is deterministic for object key order', () => {
  const left = { z: 1, nested: { b: true, a: 'value' }, list: [2, 1] }
  const right = { list: [2, 1], nested: { a: 'value', b: true }, z: 1 }

  assert.equal(stableSerialize(left), stableSerialize(right))
  assert.equal(calculateVersionHash(left), calculateVersionHash(right))
  assert.notEqual(calculateVersionHash(left), calculateVersionHash({ ...right, z: 2 }))
})

test('media artifact manifest is deterministic and excludes raw recipe parameters', () => {
  const base = {
    artifactKey: 'workspaces/ws-1/artifacts/normalized.mp4',
    artifactSha256: 'a'.repeat(64),
    byteSize: 1234,
    mediaType: 'video',
    container: 'mp4',
    sources: [
      {
        artifactKey: 'workspaces/ws-1/masters/source.mp4',
        sha256: 'b'.repeat(64),
        role: 'primary',
      },
    ],
    probe: { width: 1080, height: 1920, duration: 30, fps: 30 },
  }
  const left = createMediaArtifactManifest({
    ...base,
    recipe: {
      id: 'normalize-video',
      version: 'v1',
      parameters: { crf: 23, scale: { height: 1920, width: 1080 }, privatePrompt: 'secret' },
    },
  })
  const right = createMediaArtifactManifest({
    ...base,
    recipe: {
      id: 'normalize-video',
      version: 'v1',
      parameters: { privatePrompt: 'secret', scale: { width: 1080, height: 1920 }, crf: 23 },
    },
  })

  assert.deepEqual(left, right)
  assert.doesNotThrow(() => assertMediaArtifactManifest(left))
  assert.equal(left.schemaVersion, 'media-artifact-manifest/v1')
  assert.equal(left.manifestHash.length, 64)
  assert.equal(JSON.stringify(left).includes('secret'), false)
  assert.notEqual(
    left.manifestHash,
    createMediaArtifactManifest({
      ...base,
      recipe: { id: 'normalize-video', version: 'v1', parameters: { crf: 24 } },
    }).manifestHash,
  )
  expectDomainError(
    () =>
      assertMediaArtifactManifest({
        ...left,
        artifact: { ...left.artifact, byteSize: left.artifact.byteSize + 1 },
      }),
    'INVALID_MEDIA_ARTIFACT',
  )
})

test('media artifact manifest rejects absolute and traversal keys', () => {
  const input = {
    artifactSha256: 'a'.repeat(64),
    byteSize: 1,
    mediaType: 'video',
    container: 'mp4',
    recipe: { id: 'normalize-video', version: 'v1', parameters: {} },
  }

  for (const artifactKey of ['/tmp/output.mp4', 'C:\\output.mp4', '../output.mp4']) {
    expectDomainError(
      () => createMediaArtifactManifest({ ...input, artifactKey }),
      'INVALID_MEDIA_ARTIFACT',
    )
  }

  expectDomainError(
    () =>
      createMediaArtifactManifest({
        ...input,
        artifactKey: 'workspaces/ws/artifacts/output.mp4',
        sources: [
          {
            artifactKey: 'workspaces/ws/artifacts/output.mp4',
            sha256: 'b'.repeat(64),
            role: 'primary',
          },
        ],
      }),
    'INVALID_MEDIA_ARTIFACT',
  )
})

test('media artifact manifest v2 hashes tool and model provenance without raw config', () => {
  const input = {
    artifactKey: 'workspaces/ws/artifacts/generated.mp4',
    artifactSha256: 'a'.repeat(64),
    byteSize: 2048,
    mediaType: 'video',
    container: 'mp4',
    recipe: { id: 'generate-video', version: 'v2', parameters: { duration: 8 } },
    sources: [
      {
        artifactKey: 'workspaces/ws/masters/source.mp4',
        sha256: 'b'.repeat(64),
        role: 'primary',
        execution: {
          tool: { id: 'heygen-adapter', version: '2.1.0', digest: 'c'.repeat(64) },
          model: {
            provider: 'heygen',
            id: 'avatar-iv',
            version: '2026.07',
            config: { privatePrompt: 'do-not-persist', quality: 'high', seed: 42 },
          },
        },
      },
    ],
  }
  const manifest = createMediaArtifactManifestV2(input)
  const reordered = createMediaArtifactManifestV2({
    ...input,
    sources: [
      {
        ...input.sources[0],
        execution: {
          ...input.sources[0].execution,
          model: {
            ...input.sources[0].execution.model,
            config: { seed: 42, quality: 'high', privatePrompt: 'do-not-persist' },
          },
        },
      },
    ],
  })

  assert.equal(manifest.schemaVersion, 'media-artifact-manifest/v2')
  assert.deepEqual(manifest, reordered)
  assert.doesNotThrow(() => assertMediaArtifactManifest(manifest))
  assert.equal(manifest.sources[0].execution.tool.digest, 'c'.repeat(64))
  assert.equal(manifest.sources[0].execution.model.configHash.length, 64)
  assert.equal(JSON.stringify(manifest).includes('do-not-persist'), false)
  assert.equal(JSON.stringify(manifest).includes('privatePrompt'), false)
  const { manifestHash: _manifestHash, ...body } = manifest
  const maliciousBody = {
    ...body,
    sources: [
      {
        ...body.sources[0],
        execution: {
          ...body.sources[0].execution,
          rawConfig: { privatePrompt: 'smuggled-secret' },
        },
      },
    ],
  }
  expectDomainError(
    () =>
      assertMediaArtifactManifest({
        ...maliciousBody,
        manifestHash: calculateVersionHash(maliciousBody),
      }),
    'INVALID_MEDIA_ARTIFACT',
  )
  expectDomainError(
    () =>
      createMediaArtifactManifestV2({
        ...input,
        sources: [
          {
            ...input.sources[0],
            execution: {
              ...input.sources[0].execution,
              tool: { ...input.sources[0].execution.tool, digest: 'invalid' },
            },
          },
        ],
      }),
    'INVALID_MEDIA_ARTIFACT',
  )
})

test('manifest v3 references canonical parameters encrypted with authenticated context', async () => {
  const parameters = { crf: 23, privatePrompt: 'protected-replay-value' }
  const replayable = createReplayableMediaArtifactManifest({
    artifactKey: 'workspaces/ws/artifacts/replayable.mp4',
    artifactSha256: 'a'.repeat(64),
    byteSize: 4096,
    mediaType: 'video',
    container: 'mp4',
    recipe: { id: 'render-video', version: 'v3', parameters },
    sources: [
      {
        artifactKey: 'workspaces/ws/masters/source.mov',
        sha256: 'b'.repeat(64),
        role: 'primary',
        execution: {
          tool: { id: 'ffmpeg', version: '7.1.1', digest: 'c'.repeat(64) },
        },
      },
    ],
  })

  assert.equal(replayable.manifest.schemaVersion, 'media-artifact-manifest/v3')
  assert.equal(
    replayable.manifest.recipe.parametersRef,
    replayable.recipeParameters.ref,
  )
  assert.equal(
    replayable.manifest.recipe.parametersHash,
    replayable.recipeParameters.parametersHash,
  )
  assert.equal(JSON.stringify(replayable.manifest).includes('protected-replay-value'), false)
  assert.equal(replayable.recipeParameters.canonicalJson.includes('protected-replay-value'), true)
  assert.doesNotThrow(() => assertRecipeParameterPayload(replayable.recipeParameters))
  assert.deepEqual(
    createRecipeParameterPayload({ privatePrompt: 'protected-replay-value', crf: 23 }),
    replayable.recipeParameters,
  )

  const cipher = createAesRecipeParameterCipher({
    keyId: 'test-key-v1',
    key: Buffer.alloc(32, 7),
  })
  const context = `workspace-1:${replayable.recipeParameters.ref}`
  const sealed = await cipher.seal(replayable.recipeParameters.canonicalJson, context)
  assert.equal(sealed.algorithm, 'aes-256-gcm')
  assert.equal(sealed.ciphertext.includes('protected-replay-value'), false)
  assert.equal(
    await cipher.open(sealed, context),
    replayable.recipeParameters.canonicalJson,
  )
  await assert.rejects(
    cipher.open(sealed, `workspace-2:${replayable.recipeParameters.ref}`),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('artifact replay specification exposes references but never protected parameters', async () => {
  const parametersHash = 'd'.repeat(64)
  const parametersRef = `recipe-parameters/sha256/${parametersHash}`
  const artifact = {
    id: 'artifact-replayable',
    manifests: [
      {
        id: 'manifest-replayable',
        schemaVersion: 'media-artifact-manifest/v3',
        manifestHash: 'e'.repeat(64),
        recipe: {
          id: 'render-video',
          version: 'v3',
          parametersHash,
          parametersRef,
        },
        recipeParameters: {
          ref: parametersRef,
          parametersHash,
          canonicalByteSize: 81,
          algorithm: 'aes-256-gcm',
        },
        sources: [],
        createdAt: '2026-07-13T22:30:00.000Z',
      },
      {
        id: 'manifest-legacy',
        schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: 'f'.repeat(64),
        recipe: {
          id: 'render-video',
          version: 'v2',
          parametersHash,
        },
        sources: [],
        createdAt: '2026-07-13T22:29:00.000Z',
      },
    ],
  }
  const readReplaySpec = readMediaArtifactReplaySpecService({
    repository: { async findById() { return artifact } },
  })

  const replayable = await readReplaySpec(
    'workspace-1',
    artifact.id,
    'manifest-replayable',
  )
  assert.equal(replayable.available, true)
  assert.deepEqual(replayable.parameters, {
    ref: parametersRef,
    canonicalByteSize: 81,
    protection: { algorithm: 'aes-256-gcm' },
  })
  assert.equal(JSON.stringify(replayable).includes('canonicalJson'), false)
  assert.equal(JSON.stringify(replayable).includes('ciphertext'), false)
  assert.equal(JSON.stringify(replayable).includes('keyId'), false)

  const legacy = await readReplaySpec('workspace-1', artifact.id, 'manifest-legacy')
  assert.equal(legacy.available, false)
  assert.equal('parameters' in legacy, false)
  assert.deepEqual(legacy.issues.map((issue) => issue.code), [
    'REPLAY_PARAMETERS_MISSING',
  ])
})

test('media artifact lookup normalizes ids and hides missing workspace records', async () => {
  const found = { id: 'artifact-found' }
  const calls = []
  const readArtifact = readMediaArtifactService({
    repository: {
      async findById(workspaceId, artifactId) {
        calls.push({ workspaceId, artifactId })
        return artifactId === found.id ? found : null
      },
    },
  })

  assert.equal(await readArtifact('workspace-1', ` ${found.id} `), found)
  assert.deepEqual(calls, [{ workspaceId: 'workspace-1', artifactId: found.id }])
  await assert.rejects(
    readArtifact('workspace-1', 'artifact-hidden-in-another-workspace'),
    (error) => error instanceof DomainError && error.code === 'MEDIA_ARTIFACT_NOT_FOUND',
  )
  await assert.rejects(
    readArtifact('workspace-1', 'x'),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('artifact provenance reports legacy edges instead of inventing execution identity', async () => {
  const artifact = {
    id: 'artifact-legacy',
    workspaceId: 'workspace-1',
    artifactKey: 'workspaces/1/legacy.mp4',
    sha256: 'a'.repeat(64),
    byteSize: 100n,
    mediaType: 'video',
    container: 'mp4',
    status: 'available',
    manifests: [
      {
        id: 'manifest-legacy',
        schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: 'b'.repeat(64),
        recipe: { id: 'normalize-video', version: 'v1', parametersHash: 'c'.repeat(64) },
        sources: [
          {
            artifactId: 'artifact-source',
            artifactKey: 'workspaces/1/source.mov',
            sha256: 'd'.repeat(64),
            role: 'primary',
            ordinal: 0,
          },
        ],
        createdAt: '2026-07-12T20:00:00.000Z',
      },
    ],
    createdAt: '2026-07-12T20:00:00.000Z',
  }
  const readProvenance = readMediaArtifactProvenanceService({
    repository: { async findById() { return artifact } },
  })

  const result = await readProvenance('workspace-1', artifact.id, 'manifest-legacy')
  assert.equal(result.complete, false)
  assert.equal('execution' in result.edges[0], false)
  assert.deepEqual(result.issues, [
    {
      code: 'EXECUTION_PROVENANCE_MISSING',
      sourceArtifactId: 'artifact-source',
      ordinal: 0,
      message: 'Lineage edge has no versioned execution provenance',
    },
  ])
})

test('lineage diagnostic returns a deterministic source-first healthy graph', async () => {
  const sha = (character) => character.repeat(64)
  const makeManifest = (id, sources = []) => ({
    id,
    schemaVersion: 'media-artifact-manifest/v1',
    manifestHash: sha(id === 'manifest-source' ? 'c' : 'd'),
    recipe: {
      id: sources.length === 0 ? 'ingest-source' : 'normalize-video',
      version: 'v1',
      parametersHash: sha('e'),
    },
    sources,
    createdAt: '2026-07-12T20:00:00.000Z',
  })
  const source = {
    id: 'artifact-source',
    workspaceId: 'workspace-1',
    artifactKey: 'workspaces/1/raw/source.mov',
    sha256: sha('a'),
    byteSize: 100n,
    mediaType: 'video',
    container: 'mov',
    status: 'available',
    manifests: [makeManifest('manifest-source')],
    createdAt: '2026-07-12T20:00:00.000Z',
  }
  const derived = {
    ...source,
    id: 'artifact-derived',
    artifactKey: 'workspaces/1/derived/final.mp4',
    sha256: sha('b'),
    container: 'mp4',
    manifests: [
      makeManifest('manifest-derived', [
        {
          artifactId: source.id,
          artifactKey: source.artifactKey,
          sha256: source.sha256,
          role: 'primary',
          ordinal: 0,
        },
      ]),
    ],
  }
  const records = new Map([[source.id, source], [derived.id, derived]])
  const diagnose = diagnoseMediaArtifactLineageService({
    repository: { async findById(_workspaceId, id) { return records.get(id) ?? null } },
  })

  const result = await diagnose('workspace-1', derived.id, 'manifest-derived')
  assert.equal(result.healthy, true)
  assert.deepEqual(result.nodes.map((node) => node.artifactId), [source.id, derived.id])
  assert.deepEqual(result.edges, [
    {
      sourceArtifactId: source.id,
      targetArtifactId: derived.id,
      sha256: source.sha256,
      role: 'primary',
      ordinal: 0,
    },
  ])
  assert.deepEqual(result.issues, [])

  records.set(source.id, { ...source, status: 'quarantined' })
  const unhealthy = await diagnose('workspace-1', derived.id, 'manifest-derived')
  assert.equal(unhealthy.healthy, false)
  assert.deepEqual(unhealthy.issues.map((issue) => issue.code), ['ARTIFACT_UNAVAILABLE'])
  await assert.rejects(
    diagnose('workspace-1', derived.id, 'missing-manifest'),
    (error) =>
      error instanceof DomainError && error.code === 'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
  )
})

test('lineage diagnostic detects cycles and bounded graph truncation', async () => {
  const sha = (character) => character.repeat(64)
  const makeRecord = (id, sourceId) => ({
    id,
    workspaceId: 'workspace-1',
    artifactKey: `workspaces/1/${id}.mp4`,
    sha256: sha(id === 'artifact-a' ? 'a' : 'b'),
    byteSize: 100n,
    mediaType: 'video',
    container: 'mp4',
    status: 'available',
    manifests: [
      {
        id: `manifest-${id}`,
        schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: sha(id === 'artifact-a' ? 'c' : 'd'),
        recipe: { id: 'test-recipe', version: 'v1', parametersHash: sha('e') },
        sources: [
          {
            artifactId: sourceId,
            artifactKey: `workspaces/1/${sourceId}.mp4`,
            sha256: sha(sourceId === 'artifact-a' ? 'a' : 'b'),
            role: 'primary',
            ordinal: 0,
          },
        ],
        createdAt: '2026-07-12T20:00:00.000Z',
      },
    ],
    createdAt: '2026-07-12T20:00:00.000Z',
  })
  const artifactA = makeRecord('artifact-a', 'artifact-b')
  const artifactB = makeRecord('artifact-b', 'artifact-a')
  const records = new Map([[artifactA.id, artifactA], [artifactB.id, artifactB]])
  const repository = { async findById(_workspaceId, id) { return records.get(id) ?? null } }

  const cycle = await diagnoseMediaArtifactLineageService({ repository })(
    'workspace-1', artifactA.id, 'manifest-artifact-a',
  )
  assert.equal(cycle.healthy, false)
  assert.ok(cycle.issues.some((issue) => issue.code === 'LINEAGE_CYCLE'))

  const bounded = await diagnoseMediaArtifactLineageService({ repository, maxNodes: 1 })(
    'workspace-1', artifactA.id, 'manifest-artifact-a',
  )
  assert.equal(bounded.limits.truncated, true)
  assert.ok(bounded.issues.some((issue) => issue.code === 'GRAPH_LIMIT_EXCEEDED'))
})
