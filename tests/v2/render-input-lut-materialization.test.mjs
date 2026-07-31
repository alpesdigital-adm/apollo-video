import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { authorizeRenderInputMaterializationService } from '../../src/v2/application/authorize-render-input-materialization.ts'
import { materializeAuthorizedRenderInputService } from '../../src/v2/application/materialize-authorized-render-input.ts'
import { createMaterializationAuthorization } from '../../src/v2/domain/materialization-authorization.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { materializeCube3dIntensity, createWorkspaceLutVersion } from '../../src/v2/domain/workspace-lut.ts'
import { LocalArtifactRenderInputResolver } from '../../src/v2/infrastructure/local-artifact-render-input-resolver.ts'
import { PrismaRenderInputAssetAvailability } from '../../src/v2/infrastructure/prisma/render-input-asset-availability.ts'
import { PrismaMaterializationAuthorizationRepository } from '../../src/v2/infrastructure/prisma/materialization-authorization-repository.ts'

const cube = `TITLE "Warm"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
0 0 0.8
0 0.9 0
0 0.9 0.8
1 0 0
1 0 0.8
1 0.9 0
1 0.9 0.8
`

function lut(policy = 'licensed') {
  return createWorkspaceLutVersion({
    id: 'lut-version-render-1', workspaceId: 'workspace-render-1', lutId: 'lut-render-1', version: 1,
    name: 'Warm', owner: 'Apollo', license: { policy, name: 'Internal library' },
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 1,
    cubeContent: cube, preview: { byteSize: 3, sha256: createHash('sha256').update('png').digest('hex') },
    createdByClientId: 'client-render-1', createdAt: '2026-07-31T12:00:00.000Z',
  })
}

function asset(version, intensity = 0.5) {
  const materialized = materializeCube3dIntensity(version.cube.canonicalContent, intensity)
  const sha256 = createHash('sha256').update(materialized.canonicalContent).digest('hex')
  return {
    id: 'asset-lut-render-1', artifactId: version.id,
    artifactKey: `workspace-luts/${version.lutId}/versions/${version.version}/intensity-${intensity.toFixed(6)}-${sha256}.cube`,
    kind: 'lut', role: 'creative-lut', ordinal: 0, sha256,
    byteSize: Buffer.byteLength(materialized.canonicalContent),
  }
}

function repository(version) {
  return { async readVersion(input) {
    return input.workspaceId === version.workspaceId && input.lutId === version.lutId && input.version === version.version ? version : null
  } }
}

function renderInput(lutAsset) {
  return createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: 'a'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: 'plan-lut-render-1', versionId: 'plan-version-lut-render-1', hash: 'b'.repeat(64) },
    output: { id: 'output-lut-render-1', locale: 'pt-BR', aspectRatio: '16:9', width: 1920, height: 1080, fps: 30, safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 30 },
    assets: [lutAsset], props: { projectLutSelectionHash: 'c'.repeat(64) },
  })
}

