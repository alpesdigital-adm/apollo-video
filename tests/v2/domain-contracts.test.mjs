import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
  createReconstructableMediaArtifactManifest,
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
  requireResolvedEditCommand,
  resolveEditCommandConcurrency,
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
import { readMediaArtifactRenderInputService } from '../../src/v2/application/read-media-artifact-render-input.ts'
import { materializeRenderInputService } from '../../src/v2/application/materialize-render-input.ts'
import { preflightRenderInputService } from '../../src/v2/application/preflight-render-input.ts'
import { preflightMediaArtifactReconstructionService } from '../../src/v2/application/preflight-media-artifact-reconstruction.ts'
import {
  assertRenderInputSpec,
  createRenderInputSpec,
} from '../../src/v2/domain/render-input.ts'
import { assertRenderInputPayload } from '../../src/v2/domain/render-input-payload.ts'
import { createConfiguredRenderTargetRegistry } from '../../src/v2/infrastructure/render-target-registry.ts'
import {
  createAssetRightsSnapshot,
  evaluateAssetUse,
} from '../../src/v2/domain/asset-rights.ts'
import { authorizeRenderInputMaterializationService } from '../../src/v2/application/authorize-render-input-materialization.ts'
import { materializeAuthorizedRenderInputService } from '../../src/v2/application/materialize-authorized-render-input.ts'
import { createMaterializationAuthorization } from '../../src/v2/domain/materialization-authorization.ts'
import { LocalArtifactRenderInputResolver } from '../../src/v2/infrastructure/local-artifact-render-input-resolver.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaMaterializationAuthorizationRepository } from '../../src/v2/infrastructure/prisma/materialization-authorization-repository.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { compileApolloVideoRenderProps } from '../../src/v2/application/compile-apollo-video-render-props.ts'
import { renderAuthorizedInputService } from '../../src/v2/application/render-authorized-input.ts'
import {
  advancePublicOperationPhase,
  cancelPublicOperation,
  createQueuedPublicOperation,
  rehydratePublicOperation,
  retryOrFailPublicOperation,
  retryPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { enqueueAuthorizedRenderService } from '../../src/v2/application/enqueue-authorized-render.ts'
import { listDeadLetterOperationsService } from '../../src/v2/application/list-dead-letter-operations.ts'
import { listPublicOperationsService } from '../../src/v2/application/list-public-operations.ts'
import { presentPublicOperation } from '../../src/v2/public-api/presenters.ts'
import {
  PUBLIC_EVENT_CATALOG,
  assertUniquePublicEventIds,
  createPublicEvent,
  createPublicEventId,
} from '../../src/v2/domain/public-event.ts'

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

test('public event envelope is versioned, bounded and tied to the initial catalog', () => {
  assert.deepEqual(
    PUBLIC_EVENT_CATALOG.map((descriptor) => descriptor.type),
    [
      'project.created',
      'project.version.created',
      'project.status.changed',
      'operation.status.changed',
      'operation.succeeded',
      'operation.failed',
      'annotation.created',
      'annotation.resolved',
      'quality.report.created',
      'approval.changed',
      'artifact.ready',
      'artifact.rejected',
      'budget.threshold.reached',
      'client.suspended',
    ],
  )
  assert.ok(Object.isFrozen(PUBLIC_EVENT_CATALOG))
  assert.ok(PUBLIC_EVENT_CATALOG.every(Object.isFrozen))
  assert.equal(
    createPublicEventId(() => '123E4567-E89B-42D3-A456-426614174000'),
    '123e4567-e89b-42d3-a456-426614174000',
  )

  const sourceData = {
    previousStatus: 'queued',
    status: 'running',
    changes: [{ field: 'status', safe: true }],
  }
  const event = createPublicEvent({
    id: '123e4567-e89b-42d3-a456-426614174000',
    type: 'operation.status.changed',
    version: '1.0.0',
    workspaceId: 'workspace-event-1',
    occurredAt: '2026-07-14T18:00:00.000Z',
    sequence: 7,
    actor: { clientId: 'client-event-1' },
    resource: { type: 'operation', id: 'operation-event-1' },
    data: sourceData,
  })
  sourceData.status = 'tampered'
  assert.equal(event.data.status, 'running')
  assert.ok(Object.isFrozen(event))
  assert.ok(Object.isFrozen(event.actor))
  assert.ok(Object.isFrozen(event.resource))
  assert.ok(Object.isFrozen(event.data))
  assert.ok(Object.isFrozen(event.data.changes))
  assert.ok(Object.isFrozen(event.data.changes[0]))

  const second = createPublicEvent({
    ...event,
    id: '123e4567-e89b-42d3-b456-426614174001',
    data: { status: 'succeeded' },
  })
  assert.doesNotThrow(() => assertUniquePublicEventIds([event, second]))
  expectDomainError(
    () => assertUniquePublicEventIds([event, event]),
    'INVALID_PUBLIC_EVENT',
  )

  const cyclic = {}
  cyclic.self = cyclic
  for (const override of [
    { id: 'not-a-uuid' },
    { type: 'operation.unknown' },
    { version: '2.0.0' },
    { occurredAt: '2026-07-14T18:00:00Z' },
    { sequence: 0 },
    { actor: {} },
    { resource: { type: 'project', id: 'operation-event-1' } },
    { data: { value: Number.POSITIVE_INFINITY } },
    { data: cyclic },
    { data: { value: new Date() } },
    { data: JSON.parse('{"__proto__":{"polluted":true}}') },
    { data: { value: 'x'.repeat(65_536) } },
  ]) {
    expectDomainError(
      () => createPublicEvent({
        id: '123e4567-e89b-42d3-a456-426614174000',
        type: 'operation.status.changed',
        version: '1.0.0',
        workspaceId: 'workspace-event-1',
        occurredAt: '2026-07-14T18:00:00.000Z',
        resource: { type: 'operation', id: 'operation-event-1' },
        data: {},
        ...override,
      }),
      'INVALID_PUBLIC_EVENT',
    )
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

test('Apollo Video props compiler resolves only declared materialized asset IDs', async () => {
  const createCompilerInput = (overrides = {}) =>
    createRenderInputSpec({
      schemaVersion: 'render-input/v1',
      renderer: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
      composition: {
        id: 'apollo-video',
        version: 'v1',
        propsSchemaRef: 'apollo://render-props/apollo-video/v1',
      },
      plan: { id: 'plan-compiler', versionId: 'plan-compiler-version', hash: '2'.repeat(64) },
      output: {
        id: 'preset-9x16',
        locale: 'pt-BR',
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        fps: 30,
        safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
        durationInFrames: 60,
        ...overrides.output,
      },
      assets: [
        {
          id: 'primary-video',
          artifactId: 'artifact-compiler-video',
          artifactKey: 'workspaces/1/compiler-video.mp4',
          kind: 'video',
          role: 'primary',
          ordinal: 0,
          sha256: '3'.repeat(64),
          byteSize: 4096,
        },
        {
          id: 'insert-image',
          artifactId: 'artifact-compiler-image',
          artifactKey: 'workspaces/1/compiler-image.jpg',
          kind: 'image',
          role: 'b-roll',
          ordinal: 1,
          sha256: '4'.repeat(64),
          byteSize: 1024,
        },
      ],
      props: overrides.props ?? {
        primaryVideoAssetId: 'primary-video',
        scenes: [
          {
            type: 'image-insert',
            fromFrame: 15,
            toFrame: 45,
            props: { imageAssetId: 'insert-image', layout: 'full' },
          },
        ],
        subtitles: [{ text: 'Uma legenda segura', fromFrame: 0, toFrame: 30 }],
        palette: {
          primary: '#FFB800',
          secondary: '#20202A',
          accent: '#FF6B35',
          text: '#FFFFFF',
          background: '#050508',
        },
        stylePreset: 'creator-clean',
        subtitleStyle: 'kinetic',
        gradePreset: 'natural',
      },
    })
  const spec = createCompilerInput()
  const materialized = await materializeRenderInputService({
    resolver: {
      async resolve(asset) {
        return {
          uri: `file:///worker/${asset.id}.${asset.kind === 'image' ? 'jpg' : 'mp4'}`,
          sha256: asset.sha256,
          byteSize: asset.byteSize,
        }
      },
    },
  })(spec)
  const compiled = compileApolloVideoRenderProps(materialized)
  assert.equal(compiled.videoSrc, 'file:///worker/primary-video.mp4')
  assert.equal(compiled.scenes[0].props.imageSrc, 'file:///worker/insert-image.jpg')
  assert.equal('imageAssetId' in compiled.scenes[0].props, false)
  assert.deepEqual(
    { from: compiled.scenes[0].from, to: compiled.scenes[0].to },
    { from: 0.5, to: 1.5 },
  )
  const unsafe = createCompilerInput({
    props: {
      primaryVideoAssetId: 'primary-video',
      scenes: [
        {
          type: 'image-insert',
          fromFrame: 15,
          toFrame: 45,
          props: { imageSrc: 'https://untrusted.example/image.jpg' },
        },
      ],
      subtitles: [],
      palette: {
        primary: '#FFB800', secondary: '#20202A', accent: '#FF6B35',
        text: '#FFFFFF', background: '#050508',
      },
    },
  })
  await assert.rejects(
    materializeRenderInputService({
      resolver: {
        async resolve(asset) {
          return {
            uri: `file:///worker/${asset.id}`,
            sha256: asset.sha256,
            byteSize: asset.byteSize,
          }
        },
      },
    })(unsafe).then(compileApolloVideoRenderProps),
    (error) => error instanceof DomainError && error.code === 'INVALID_RENDER_INPUT',
  )
})

test('authorized render promotes staged output only after a matching second materialization', async () => {
  const receipt = Object.freeze({
    schemaVersion: 'materialized-render-input-receipt/v1',
    authorizationId: 'authorization-render-1',
    artifactId: 'artifact-render-target',
    manifestId: 'manifest-render-target',
    inputHash: '5'.repeat(64),
    revalidationHash: '6'.repeat(64),
    assetCount: 1,
    revalidatedAt: '2026-07-14T12:00:00.000Z',
    validUntil: '2026-07-14T12:05:00.000Z',
  })
  const lease = {
    receipt,
    getRenderInput() { return { inputHash: receipt.inputHash } },
    toJSON() { return receipt },
  }
  let materializations = 0
  let commits = 0
  let discards = 0
  const renderer = {
    async recover() { return null },
    async stage(input) {
      assert.equal(input.inputHash, receipt.inputHash)
      const stagedReceipt = {
        schemaVersion: 'staged-render-receipt/v1',
        stageId: 'stage-render-1',
        inputHash: receipt.inputHash,
        outputSha256: '7'.repeat(64),
        byteSize: 4096,
        width: 1080,
        height: 1920,
        fps: 30,
        durationInFrames: 60,
        codec: 'h264',
        container: 'mp4',
      }
      return {
        receipt: stagedReceipt,
        async commit() {
          commits += 1
          return {
            ...stagedReceipt,
            schemaVersion: 'committed-render-receipt/v1',
            committedAt: '2026-07-14T12:02:00.000Z',
          }
        },
        async discard() { discards += 1 },
        toJSON() { return stagedReceipt },
      }
    },
  }
  const render = renderAuthorizedInputService({
    async materialize() {
      materializations += 1
      return lease
    },
    renderer,
    outputKeyFor: () => 'workspaces/1/renders/output.mp4',
  })
  const result = await render({
    workspaceId: 'workspace-1',
    authorizationId: 'authorization-render-1',
  })
  assert.equal(materializations, 2)
  assert.equal(commits, 1)
  assert.equal(discards, 0)
  assert.equal(result.output.outputSha256, '7'.repeat(64))
  assert.equal(result.getOutputKey(), 'workspaces/1/renders/output.mp4')
  assert.equal(JSON.stringify(result).includes('workspaces/1/renders/output.mp4'), false)

  materializations = 0
  commits = 0
  discards = 0
  await assert.rejects(
    renderAuthorizedInputService({
      async materialize() {
        materializations += 1
        return materializations === 1
          ? lease
          : { ...lease, receipt: { ...receipt, revalidationHash: '8'.repeat(64) } }
      },
      renderer,
      outputKeyFor: () => 'workspaces/1/renders/output-2.mp4',
    })({ workspaceId: 'workspace-1', authorizationId: 'authorization-render-1' }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_REVALIDATION_FAILED',
  )
  assert.equal(commits, 0)
  assert.equal(discards, 1)

  materializations = 0
  commits = 0
  discards = 0
  await assert.rejects(
    render({
      workspaceId: 'workspace-1',
      authorizationId: 'authorization-render-1',
      async beforeCommit() {
        throw new DomainError('RENDER_EXECUTION_FAILED', 'Worker lease was lost')
      },
    }),
    (error) => error instanceof DomainError && error.code === 'RENDER_EXECUTION_FAILED',
  )
  assert.equal(materializations, 2)
  assert.equal(commits, 0)
  assert.equal(discards, 1)

  materializations = 0
  let recoveryGates = 0
  const recovered = await renderAuthorizedInputService({
    async materialize() {
      materializations += 1
      return lease
    },
    renderer: {
      async recover() {
        return {
          schemaVersion: 'committed-render-receipt/v1',
          stageId: 'recovered-render-1',
          inputHash: receipt.inputHash,
          outputSha256: '7'.repeat(64),
          byteSize: 4096,
          width: 1080,
          height: 1920,
          fps: 30,
          durationInFrames: 60,
          codec: 'h264',
          container: 'mp4',
          committedAt: '2026-07-14T12:02:00.000Z',
        }
      },
      async stage() { throw new Error('recovered output must not render again') },
    },
    outputKeyFor: () => 'workspaces/1/renders/output.mp4',
  })({
    workspaceId: 'workspace-1',
    authorizationId: 'authorization-render-1',
    async beforeCommit() { recoveryGates += 1 },
  })
  assert.equal(materializations, 2)
  assert.equal(recoveryGates, 1)
  assert.equal(recovered.output.stageId, 'recovered-render-1')
})

test('PublicOperation queue invariants fail closed and presenter omits execution internals', () => {
  const operation = createQueuedPublicOperation({
    id: 'operation-render-1',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-render-1',
      manifestId: 'manifest-render-1',
    },
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  assert.equal(operation.status, 'queued')
  assert.equal(operation.progress.completed, 0)
  assert.ok(Object.isFrozen(operation))
  const presented = presentPublicOperation(operation)
  const serialized = JSON.stringify(presented)
  assert.equal(serialized.includes('workspaceId'), false)
  assert.equal(serialized.includes('clientId'), false)
  assert.equal(serialized.includes('authorizationId'), false)
  assert.equal(serialized.includes('inputHash'), false)
  assert.equal(serialized.includes('artifactKey'), false)
  assert.equal(serialized.includes('file:'), false)

  expectDomainError(
    () => rehydratePublicOperation({ ...operation, cancelable: false }),
    'INVALID_PUBLIC_OPERATION',
  )
  expectDomainError(
    () => rehydratePublicOperation({ ...operation, attempt: 1 }),
    'INVALID_PUBLIC_OPERATION',
  )
  expectDomainError(
    () => rehydratePublicOperation({
      ...operation,
      target: { ...operation.target, id: '../../escape' },
    }),
    'INVALID_PUBLIC_OPERATION',
  )
})

test('PublicOperation creation retries serialization conflicts before failing explicitly', async () => {
  const operation = createQueuedPublicOperation({
    id: 'operation-serialization-retry-1',
    workspaceId: 'workspace-serialization-retry-1',
    clientId: 'client-serialization-retry-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-serialization-retry-1',
      manifestId: 'manifest-serialization-retry-1',
    },
    createdAt: '2026-07-16T08:00:00.000Z',
  })
  let attempts = 0
  const repository = new PrismaPublicOperationRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.createOrReplay({
      operation,
      context: {
        authorizationId: 'authorization-serialization-retry-1',
        inputHash: 'a'.repeat(64),
      },
      idempotencyKey: 'operation-serialization-retry-key-1',
      requestFingerprint: 'b'.repeat(64),
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('operation listing binds stable opaque cursors to workspace and allowlisted filters', async () => {
  const createOperation = (id, createdAt) => createQueuedPublicOperation({
    id,
    workspaceId: 'workspace-list-1',
    clientId: 'client-list-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-list-1',
      manifestId: 'manifest-list-1',
    },
    createdAt,
  })
  const records = [
    createOperation('operation-list-3', '2026-07-14T12:00:03.000Z'),
    createOperation('operation-list-2', '2026-07-14T12:00:02.000Z'),
    createOperation('operation-list-1', '2026-07-14T12:00:01.000Z'),
  ].map((operation) => ({
    operation,
    context: { authorizationId: 'authorization-list-1', inputHash: 'a'.repeat(64) },
  }))
  const queries = []
  const list = listPublicOperationsService({
    operations: {
      async list(query) {
        queries.push(query)
        return query.after ? records.slice(1) : records
      },
    },
  })

  const first = await list({
    workspaceId: 'workspace-list-1',
    limit: 1,
    status: 'queued',
    type: 'artifact-render',
    targetId: 'artifact-list-1',
  })
  assert.deepEqual(first.operations.map((operation) => operation.id), ['operation-list-3'])
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)
  assert.equal(queries[0].limit, 2)

  const second = await list({
    workspaceId: 'workspace-list-1',
    limit: 1,
    after: first.nextCursor,
    status: 'queued',
    type: 'artifact-render',
    targetId: 'artifact-list-1',
  })
  assert.deepEqual(queries[1].after, {
    createdAt: '2026-07-14T12:00:03.000Z',
    id: 'operation-list-3',
  })
  assert.deepEqual(second.operations.map((operation) => operation.id), ['operation-list-2'])

  await assert.rejects(
    list({
      workspaceId: 'workspace-list-1',
      after: first.nextCursor,
      status: 'failed',
      type: 'artifact-render',
      targetId: 'artifact-list-1',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    list({ workspaceId: 'workspace-list-2', after: first.nextCursor }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  for (const invalid of [
    { limit: 0 },
    { limit: 101 },
    { status: 'unknown' },
    { type: 'internal-render' },
    { after: 'not-a-cursor' },
  ]) {
    await assert.rejects(
      list({ workspaceId: 'workspace-list-1', ...invalid }),
      (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
    )
  }
})

test('dead-letter listing fixes exhaustion semantics and binds them into its cursor', async () => {
  const operation = createQueuedPublicOperation({
    id: 'operation-dead-letter-list-1',
    workspaceId: 'workspace-dead-letter-list-1',
    clientId: 'client-dead-letter-list-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-dead-letter-list-1',
      manifestId: 'manifest-dead-letter-list-1',
    },
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  const queries = []
  const operations = {
    async list(query) {
      queries.push(query)
      return [
        { operation, context: { authorizationId: 'authorization-1', inputHash: 'a'.repeat(64) } },
        { operation: { ...operation, id: 'operation-dead-letter-list-0' }, context: { authorizationId: 'authorization-1', inputHash: 'a'.repeat(64) } },
      ]
    },
  }
  const listDeadLetter = listDeadLetterOperationsService({ operations })
  const first = await listDeadLetter({
    workspaceId: 'workspace-dead-letter-list-1',
    limit: 1,
    type: 'artifact-render',
    targetId: 'artifact-dead-letter-list-1',
  })
  assert.equal(queries[0].status, 'failed')
  assert.equal(queries[0].deadLettered, true)
  assert.equal(queries[0].limit, 2)
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)

  const listAll = listPublicOperationsService({ operations })
  await assert.rejects(
    listAll({
      workspaceId: 'workspace-dead-letter-list-1',
      after: first.nextCursor,
      status: 'failed',
      type: 'artifact-render',
      targetId: 'artifact-dead-letter-list-1',
      deadLettered: false,
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('PublicOperation attempt transitions reject stale order and exhaust retries safely', () => {
  const queued = createQueuedPublicOperation({
    id: 'operation-transition-1',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-render-1',
      manifestId: 'manifest-render-1',
    },
    maxAttempts: 2,
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  const first = startPublicOperationAttempt(queued, '2026-07-14T12:00:01.000Z')
  assert.deepEqual(
    { status: first.status, phase: first.phase, attempt: first.attempt },
    { status: 'running', phase: 'materializing', attempt: 1 },
  )
  const rendering = advancePublicOperationPhase(
    first,
    'rendering',
    '2026-07-14T12:00:02.000Z',
  )
  expectDomainError(
    () => advancePublicOperationPhase(rendering, 'materializing', '2026-07-14T12:00:03.000Z'),
    'INVALID_PUBLIC_OPERATION',
  )
  const retrying = retryOrFailPublicOperation(
    rendering,
    { code: 'render_execution_failed', message: 'Render failed safely', retryable: true },
    '2026-07-14T12:00:04.000Z',
    '2026-07-14T12:00:05.000Z',
  )
  assert.deepEqual(
    {
      status: retrying.status,
      phase: retrying.phase,
      retryable: retrying.retryable,
      nextAttemptAt: retrying.nextAttemptAt,
    },
    {
      status: 'retrying',
      phase: 'retrying',
      retryable: true,
      nextAttemptAt: '2026-07-14T12:00:05.000Z',
    },
  )
  assert.equal(presentPublicOperation(retrying).nextAttemptAt, undefined)
  expectDomainError(
    () => startPublicOperationAttempt(retrying, '2026-07-14T12:00:04.999Z'),
    'INVALID_PUBLIC_OPERATION',
  )
  const second = startPublicOperationAttempt(retrying, '2026-07-14T12:00:05.000Z')
  const terminal = retryOrFailPublicOperation(
    second,
    { code: 'render_execution_failed', message: 'Render failed safely', retryable: true },
    '2026-07-14T12:00:06.000Z',
  )
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.retryable, false)
  assert.equal(terminal.error.retryable, false)
  assert.equal(terminal.deadLetteredAt, terminal.completedAt)
  assert.equal(presentPublicOperation(terminal).deadLetteredAt, undefined)
  expectDomainError(
    () => startPublicOperationAttempt(terminal, '2026-07-14T12:00:07.000Z'),
    'INVALID_PUBLIC_OPERATION',
  )

  const persisted = advancePublicOperationPhase(
    advancePublicOperationPhase(rendering, 'verifying', '2026-07-14T12:00:03.000Z'),
    'persisting',
    '2026-07-14T12:00:04.000Z',
  )
  const succeeded = succeedPublicOperation(persisted, '2026-07-14T12:00:05.000Z')
  assert.equal(succeeded.status, 'succeeded')
  assert.deepEqual(succeeded.result.resource, succeeded.target)
})

test('PublicOperation cancellation is terminal, idempotent and clears retry scheduling', () => {
  const queued = createQueuedPublicOperation({
    id: 'operation-cancel-1',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-cancel-1',
      manifestId: 'manifest-cancel-1',
    },
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  const canceledQueued = cancelPublicOperation(queued, '2026-07-14T12:00:01.000Z')
  assert.equal(canceledQueued.status, 'canceled')
  assert.equal(canceledQueued.startedAt, undefined)
  assert.equal(canceledQueued.completedAt, '2026-07-14T12:00:01.000Z')
  assert.deepEqual(
    cancelPublicOperation(canceledQueued, '2026-07-14T12:00:02.000Z'),
    canceledQueued,
  )

  const running = startPublicOperationAttempt(queued, '2026-07-14T12:00:01.000Z')
  const retrying = retryOrFailPublicOperation(
    running,
    { code: 'render_execution_failed', message: 'Render failed safely', retryable: true },
    '2026-07-14T12:00:02.000Z',
    '2026-07-14T12:00:07.000Z',
  )
  const canceledRetry = cancelPublicOperation(retrying, '2026-07-14T12:00:03.000Z')
  assert.equal(canceledRetry.status, 'canceled')
  assert.equal(canceledRetry.nextAttemptAt, undefined)
  assert.equal(canceledRetry.retryable, false)
  assert.equal(canceledRetry.attempt, 1)
  assert.equal(presentPublicOperation(canceledRetry).status, 'canceled')
})

test('manual retry reopens only failed or canceled operations and preserves attempt history', () => {
  const queued = createQueuedPublicOperation({
    id: 'operation-manual-retry-1',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-manual-retry-1',
      manifestId: 'manifest-manual-retry-1',
    },
    maxAttempts: 1,
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  assert.deepEqual(
    retryPublicOperation(
      queued,
      '2026-07-14T12:00:01.000Z',
      '2026-07-14T12:00:01.001Z',
    ),
    queued,
  )
  const canceledQueued = cancelPublicOperation(queued, '2026-07-14T12:00:01.000Z')
  const reopenedQueued = retryPublicOperation(
    canceledQueued,
    '2026-07-14T12:00:02.000Z',
    '2026-07-14T12:00:02.001Z',
  )
  assert.equal(reopenedQueued.status, 'queued')
  assert.equal(reopenedQueued.completedAt, undefined)
  assert.equal(reopenedQueued.attempt, 0)

  const running = startPublicOperationAttempt(queued, '2026-07-14T12:00:01.000Z')
  const failed = retryOrFailPublicOperation(
    running,
    { code: 'render_execution_failed', message: 'Render failed safely', retryable: true },
    '2026-07-14T12:00:02.000Z',
  )
  assert.equal(failed.deadLetteredAt, failed.completedAt)
  const reopenedFailed = retryPublicOperation(
    failed,
    '2026-07-14T12:00:03.000Z',
    '2026-07-14T12:00:03.001Z',
  )
  assert.equal(reopenedFailed.status, 'retrying')
  assert.equal(reopenedFailed.attempt, 1)
  assert.equal(reopenedFailed.maxAttempts, 2)
  assert.equal(reopenedFailed.deadLetteredAt, undefined)
  assert.equal(reopenedFailed.error, undefined)
  const secondAttempt = startPublicOperationAttempt(
    reopenedFailed,
    '2026-07-14T12:00:03.001Z',
  )
  const persisted = advancePublicOperationPhase(
    advancePublicOperationPhase(
      secondAttempt,
      'rendering',
      '2026-07-14T12:00:04.000Z',
    ),
    'persisting',
    '2026-07-14T12:00:05.000Z',
  )
  const succeeded = succeedPublicOperation(persisted, '2026-07-14T12:00:06.000Z')
  expectDomainError(
    () => retryPublicOperation(
      succeeded,
      '2026-07-14T12:00:07.000Z',
      '2026-07-14T12:00:07.001Z',
    ),
    'PUBLIC_OPERATION_RETRY_REJECTED',
  )
})

test('authorized render enqueue is idempotent, actor-bound and expiry-aware', async () => {
  const authorization = createMaterializationAuthorization({
    id: 'authorization-operation-1',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-render-1',
    manifestId: 'manifest-render-1',
    inputHash: 'a'.repeat(64),
    use: 'paid-ad',
    locale: 'pt-BR',
    syntheticOperations: [],
    issues: [],
    decisions: [{
      artifactId: 'artifact-source-1',
      assetOrdinal: 0,
      assetKind: 'video',
      outcome: 'allow',
      reasonCodes: [],
      rightsSnapshotId: 'rights-source-1',
      rightsSnapshotHash: 'b'.repeat(64),
      validUntil: '2026-07-14T12:05:00.000Z',
    }],
    evaluatedAt: '2026-07-14T12:00:00.000Z',
    actor: { type: 'api-client', id: 'client-1' },
  })
  const stored = new Map()
  const operations = {
    async findById() { return null },
    async findReplay({ workspaceId, clientId, idempotencyKey, requestFingerprint }) {
      const value = stored.get(`${workspaceId}:${clientId}:${idempotencyKey}`)
      if (!value) return null
      if (value.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency payload mismatch',
        )
      }
      return { ...value.record, replayed: true }
    },
    async createOrReplay(input) {
      const key = `${input.operation.workspaceId}:${input.operation.clientId}:${input.idempotencyKey}`
      const record = {
        operation: input.operation,
        context: Object.freeze({ ...input.context }),
      }
      stored.set(key, { requestFingerprint: input.requestFingerprint, record })
      return { ...record, replayed: false }
    },
  }
  let ids = 0
  const enqueue = enqueueAuthorizedRenderService({
    authorizations: {
      async findById(workspaceId, id) {
        return workspaceId === authorization.workspaceId && id === authorization.id
          ? authorization
          : null
      },
    },
    operations,
    clock: () => new Date('2026-07-14T12:01:00.000Z'),
    createId: () => `operation-render-${++ids}`,
  })
  const request = {
    workspaceId: 'workspace-1',
    artifactId: 'artifact-render-1',
    manifestId: 'manifest-render-1',
    authorizationId: authorization.id,
    actor: { type: 'api-client', id: 'client-1' },
    idempotencyKey: 'render-request-1',
  }
  const created = await enqueue(request)
  const replay = await enqueue(request)
  assert.equal(created.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.operation.id, created.operation.id)
  assert.equal(created.operation.status, 'queued')
  assert.deepEqual(created.context, {
    kind: 'artifact-render',
    authorizationId: authorization.id,
    inputHash: authorization.inputHash,
  })
  assert.equal(ids, 1)

  await assert.rejects(
    enqueue({ ...request, actor: { type: 'api-client', id: 'client-2' }, idempotencyKey: 'render-request-2' }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_AUTHORIZATION_REJECTED',
  )
  const expiredEnqueue = enqueueAuthorizedRenderService({
    authorizations: { async findById() { return authorization } },
    operations,
    clock: () => new Date('2026-07-14T12:06:00.000Z'),
    createId: () => 'operation-render-expired',
  })
  await assert.rejects(
    expiredEnqueue({ ...request, idempotencyKey: 'render-request-expired' }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_AUTHORIZATION_EXPIRED',
  )
})

test('asset rights and consent are immutable, content-addressed and fail closed', () => {
  const createRights = (overrides = {}) =>
    createAssetRightsSnapshot({
      id: 'rights-snapshot-1',
      workspaceId: 'workspace-1',
      artifactId: 'artifact-source-1',
      sequence: 1,
      draft: {
        owner: 'Alpes Digital',
        status: 'approved',
        allowedUses: ['organic-content', 'paid-ad'],
        prohibitedUses: [],
        allowedMarkets: ['BR'],
        allowedLocales: ['pt-BR'],
        allowedSyntheticOperations: [],
        consent: { status: 'not-required', allowedUses: [] },
        ...overrides,
      },
      createdBy: { type: 'api-client', id: 'client-1' },
      createdAt: '2026-07-14T12:00:00.000Z',
    })
  const rights = createRights()
  const reordered = createRights({ allowedUses: ['paid-ad', 'organic-content'] })
  assert.equal(rights.snapshotHash, reordered.snapshotHash)
  assert.ok(Object.isFrozen(rights))
  assert.ok(Object.isFrozen(rights.consent))

  const allowed = evaluateAssetUse(
    rights,
    { workspaceId: 'workspace-1', use: 'paid-ad', market: 'BR', locale: 'pt-BR' },
    new Date('2026-07-14T12:01:00.000Z'),
  )
  assert.equal(allowed.outcome, 'allow')
  assert.equal(allowed.validUntil, '2026-07-14T12:06:00.000Z')

  assert.deepEqual(
    evaluateAssetUse(
      rights,
      { workspaceId: 'workspace-1', use: 'paid-ad', market: 'US', locale: 'pt-BR' },
      new Date('2026-07-14T12:01:00.000Z'),
    ).reasonCodes,
    ['RIGHTS_MARKET_NOT_ALLOWED'],
  )
  assert.deepEqual(
    evaluateAssetUse(
      createRights({ consent: { status: 'unknown', allowedUses: [] } }),
      { workspaceId: 'workspace-1', use: 'paid-ad', market: 'BR', locale: 'pt-BR' },
      new Date('2026-07-14T12:01:00.000Z'),
    ).reasonCodes,
    ['CONSENT_STATUS_UNKNOWN'],
  )
  assert.deepEqual(
    evaluateAssetUse(
      createRights({ expiresAt: '2026-07-14T12:00:30.000Z' }),
      { workspaceId: 'workspace-1', use: 'paid-ad', market: 'BR', locale: 'pt-BR' },
      new Date('2026-07-14T12:01:00.000Z'),
    ).reasonCodes,
    ['RIGHTS_EXPIRED'],
  )
  assert.deepEqual(
    evaluateAssetUse(
      null,
      { workspaceId: 'workspace-1', use: 'paid-ad', market: 'BR', locale: 'pt-BR' },
      new Date('2026-07-14T12:01:00.000Z'),
    ).reasonCodes,
    ['RIGHTS_MISSING'],
  )
})

test('asset rights persistence retries serialization conflicts before failing explicitly', async () => {
  let attempts = 0
  const repository = new PrismaAssetRightsRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })
  const prototype = createAssetRightsSnapshot({
    id: 'rights-serialization-conflict-1',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-serialization-conflict-1',
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses: ['paid-ad'],
      prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'client-1' },
    createdAt: '2026-07-16T14:00:00.000Z',
  })

  await assert.rejects(
    () => repository.setCurrent(prototype, 'a'.repeat(64)),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('materialization authorization evaluates every RenderInput asset and records a bounded decision', async () => {
  const input = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: 'a'.repeat(64) },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: { id: 'plan-auth', versionId: 'plan-version-auth', hash: 'b'.repeat(64) },
    output: {
      id: 'preset-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      durationInFrames: 90,
    },
    assets: [
      {
        id: 'asset-auth-source',
        artifactId: 'artifact-auth-source',
        artifactKey: 'workspaces/1/source.mp4',
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: 'c'.repeat(64),
        byteSize: 1024,
      },
    ],
    props: { privateTitle: 'must-not-leak' },
  })
  const rights = createAssetRightsSnapshot({
    id: 'rights-auth-source',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-auth-source',
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses: ['paid-ad'],
      prohibitedUses: [],
      allowedMarkets: ['BR'],
      allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'client-1' },
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  let recorded
  const authorize = authorizeRenderInputMaterializationService({
    artifactRepository: {
      async findById() {
        return {
          id: 'artifact-output',
          manifests: [
            {
              id: 'manifest-output',
              renderInput: {
                ref: `render-input/sha256/${input.inputHash}`,
                inputHash: input.inputHash,
              },
            },
          ],
        }
      },
    },
    protectedRenderInputs: { async read() { return input } },
    assetAvailability: { async inspect() { return { available: true } } },
    targets: { supportsRenderer() { return true }, supportsComposition() { return true } },
    rights: {
      async findCurrentForArtifacts() { return new Map([['artifact-auth-source', rights]]) },
    },
    authorizations: {
      async findReplay() { return null },
      async createOrReplay(value) {
        recorded = value
        return { authorization: value.authorization, replayed: false }
      },
    },
    clock: () => new Date('2026-07-14T12:01:00.000Z'),
    createId: () => 'materialization-auth-1',
  })
  const result = await authorize({
    workspaceId: 'workspace-1',
    artifactId: 'artifact-output',
    manifestId: 'manifest-output',
    use: 'paid-ad',
    market: 'BR',
    actor: { type: 'api-client', id: 'client-1' },
    idempotencyKey: 'authorization-request-1',
  })
  assert.equal(result.authorization.status, 'authorized')
  assert.equal(result.authorization.locale, 'pt-BR')
  assert.equal(result.authorization.validUntil, '2026-07-14T12:06:00.000Z')
  assert.deepEqual(result.authorization.decisions.map((decision) => decision.outcome), ['allow'])
  assert.equal(recorded.requestFingerprint.length, 64)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(result).includes('workspaces/1/source.mp4'), false)
})

test('materialization authorization retries serialization conflicts before failing explicitly', async () => {
  const authorization = createMaterializationAuthorization({
    id: 'authorization-serialization-retry-1',
    workspaceId: 'workspace-serialization-retry-1',
    artifactId: 'artifact-serialization-retry-1',
    manifestId: 'manifest-serialization-retry-1',
    inputHash: 'c'.repeat(64),
    use: 'paid-ad',
    locale: 'pt-BR',
    syntheticOperations: [],
    issues: [],
    decisions: [],
    evaluatedAt: '2026-07-16T08:01:00.000Z',
    actor: { type: 'api-client', id: 'client-serialization-retry-1' },
  })
  let attempts = 0
  const repository = new PrismaMaterializationAuthorizationRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.createOrReplay({
      authorization,
      clientId: 'client-serialization-retry-1',
      idempotencyKey: 'authorization-serialization-retry-key-1',
      requestFingerprint: 'd'.repeat(64),
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('authorized worker materialization revalidates rights and keeps locations internal', async () => {
  const input = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: 'd'.repeat(64) },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: { id: 'plan-worker', versionId: 'plan-version-worker', hash: 'e'.repeat(64) },
    output: {
      id: 'preset-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      durationInFrames: 90,
    },
    assets: [
      {
        id: 'worker-source',
        artifactId: 'artifact-worker-source',
        artifactKey: 'workspaces/1/worker-source.mp4',
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: 'f'.repeat(64),
        byteSize: 2048,
      },
    ],
    props: { confidentialPrompt: 'never-serialize-this' },
  })
  const rights = createAssetRightsSnapshot({
    id: 'rights-worker-source',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-worker-source',
    sequence: 1,
    draft: {
      owner: 'Alpes Digital',
      status: 'approved',
      allowedUses: ['paid-ad'],
      prohibitedUses: [],
      allowedMarkets: ['BR'],
      allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'client-1' },
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  const evaluatedAt = new Date('2026-07-14T12:01:00.000Z')
  const authorization = createMaterializationAuthorization({
    id: 'materialization-worker-1',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-worker-output',
    manifestId: 'manifest-worker-output',
    inputHash: input.inputHash,
    use: 'paid-ad',
    market: 'BR',
    locale: 'pt-BR',
    syntheticOperations: [],
    issues: [],
    decisions: [
      {
        artifactId: 'artifact-worker-source',
        assetOrdinal: 0,
        assetKind: 'video',
        ...evaluateAssetUse(
          rights,
          { workspaceId: 'workspace-1', use: 'paid-ad', market: 'BR', locale: 'pt-BR' },
          evaluatedAt,
        ),
      },
    ],
    evaluatedAt: evaluatedAt.toISOString(),
    actor: { type: 'api-client', id: 'client-1' },
  })
  let currentRights = rights
  let workerNow = new Date('2026-07-14T12:02:00.000Z')
  let resolverCalls = 0
  const materialize = materializeAuthorizedRenderInputService({
    artifacts: {
      async findById() {
        return {
          id: 'artifact-worker-output',
          manifests: [
            {
              id: 'manifest-worker-output',
              renderInput: {
                ref: `render-input/sha256/${input.inputHash}`,
                inputHash: input.inputHash,
              },
            },
          ],
        }
      },
    },
    protectedRenderInputs: { async read() { return input } },
    assetAvailability: { async inspect() { return { available: true } } },
    targets: { supportsRenderer() { return true }, supportsComposition() { return true } },
    rights: {
      async findCurrentForArtifacts() {
        return new Map([['artifact-worker-source', currentRights]])
      },
    },
    authorizations: { async findById() { return authorization } },
    resolverForWorkspace() {
      return {
        async resolve(asset) {
          resolverCalls += 1
          return {
            uri: 'file:///worker/private/materialized-source.mp4',
            sha256: asset.sha256,
            byteSize: asset.byteSize,
          }
        },
      }
    },
    clock: () => workerNow,
  })

  const lease = await materialize({
    workspaceId: 'workspace-1',
    authorizationId: 'materialization-worker-1',
  })
  assert.equal(resolverCalls, 1)
  assert.equal(lease.receipt.assetCount, 1)
  assert.equal(lease.receipt.revalidationHash.length, 64)
  assert.equal(
    lease.getRenderInput().assets[0].uri,
    'file:///worker/private/materialized-source.mp4',
  )
  const serialized = JSON.stringify(lease)
  assert.equal(serialized.includes('file:///'), false)
  assert.equal(serialized.includes('workspaces/1/worker-source.mp4'), false)
  assert.equal(serialized.includes('never-serialize-this'), false)

  workerNow = new Date('2026-07-14T12:06:00.000Z')
  await assert.rejects(
    materialize({
      workspaceId: 'workspace-1',
      authorizationId: 'materialization-worker-1',
    }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_AUTHORIZATION_EXPIRED',
  )
  assert.equal(resolverCalls, 1)
  workerNow = new Date('2026-07-14T12:02:00.000Z')

  currentRights = createAssetRightsSnapshot({
    id: 'rights-worker-source-revised',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-worker-source',
    sequence: 2,
    draft: {
      owner: 'Alpes Digital',
      license: 'Revised terms',
      status: 'approved',
      allowedUses: ['paid-ad'],
      prohibitedUses: [],
      allowedMarkets: ['BR'],
      allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'client-1' },
    createdAt: '2026-07-14T12:01:30.000Z',
  })
  await assert.rejects(
    materialize({
      workspaceId: 'workspace-1',
      authorizationId: 'materialization-worker-1',
    }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_REVALIDATION_FAILED' &&
      error.details.reasonCode === 'ASSET_RIGHTS_SNAPSHOT_CHANGED',
  )
  assert.equal(resolverCalls, 1)
})

test('local artifact resolver streams and verifies bytes inside the configured root', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-artifacts-'))
  const outside = `${root}-outside.mp4`
  context.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { force: true }),
    ])
  })
  const artifactKey = 'workspaces/workspace-1/masters/source.mp4'
  const target = join(root, ...artifactKey.split('/'))
  const bytes = Buffer.from('immutable-render-source')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  const stored = {
    id: 'artifact-local-source',
    workspaceId: 'workspace-1',
    artifactKey,
    sha256,
    byteSize: BigInt(bytes.byteLength),
    mediaType: 'video',
    status: 'available',
  }
  const resolver = new LocalArtifactRenderInputResolver(
    { v2MediaArtifact: { async findFirst() { return stored } } },
    { root, workspaceId: 'workspace-1' },
  )
  const asset = {
    id: 'local-source',
    artifactId: stored.id,
    artifactKey,
    kind: 'video',
    role: 'primary',
    ordinal: 0,
    sha256,
    byteSize: bytes.byteLength,
  }
  const resolved = await resolver.resolve(asset)
  assert.match(resolved.uri, /^file:/)
  assert.equal(resolved.sha256, sha256)
  assert.equal(resolved.byteSize, bytes.byteLength)

  const originalArtifactKey = stored.artifactKey
  stored.artifactKey = `../${basename(outside)}`
  await writeFile(outside, bytes)
  await assert.rejects(
    resolver.resolve({ ...asset, artifactKey: stored.artifactKey }),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_REVALIDATION_FAILED' &&
      error.details.reasonCode === 'ASSET_PATH_OUTSIDE_STORAGE_ROOT',
  )
  stored.artifactKey = originalArtifactKey

  await writeFile(target, Buffer.from('tampered-render-source!'))
  await assert.rejects(
    resolver.resolve(asset),
    (error) =>
      error instanceof DomainError &&
      error.code === 'MATERIALIZATION_REVALIDATION_FAILED' &&
      ['ASSET_BYTE_SIZE_MISMATCH', 'ASSET_CONTENT_MISMATCH'].includes(error.details.reasonCode),
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

test('stale commands auto-rebase only across complete non-overlapping history', () => {
  const baseVersion = createProjectVersion({
    id: 'version-rebase-1', workspaceId: 'workspace-1', projectId: 'project-1',
    sequence: 1, snapshotRefs: { editPlan: 'edit-plan-1', policies: 'policy-1' },
    baseHash: 'hash-rebase-1', createdBy: 'user-1', createdAt: '2026-07-12T12:00:00.000Z',
  })
  const currentVersion = createProjectVersion({
    id: 'version-rebase-3', workspaceId: 'workspace-1', projectId: 'project-1',
    sequence: 3, parentVersionId: 'version-rebase-2',
    snapshotRefs: { editPlan: 'edit-plan-3', policies: 'policy-1' },
    baseHash: 'hash-rebase-3', createdBy: 'user-2', createdAt: '2026-07-12T12:02:00.000Z',
  })
  const command = createEditCommand({
    id: 'command-rebase', workspaceId: 'workspace-1', projectId: 'project-1',
    baseVersionId: baseVersion.id, baseHash: baseVersion.baseHash,
    author: { type: 'api-client', id: 'client-1' }, type: 'TrimClip',
    scope: { clipIds: ['clip-1'], frameRange: { startFrame: 10, endFrame: 20 } },
    payload: { endFrame: 18 }, idempotencyKey: 'request-rebase',
    createdAt: '2026-07-12T12:03:00.000Z',
  })
  const interveningEdits = [
    {
      versionId: 'version-rebase-2', parentVersionId: baseVersion.id,
      sequence: 2, commandId: 'command-other-1',
      scope: { clipIds: ['clip-2'] },
      changes: [{ category: 'visual', target: 'clip:clip-2', summary: 'Crop adjusted.' }],
      invalidatedArtifacts: ['artifact-proxy-2'], estimatedCostDelta: 0.25,
    },
    {
      versionId: currentVersion.id, parentVersionId: 'version-rebase-2',
      sequence: 3, commandId: 'command-other-2',
      scope: { clipIds: ['clip-3'] },
      changes: [{ category: 'audio', target: 'clip:clip-3', summary: 'Gain adjusted.' }],
      invalidatedArtifacts: ['artifact-proxy-3'], estimatedCostDelta: -0.05,
    },
  ]
  const resolution = resolveEditCommandConcurrency({
    command, baseVersion, currentVersion, interveningEdits,
  })
  assert.equal(resolution.status, 'auto-rebase')
  assert.equal(resolution.command.baseVersionId, currentVersion.id)
  assert.equal(resolution.command.baseHash, currentVersion.baseHash)
  assert.equal(resolution.previousBaseVersionId, baseVersion.id)
  assert.deepEqual(resolution.diff.commands, ['command-other-1', 'command-other-2'])
  assert.deepEqual(resolution.diff.invalidatedArtifacts, ['artifact-proxy-2', 'artifact-proxy-3'])
  assert.equal(resolution.diff.estimatedCostDelta, 0.2)
  assert.equal(requireResolvedEditCommand(resolution), resolution.command)
  assert.ok(Object.isFrozen(resolution.diff))

  assert.throws(
    () => resolveEditCommandConcurrency({
      command, baseVersion, currentVersion, interveningEdits: interveningEdits.slice(1),
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => resolveEditCommandConcurrency({
      command,
      baseVersion,
      currentVersion,
      interveningEdits: [
        { ...interveningEdits[0], parentVersionId: 'unrelated-version' },
        interveningEdits[1],
      ],
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('overlapping stale commands return semantic targets and bounded diff', () => {
  const baseVersion = createProjectVersion({
    id: 'version-conflict-1', workspaceId: 'workspace-1', projectId: 'project-1',
    sequence: 1, snapshotRefs: { editPlan: 'edit-plan-1', policies: 'policy-1' },
    baseHash: 'hash-conflict-1', createdBy: 'user-1', createdAt: '2026-07-12T12:00:00.000Z',
  })
  const currentVersion = createProjectVersion({
    id: 'version-conflict-2', workspaceId: 'workspace-1', projectId: 'project-1',
    sequence: 2, parentVersionId: baseVersion.id,
    snapshotRefs: { editPlan: 'edit-plan-2', policies: 'policy-1' },
    baseHash: 'hash-conflict-2', createdBy: 'user-2', createdAt: '2026-07-12T12:01:00.000Z',
  })
  const command = createEditCommand({
    id: 'command-conflict', workspaceId: 'workspace-1', projectId: 'project-1',
    baseVersionId: baseVersion.id, baseHash: baseVersion.baseHash,
    author: { type: 'api-client', id: 'client-1' }, type: 'UpdateSubtitleText',
    scope: { trackId: 'subtitle-track', frameRange: { startFrame: 10, endFrame: 20 } },
    payload: { text: 'New text' }, idempotencyKey: 'request-conflict',
    createdAt: '2026-07-12T12:02:00.000Z',
  })
  const resolution = resolveEditCommandConcurrency({
    command, baseVersion, currentVersion,
    interveningEdits: [{
      versionId: currentVersion.id, parentVersionId: baseVersion.id,
      sequence: 2, commandId: 'command-intervening',
      scope: { trackId: 'subtitle-track', frameRange: { startFrame: 15, endFrame: 25 } },
      changes: [{
        category: 'timeline', target: 'track:subtitle-track',
        summary: 'Subtitle timing and text changed.',
      }],
      invalidatedArtifacts: ['artifact-subtitles'], estimatedCostDelta: 0,
    }],
  })
  assert.equal(resolution.status, 'conflict')
  assert.deepEqual(resolution.conflictingTargets, ['frames:15-20', 'track:subtitle-track'])
  assert.equal(resolution.diff.timelineChanges[0].summary, 'Subtitle timing and text changed.')
  assert.throws(
    () => requireResolvedEditCommand(resolution),
    (error) =>
      error instanceof DomainError &&
      error.code === 'VERSION_CONFLICT' &&
      error.details.conflict.currentVersionId === currentVersion.id,
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

test('manifest v4 links a protected portable RenderInput without exposing its props', () => {
  const sourceKey = 'workspaces/ws/masters/source.mov'
  const sourceHash = 'b'.repeat(64)
  const renderInput = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: { id: 'plan-v4', versionId: 'plan-version-v4', hash: '2'.repeat(64) },
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
        id: 'asset-source',
        artifactId: 'artifact-source',
        artifactKey: sourceKey,
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: sourceHash,
        byteSize: 8192,
      },
    ],
    props: { primaryAssetId: 'asset-source', title: 'protected-render-title' },
  })
  const reconstructable = createReconstructableMediaArtifactManifest({
    artifactKey: 'workspaces/ws/artifacts/reconstructable.mp4',
    artifactSha256: 'a'.repeat(64),
    byteSize: 4096,
    mediaType: 'video',
    container: 'mp4',
    recipe: {
      id: 'render-video',
      version: 'v4',
      parameters: { composition: 'apollo-video' },
    },
    sources: [
      {
        artifactKey: sourceKey,
        sha256: sourceHash,
        role: 'primary',
        execution: {
          tool: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
        },
      },
    ],
    renderInput,
  })

  assert.equal(reconstructable.manifest.schemaVersion, 'media-artifact-manifest/v4')
  assert.deepEqual(reconstructable.manifest.renderInput, {
    ref: reconstructable.renderInput.ref,
    inputHash: renderInput.inputHash,
  })
  assert.equal(JSON.stringify(reconstructable.manifest).includes('protected-render-title'), false)
  assert.equal(reconstructable.renderInput.canonicalJson.includes('protected-render-title'), true)
  assert.doesNotThrow(() => assertMediaArtifactManifest(reconstructable.manifest))
  assert.doesNotThrow(() => assertRenderInputPayload(reconstructable.renderInput))

  expectDomainError(
    () =>
      createReconstructableMediaArtifactManifest({
        artifactKey: 'workspaces/ws/artifacts/invalid.mp4',
        artifactSha256: 'c'.repeat(64),
        byteSize: 1,
        mediaType: 'video',
        container: 'mp4',
        recipe: { id: 'render-video', version: 'v4', parameters: {} },
        sources: [
          {
            artifactKey: 'workspaces/ws/masters/missing.mov',
            sha256: 'd'.repeat(64),
            role: 'primary',
            execution: {
              tool: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
            },
          },
        ],
        renderInput,
      }),
    'INVALID_MEDIA_ARTIFACT',
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

test('artifact RenderInput inspection exposes safe metadata but never protected content', async () => {
  const inputHash = 'a'.repeat(64)
  const artifact = {
    id: 'artifact-render-input',
    manifests: [
      {
        id: 'manifest-v4',
        schemaVersion: 'media-artifact-manifest/v4',
        manifestHash: 'b'.repeat(64),
        recipe: { id: 'render-video', version: 'v4', parametersHash: 'c'.repeat(64) },
        renderInput: {
          ref: `render-input/sha256/${inputHash}`,
          inputHash,
          canonicalByteSize: 2048,
          algorithm: 'aes-256-gcm',
        },
        sources: [],
        createdAt: '2026-07-14T11:00:00.000Z',
      },
      {
        id: 'manifest-v3',
        schemaVersion: 'media-artifact-manifest/v3',
        manifestHash: 'd'.repeat(64),
        recipe: { id: 'render-video', version: 'v3', parametersHash: 'e'.repeat(64) },
        sources: [],
        createdAt: '2026-07-14T10:59:00.000Z',
      },
    ],
  }
  const readRenderInput = readMediaArtifactRenderInputService({
    repository: { async findById() { return artifact } },
  })

  const available = await readRenderInput('workspace-1', artifact.id, 'manifest-v4')
  assert.equal(available.available, true)
  assert.deepEqual(available.renderInput, {
    ref: `render-input/sha256/${inputHash}`,
    inputHash,
    canonicalByteSize: 2048,
    protection: { algorithm: 'aes-256-gcm' },
  })
  assert.equal(JSON.stringify(available).includes('canonicalJson'), false)
  assert.equal(JSON.stringify(available).includes('ciphertext'), false)
  assert.equal(JSON.stringify(available).includes('keyId'), false)

  const legacy = await readRenderInput('workspace-1', artifact.id, 'manifest-v3')
  assert.equal(legacy.available, false)
  assert.equal('renderInput' in legacy, false)
  assert.deepEqual(legacy.issues.map((issue) => issue.code), ['RENDER_INPUT_MISSING'])
})

test('artifact reconstruction preflight authenticates input and fails closed before rights or materialization', async () => {
  const input = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: { id: 'plan-preflight', versionId: 'plan-version-preflight', hash: '2'.repeat(64) },
    output: {
      id: 'preset-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      durationInFrames: 90,
    },
    assets: [
      {
        id: 'private-logical-asset-id',
        artifactId: 'artifact-source',
        artifactKey: 'workspaces/1/private/source.mp4',
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: '3'.repeat(64),
        byteSize: 1024,
      },
    ],
    props: { title: 'protected-preflight-title' },
  })
  const artifact = {
    id: 'artifact-reconstructable',
    manifests: [
      {
        id: 'manifest-v4',
        schemaVersion: 'media-artifact-manifest/v4',
        manifestHash: '4'.repeat(64),
        recipe: { id: 'render-video', version: 'v4', parametersHash: '5'.repeat(64) },
        renderInput: {
          ref: `render-input/sha256/${input.inputHash}`,
          inputHash: input.inputHash,
          canonicalByteSize: 1024,
          algorithm: 'aes-256-gcm',
        },
        sources: [],
        createdAt: '2026-07-14T11:30:00.000Z',
      },
      {
        id: 'manifest-legacy',
        schemaVersion: 'media-artifact-manifest/v3',
        manifestHash: '6'.repeat(64),
        recipe: { id: 'render-video', version: 'v3', parametersHash: '7'.repeat(64) },
        sources: [],
        createdAt: '2026-07-14T11:29:00.000Z',
      },
    ],
  }
  let protectedReads = 0
  const createPreflight = (assetAvailability, targets) =>
    preflightMediaArtifactReconstructionService({
      repository: { async findById() { return artifact } },
      protectedRenderInputs: {
        async read(workspaceId, ref, inputHash) {
          protectedReads += 1
          assert.equal(workspaceId, 'workspace-1')
          assert.equal(ref, `render-input/sha256/${input.inputHash}`)
          assert.equal(inputHash, input.inputHash)
          return input
        },
      },
      assetAvailability,
      targets,
    })

  const configuredTargets = createConfiguredRenderTargetRegistry({
    APOLLO_RENDERER_DIGEST: '1'.repeat(64),
  })
  const eligible = await createPreflight(
    { async inspect() { return { available: true } } },
    configuredTargets,
  )('workspace-1', artifact.id, 'manifest-v4')
  assert.equal(eligible.payloadAuthenticated, true)
  assert.equal(eligible.eligible, true)
  assert.equal(eligible.rightsValidationRequired, true)
  assert.equal(eligible.materializationRequired, true)
  assert.deepEqual(eligible.assets, { total: 1, available: 1 })
  assert.deepEqual(eligible.issues, [])
  assert.equal(JSON.stringify(eligible).includes('protected-preflight-title'), false)
  assert.equal(JSON.stringify(eligible).includes('private-logical-asset-id'), false)
  assert.equal(JSON.stringify(eligible).includes('workspaces/1/private'), false)

  const blocked = await createPreflight(
    { async inspect() { return { available: false, code: 'ASSET_UNAVAILABLE' } } },
    { supportsRenderer() { return false }, supportsComposition() { return false } },
  )('workspace-1', artifact.id, 'manifest-v4')
  assert.equal(blocked.eligible, false)
  assert.deepEqual(blocked.issues.map((issue) => issue.code), [
    'RENDERER_UNAVAILABLE',
    'COMPOSITION_UNAVAILABLE',
    'ASSET_UNAVAILABLE',
  ])
  assert.deepEqual(blocked.issues[2], {
    code: 'ASSET_UNAVAILABLE',
    message: 'A required render asset is not available with its immutable identity',
    assetOrdinal: 0,
    assetKind: 'video',
  })

  const legacy = await createPreflight(
    { async inspect() { throw new Error('must not inspect legacy assets') } },
    configuredTargets,
  )('workspace-1', artifact.id, 'manifest-legacy')
  assert.equal(legacy.payloadAuthenticated, false)
  assert.equal(legacy.eligible, false)
  assert.deepEqual(legacy.issues.map((issue) => issue.code), ['RENDER_INPUT_MISSING'])
  assert.equal(protectedReads, 2)
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
