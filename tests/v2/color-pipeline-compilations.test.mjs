import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createColorPipelineCompilationService,
  readColorPipelineCompilationService,
} from '../../src/v2/application/color-pipeline-compilations.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { PrismaColorPipelineCompilationRepository } from '../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts'
import { parseCreateColorPipelineCompilationBody } from '../../src/v2/public-api/color-pipeline-compilation-contract.ts'
import { resolveRenderColorPipelineBindings } from '../../src/v2/application/resolve-render-color-pipelines.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'

const source = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709',
  matrix: 'bt709', range: 'limited', bitDepth: 10,
})
const output = Object.freeze({ ...source, bitDepth: 8 })
const implementation = (provider, parameters) => Object.freeze({
  provider,
  version: 'v1',
  parameters: Object.freeze(parameters),
  parametersHash: calculateCanonicalHash(parameters),
})
const requestedStages = Object.freeze([
  { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, output: source, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
  { id: 'match-source', kind: 'match', version: 'v1', enabled: false, output: source, implementation: implementation('apollo-match', { mode: 'bypass' }) },
  { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, output: source, implementation: implementation('apollo-lut', { mode: 'none' }) },
  { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, output, implementation: implementation('ffmpeg-zscale', { dither: true }) },
])
const probe = createMediaColorProbe({
  id: 'probe-trusted-1',
  workspaceId: 'workspace-color-1',
  artifactId: 'artifact-color-1',
  manifestId: 'manifest-color-1',
  detection: { state: 'ready', metadata: source, pixelFormat: 'yuv420p10le', hdrMode: 'sdr' },
  producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
  createdAt: '2026-07-31T03:00:00.000Z',
})

function authenticatedActor() {
  const clientId = 'client-color-1'
  const credentialId = 'credential-color-1'
  const auditContext = createExternalAuditContext({ clientId, credentialId, workspaceId: probe.workspaceId, environment: 'production' })
  return Object.freeze({
    clientId, credentialId, workspaceId: probe.workspaceId, environment: 'production',
    scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function request(overrides = {}) {
  return {
    workspaceId: probe.workspaceId,
    projectId: 'project-color-1',
    sourceArtifactId: probe.artifactId,
    sourceManifestId: probe.manifestId,
    outputMetadata: output,
    stages: requestedStages,
    actor: authenticatedActor(),
    idempotencyKey: 'color-pipeline-request-1',
    ...overrides,
  }
}

test('T-FR-180 compiles from trusted probe and never accepts caller source metadata', async () => {
  let persisted
  const repository = {
    async findIdempotent() { return persisted ?? null },
    async loadTrustedProbe() { return probe },
    async persist(value) {
      persisted = value
      return { value, replayed: false }
    },
    async read() { return persisted },
  }
  const created = await createColorPipelineCompilationService({
    repository,
    createId: () => 'color-pipeline-1',
    clock: () => new Date('2026-07-31T03:01:00.000Z'),
  })(request())
  assert.equal(created.value.compilation.colorProbeHash, probe.probeHash)
  assert.deepEqual(created.value.compilation.pipeline.sourceMetadata, source)
  assert.deepEqual(
    created.value.compilation.pipeline.stages.map((stage) => stage.kind),
    ['technical', 'match', 'creative-lut', 'output'],
  )
  assert.deepEqual(
    created.value.compilation.pipeline.stages.map((stage) => stage.input),
    [source, source, source, source],
  )
  assert.deepEqual(
    await readColorPipelineCompilationService({ repository })({
      workspaceId: probe.workspaceId,
      projectId: 'project-color-1',
      compilationId: 'color-pipeline-1',
    }),
    created.value,
  )
  const service = createColorPipelineCompilationService({
    repository,
    createId: () => 'must-not-run-on-replay',
  })
  assert.equal((await service(request())).replayed, true)
  await assert.rejects(
    service(request({ outputMetadata: source })),
    /another color pipeline request/,
  )
  assert.throws(
    () => parseCreateColorPipelineCompilationBody({
      sourceArtifactId: probe.artifactId,
      sourceManifestId: probe.manifestId,
      sourceMetadata: source,
      outputMetadata: output,
      stages: requestedStages,
    }),
    /unknown fields/,
  )
})

test('T-FR-180 rejects unavailable probes before persistence', async () => {
  let writes = 0
  const unavailable = createMediaColorProbe({
    ...probe,
    id: 'probe-unavailable-1',
    detection: { state: 'unavailable', reasons: ['missing-transfer'] },
  })
  await assert.rejects(
    createColorPipelineCompilationService({
      repository: {
        async findIdempotent() { return null },
        async loadTrustedProbe() { return unavailable },
        async persist() { writes += 1 },
        async read() { return null },
      },
      createId: () => 'color-pipeline-2',
    })(request({ idempotencyKey: 'color-pipeline-request-2' })),
    /colorimetry is unavailable/,
  )
  assert.equal(writes, 0)
})

test('T-FR-180 render binding requires exactly one immutable compilation per video source', async () => {
  const compilation = (await createColorPipelineCompilationService({
    repository: {
      async findIdempotent() { return null }, async loadTrustedProbe() { return probe },
      async persist(value) { return { value, replayed: false } },
    },
    createId: () => 'color-pipeline-render-binding',
    clock: () => new Date('2026-07-31T03:02:00.000Z'),
  })(request())).value.compilation
  const sources = [{
    artifactId: probe.artifactId, manifestId: probe.manifestId,
    artifactKey: 'workspaces/color/source.mp4', sha256: '8'.repeat(64), byteSize: 100,
    mediaType: 'video', container: 'mp4', role: 'source-master',
  }]
  const exact = await resolveRenderColorPipelineBindings({
    repository: { async listForSource() { return [{ compilation }] } },
    workspaceId: probe.workspaceId, projectId: 'project-color-1', sources,
  })
  assert.deepEqual(exact, [{
    sourceArtifactId: probe.artifactId, sourceManifestId: probe.manifestId,
    compilationId: compilation.id, compilationHash: compilation.compilationHash,
    pipelineHash: compilation.pipeline.pipelineHash,
  }])
  for (const candidates of [[], [{ compilation }, { compilation }]]) {
    await assert.rejects(resolveRenderColorPipelineBindings({
      repository: { async listForSource() { return candidates } },
      workspaceId: probe.workspaceId, projectId: 'project-color-1', sources,
    }), /exact color pipeline|ambiguous color pipeline/)
  }
})

test('T-FR-180 Prisma adapter persists transform versions and detects tampering', async () => {
  const probeRow = {
    id: probe.id,
    workspaceId: probe.workspaceId,
    artifactId: probe.artifactId,
    manifestId: probe.manifestId,
    schemaVersion: probe.schemaVersion,
    state: 'ready',
    metadataJson: stableSerialize(source),
    pixelFormat: 'yuv420p10le',
    hdrMode: 'sdr',
    reasonsJson: '[]',
    producerProvider: 'ffprobe',
    producerVersion: 'json-v1',
    producerBinaryDigest: '9'.repeat(64),
    createdAt: new Date(probe.createdAt),
    probeHash: probe.probeHash,
  }
  let row
  const client = {
    v2Project: { async findFirst() { return { id: 'project-color-1' } } },
    v2ProjectMediaAsset: { async findFirst() { return { id: 'asset-color-1' } } },
    v2MediaColorProbe: { async findUnique() { return probeRow } },
    v2ColorPipelineCompilation: {
      async findUnique() { return null },
      async create({ data }) {
        row = { ...data, colorProbe: probeRow }
        return row
      },
      async findFirst() { return row },
    },
  }
  const repository = new PrismaColorPipelineCompilationRepository(client)
  assert.equal((await repository.loadTrustedProbe(request())).probeHash, probe.probeHash)
  const created = await createColorPipelineCompilationService({
    repository,
    createId: () => 'color-pipeline-3',
    clock: () => new Date('2026-07-31T03:02:00.000Z'),
  })(request({ idempotencyKey: 'color-pipeline-request-3' }))
  assert.equal(created.replayed, false)
  assert.equal(JSON.parse(row.transformVersionsJson).length, 4)
  assert.deepEqual(
    JSON.parse(row.transformVersionsJson).map((item) => item.kind),
    ['technical', 'match', 'creative-lut', 'output'],
  )
  assert.equal(
    (await repository.read({
      workspaceId: probe.workspaceId,
      projectId: 'project-color-1',
      compilationId: 'color-pipeline-3',
    })).compilation.compilationHash,
    created.value.compilation.compilationHash,
  )
  row = { ...row, pipelineHash: '0'.repeat(64) }
  await assert.rejects(
    repository.read({
      workspaceId: probe.workspaceId,
      projectId: 'project-color-1',
      compilationId: 'color-pipeline-3',
    }),
    /integrity validation/,
  )
})