test('T-FR-234 reconstructs exact immutable LUT bytes into a content-addressed local cache', async () => {
  const version = lut()
  const lutAsset = asset(version)
  const root = await mkdtemp(`${tmpdir()}/apollo-render-lut-`)
  try {
    const resolver = new LocalArtifactRenderInputResolver(
      { v2MediaArtifact: { async findFirst() { throw new Error('media lookup must not run') } } },
      { root, workspaceId: version.workspaceId, luts: repository(version) },
    )
    const results = await Promise.all(Array.from({ length: 6 }, () => resolver.resolve(lutAsset)))
    const resolved = results[0]
    assert.equal(resolved.sha256, lutAsset.sha256)
    assert.equal(resolved.byteSize, lutAsset.byteSize)
    assert.equal(createHash('sha256').update(await readFile(fileURLToPath(resolved.uri))).digest('hex'), lutAsset.sha256)
    assert.match(fileURLToPath(resolved.uri), /\.render-input-cache[\\/]workspace-render-1[\\/]luts/)
    assert.equal(new Set(results.map((item) => item.uri)).size, 1)
    assert.deepEqual(await readdir(fileURLToPath(new URL('.', resolved.uri))), [`${lutAsset.sha256}.cube`])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-234 LUT availability fails closed when the portable identity is tampered', async () => {
  const version = lut()
  const lutAsset = { ...asset(version), byteSize: asset(version).byteSize + 1 }
  const availability = new PrismaRenderInputAssetAvailability(
    { v2MediaArtifact: { async findFirst() { throw new Error('media lookup must not run') } } },
    repository(version),
  )
  assert.deepEqual(await availability.inspect(version.workspaceId, lutAsset), { available: false, code: 'ASSET_IDENTITY_MISMATCH' })
})

test('T-FR-181 materialization authorization permits licensed immutable LUTs and denies restricted LUTs', async () => {
  for (const [policy, expected] of [['licensed', 'authorized'], ['restricted', 'denied']]) {
    const version = lut(policy)
    const input = renderInput(asset(version))
    const authorize = authorizeRenderInputMaterializationService({
      artifactRepository: { async findById() { return { id: 'artifact-output-lut-1', manifests: [{ id: 'manifest-output-lut-1', renderInput: { ref: `render-input/sha256/${input.inputHash}`, inputHash: input.inputHash } }] } } },
      protectedRenderInputs: { async read() { return input } },
      assetAvailability: { async inspect() { return { available: true } } },
      targets: { supportsRenderer() { return true }, supportsComposition() { return true } },
      rights: { async findCurrentForArtifacts(_workspaceId, ids) { assert.deepEqual(ids, []); return new Map() } },
      luts: repository(version),
      authorizations: { async findReplay() { return null }, async createOrReplay(value) { return { authorization: value.authorization, replayed: false } } },
      clock: () => new Date('2026-07-31T12:01:00.000Z'), createId: () => `authorization-${policy}-lut-1`,
    })
    const result = await authorize({ workspaceId: version.workspaceId, artifactId: 'artifact-output-lut-1', manifestId: 'manifest-output-lut-1', use: 'quality-assurance', actor: { type: 'api-client', id: 'client-render-1' }, idempotencyKey: `authorize-${policy}-lut-1` })
    assert.equal(result.authorization.status, expected)
    assert.equal(result.authorization.decisions[0].rightsSnapshotId, version.id)
    assert.equal(result.authorization.decisions[0].rightsSnapshotHash, version.recordHash)
  }
})

test('T-FR-234 authorized worker revalidates LUT policy identity before resolving bytes', async () => {
  const version = lut('licensed')
  const lutAsset = asset(version)
  const input = renderInput(lutAsset)
  const authorization = createMaterializationAuthorization({
    id: 'authorization-worker-lut-1', workspaceId: version.workspaceId,
    artifactId: 'artifact-output-lut-1', manifestId: 'manifest-output-lut-1', inputHash: input.inputHash,
    use: 'quality-assurance', locale: 'pt-BR', syntheticOperations: [], issues: [],
    decisions: [{ artifactId: version.id, assetOrdinal: 0, assetKind: 'lut', outcome: 'allow', reasonCodes: [], rightsSnapshotId: version.id, rightsSnapshotHash: version.recordHash }],
    evaluatedAt: '2026-07-31T12:01:00.000Z', actor: { type: 'api-client', id: 'client-render-1' },
  })
  let resolved = 0
  const materialize = materializeAuthorizedRenderInputService({
    artifacts: { async findById() { return { id: 'artifact-output-lut-1', manifests: [{ id: 'manifest-output-lut-1', renderInput: { ref: `render-input/sha256/${input.inputHash}`, inputHash: input.inputHash } }] } } },
    protectedRenderInputs: { async read() { return input } }, assetAvailability: { async inspect() { return { available: true } } },
    targets: { supportsRenderer() { return true }, supportsComposition() { return true } },
    rights: { async findCurrentForArtifacts(_workspaceId, ids) { assert.deepEqual(ids, []); return new Map() } },
    luts: repository(version), authorizations: { async findById() { return authorization } },
    resolverForWorkspace() { return { async resolve(value) { resolved += 1; return { uri: 'file:///private/cache/lut.cube', sha256: value.sha256, byteSize: value.byteSize } } } },
    clock: () => new Date('2026-07-31T12:02:00.000Z'),
  })
  const lease = await materialize({ workspaceId: version.workspaceId, authorizationId: authorization.id })
  assert.equal(resolved, 1)
  assert.equal(lease.receipt.assetCount, 1)
  assert.equal(lease.getRenderInput().assets[0].kind, 'lut')
  assert.equal(JSON.stringify(lease).includes('file:///'), false)
})

test('T-FR-234 Prisma authorization hydration preserves LUT policy identity without a media-rights FK', async () => {
  const evaluatedAt = new Date('2026-07-31T12:01:00.000Z')
  const validUntil = new Date('2026-07-31T12:06:00.000Z')
  const stored = {
    id: 'authorization-stored-lut-1', workspaceId: 'workspace-render-1', artifactId: 'artifact-output-lut-1',
    manifestId: 'manifest-output-lut-1', inputHash: 'd'.repeat(64), rightsUse: 'quality-assurance', market: null,
    locale: 'pt-BR', syntheticOpsJson: '[]', status: 'authorized', issuesJson: '[]', clientId: 'client-render-1',
    evaluatedAt, validUntil,
    decisions: [{ artifactId: 'lut-version-render-1', assetOrdinal: 0, assetKind: 'lut', rightsSnapshotId: null, rightsSnapshot: null, policySnapshotId: 'lut-version-render-1', policySnapshotHash: 'e'.repeat(64), outcome: 'allow', reasonCodesJson: '[]', validUntil: null }],
  }
  const repository = new PrismaMaterializationAuthorizationRepository({
    v2MaterializationAuthorization: { async findFirst() { return stored } },
  })
  const value = await repository.findById(stored.workspaceId, stored.id)
  assert.equal(value.decisions[0].rightsSnapshotId, 'lut-version-render-1')
  assert.equal(value.decisions[0].rightsSnapshotHash, 'e'.repeat(64))
  assert.equal(value.validUntil, validUntil.toISOString())
})
