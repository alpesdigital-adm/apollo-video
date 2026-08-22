import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { enqueueMediaIngestService } from '../../src/v2/application/enqueue-media-ingest.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { readArtifactContentService } from '../../src/v2/application/read-artifact-content.ts'
import {
  readMediaColorProbeService,
} from '../../src/v2/application/read-media-color-probe.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createMediaUpload } from '../../src/v2/domain/media-transfer.ts'
import {
  createMediaArtifactManifest,
  createMediaArtifactManifestV2,
} from '../../src/v2/domain/media-artifact.ts'
import {
  createMediaColorProbe,
} from '../../src/v2/domain/color-and-export.ts'
import { GroqMediaTranscriber } from '../../src/v2/infrastructure/media/groq-media-transcriber.ts'
import { LocalArtifactContentStorage } from '../../src/v2/infrastructure/media/local-artifact-content-storage.ts'
import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import {
  PrismaProjectMediaRepository,
} from '../../src/v2/infrastructure/prisma/project-media-repository.ts'
import {
  PrismaMediaArtifactRepository,
} from '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const uploadId = '123e4567-e89b-42d3-a456-426614174901'

function verifiedUpload(workspaceId = 'workspace-ingest-1') {
  return createMediaUpload({
    id: uploadId, workspaceId, clientId: 'client-ingest-1', projectId: 'project-ingest-1',
    fileName: 'master.mp4', rightsConfirmed: true, kind: 'video', byteSize: '7', mimeType: 'video/mp4',
    expectedSha256: sha('apollo!'), actualSha256: sha('apollo!'), actualByteSize: '7', status: 'verified',
    createdAt: '2026-07-18T18:00:00.000Z', expiresAt: '2026-07-18T19:00:00.000Z',
    sessionMode: 'multipart', partSize: '4', sessionExpiresAt: '2026-07-18T18:30:00.000Z', verifiedAt: '2026-07-18T18:10:00.000Z',
  })
}

function ingestActor(workspaceId) {
  const auditContext = createExternalAuditContext({
    clientId: 'client-ingest-1', credentialId: `credential-${workspaceId}`,
    workspaceId, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['media:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

test('media ingest identity is stable inside one workspace and isolated between workspaces', async () => {
  const records = []
  const enqueue = enqueueMediaIngestService({
    operations: { async createOrReplay(record) { records.push(record); return { operation: record.operation, context: record.context, authenticationAudit: record.authenticationAudit, replayed: false } } },
    clock: () => new Date('2026-07-18T18:15:00.000Z'), createId: () => 'operation-ingest-test-1',
  })
  const first = await enqueue({ upload: verifiedUpload('workspace-ingest-1'), actor: ingestActor('workspace-ingest-1') })
  const second = await enqueue({ upload: verifiedUpload('workspace-ingest-2'), actor: ingestActor('workspace-ingest-2') })
  const repeatedBytes = await enqueue({ upload: createMediaUpload({
    ...verifiedUpload('workspace-ingest-1'), id: '123e4567-e89b-42d3-a456-426614174902',
  }), actor: ingestActor('workspace-ingest-1') })
  assert.equal(first.operation.type, 'media-ingest')
  assert.equal(first.operation.phase, 'queued')
  assert.notEqual(first.operation.target.id, second.operation.target.id)
  assert.match(first.operation.target.id, /^artifact-[a-f0-9]{12}-[a-f0-9]{64}$/)
  assert.equal(records[0].context.sourceManifestId, `manifest-upload-${sha('workspace-ingest-1').slice(0, 12)}-${sha('apollo!')}`)
  assert.equal(records[2].context.sourceArtifactId, records[0].context.sourceArtifactId)
  assert.equal(records[2].context.sourceManifestId, records[0].context.sourceManifestId)
  assert.equal(repeatedBytes.operation.target.id, first.operation.target.id)
  assert.equal(records[0].idempotencyKey, `media-ingest:${uploadId}`)
})

test('local V2 storage streams multipart bytes, verifies checksum, promotes a master and serves byte ranges', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const storage = new LocalMediaUploadStorage(root)
  const upload = createMediaUpload({ ...verifiedUpload(), status: 'uploading', actualSha256: undefined, actualByteSize: undefined, verifiedAt: undefined })
  const receipts = []
  for (const [partNumber, value] of [[1, 'apol'], [2, 'lo!']]) {
    const receipt = await storage.write({
      upload, mode: 'multipart', partNumber,
      body: new Blob([value]).stream(), contentLength: value.length,
    })
    receipts.push({ uploadId, partNumber, ...receipt, recordedAt: '2026-07-18T18:05:00.000Z' })
  }
  const verification = await storage.verify({ upload, parts: receipts })
  assert.deepEqual(verification, { byteSize: '7', mimeType: 'video/mp4', sha256: sha('apollo!') })
  const promoted = await storage.promoteMaster(verifiedUpload(), receipts)
  assert.equal(promoted.byteSize, 7)

  const artifacts = {
    async findById(workspaceId, artifactId) {
      if (workspaceId !== 'workspace-ingest-1' || artifactId !== 'artifact-ingest-test-1') return null
      return { id: artifactId, workspaceId, artifactKey: promoted.key, sha256: promoted.sha256, byteSize: BigInt(7), mediaType: 'video', container: 'mp4', status: 'available', manifests: [], createdAt: '2026-07-18T18:10:00.000Z' }
    },
  }
  const content = await readArtifactContentService({ artifacts, storage: new LocalArtifactContentStorage(root) })({
    workspaceId: 'workspace-ingest-1', artifactId: 'artifact-ingest-test-1', rangeHeader: 'bytes=1-4',
  })
  assert.equal(content.partial, true)
  assert.equal(content.byteSize, 4)
  assert.equal(content.contentType, 'video/mp4')
  assert.equal(new TextDecoder().decode(await new Response(content.body).arrayBuffer()), 'poll')

  await writeFile(promoted.path, 'tamper!')
  await assert.rejects(
    readArtifactContentService({
      artifacts,
      storage: new LocalArtifactContentStorage(root),
    })({
      workspaceId: 'workspace-ingest-1',
      artifactId: 'artifact-ingest-test-1',
      rangeHeader: null,
    }),
    /immutable identity verification/,
  )

  await storage.discard(uploadId)
  await assert.rejects(() => storage.verifiedSourcePath(upload, receipts), /missing|ENOENT/)
})

test('local artifact checksum verification is shared across HTTP range storage instances', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-content-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'proxy.mp4')
  const bytes = Buffer.from('immutable-preview-bytes')
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path, bytes)
  let calculations = 0
  const calculateSha256 = async () => {
    calculations += 1
    return expectedSha256
  }
  const input = {
    artifactKey: 'proxy.mp4', expectedByteSize: BigInt(bytes.length),
    expectedSha256, range: { start: 0, end: 3 },
  }
  const first = await new LocalArtifactContentStorage(root, { calculateSha256 }).open(input)
  assert.equal((await new Response(first.body).arrayBuffer()).byteLength, 4)
  const second = await new LocalArtifactContentStorage(root, { calculateSha256 }).open(input)
  assert.equal((await new Response(second.body).arrayBuffer()).byteLength, 4)
  assert.equal(calculations, 1)
})

test('artifact content rejects invalid or cross-workspace byte access', async () => {
  const service = readArtifactContentService({
    artifacts: { async findById() { return null } },
    storage: { async open() { throw new Error('must not open') } },
  })
  await assert.rejects(
    () => service({ workspaceId: 'workspace-other-1', artifactId: 'artifact-ingest-test-1', rangeHeader: 'bytes=0-1' }),
    (error) => error.code === 'MEDIA_ARTIFACT_NOT_FOUND',
  )
})

test('provider word and segment intervals may overlap while timeline starts remain ordered', () => {
  const transcript = createMediaTranscript({
    language: 'pt-BR', text: 'uma frase', provider: 'groq', model: 'whisper-large-v3',
    words: [
      { word: 'uma', start: 0, end: 0.62 },
      { word: 'frase', start: 0.48, end: 1.1 },
    ],
    segments: [
      { id: 0, text: 'uma', start: 0, end: 0.7 },
      { id: 1, text: 'frase', start: 0.6, end: 1.1 },
    ],
  })

  assert.equal(transcript.words.length, 2)
  assert.equal(transcript.segments.length, 2)
  assert.throws(() => createMediaTranscript({
    language: 'pt-BR', text: 'fora de ordem', provider: 'groq', model: 'whisper-large-v3',
    words: [{ word: 'fim', start: 1, end: 1.2 }, { word: 'início', start: 0.2, end: 0.5 }],
    segments: [{ id: 0, text: 'fora de ordem', start: 0, end: 1.2 }],
  }), /word alignment is invalid/)
})

test('Groq adapter clamps regressive provider timestamps without changing spoken word order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-transcript-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const audioPath = join(root, 'speech.flac')
  await writeFile(audioPath, new Uint8Array([1, 2, 3]))
  const transcriber = new GroqMediaTranscriber({
    apiKey: 'gsk_test_123456789012345678901234567890', model: 'whisper-large-v3',
    fetchImplementation: async () => Response.json({
      text: 'ordem preservada', language: 'pt',
      words: [
        { word: 'ordem', start: 1, end: 1.3 },
        { word: 'preservada', start: 0.8, end: 1.5 },
      ],
      segments: [
        { id: 0, text: 'ordem', start: 1, end: 1.3, avg_logprob: -0.1 },
        { id: 1, text: 'preservada', start: 0.9, end: 1.5, avg_logprob: -0.2 },
      ],
    }),
  })

  const transcript = await transcriber.transcribe({ audioPath, language: 'pt-BR' })
  assert.deepEqual(transcript.words.map(({ word, start }) => ({ word, start })), [
    { word: 'ordem', start: 1 },
    { word: 'preservada', start: 1 },
  ])
  assert.equal(transcript.segments[1].start, 1)
})

test('completed ingest persists immutable source and proxy color probes atomically and converges replay', async () => {
  const workspaceId = 'workspace-ingest-1'
  const projectId = 'project-ingest-1'
  const sourceArtifactId = 'artifact-source-color'
  const proxyArtifactId = 'artifact-proxy-color'
  const sourceManifestId = 'manifest-source-color'
  const proxyManifestId = 'manifest-proxy-color'
  const createdAt = '2026-07-18T18:00:00.000Z'
  const sourceManifest = createMediaArtifactManifest({
    artifactKey: 'masters/source.mp4',
    artifactSha256: '1'.repeat(64),
    byteSize: 1_000,
    mediaType: 'video',
    container: 'mp4',
    recipe: {
      id: 'direct-upload',
      version: '1.0.0',
      parameters: { mimeType: 'video/mp4' },
    },
  })
  const proxyManifest = createMediaArtifactManifestV2({
    artifactKey: 'editing-proxies/proxy.mp4',
    artifactSha256: '2'.repeat(64),
    byteSize: 500,
    mediaType: 'video',
    container: 'mp4',
    recipe: {
      id: 'editing-proxy',
      version: '1.0.0',
      parameters: { maxWidth: 1280 },
    },
    sources: [{
      artifactKey: sourceManifest.artifact.artifactKey,
      sha256: sourceManifest.artifact.sha256,
      role: 'source-master',
      execution: {
        tool: {
          id: 'ffmpeg',
          version: 'static',
          digest: '3'.repeat(64),
        },
      },
    }],
    probe: { width: 640, height: 360, duration: 1, fps: 25 },
  })
  const detection = {
    state: 'ready',
    metadata: {
      colorSpace: 'rec709',
      transfer: 'bt709',
      primaries: 'bt709',
      matrix: 'bt709',
      range: 'limited',
      bitDepth: 8,
    },
    pixelFormat: 'yuv420p',
    hdrMode: 'sdr',
  }
  const probe = (id, artifactId, manifestId) =>
    createMediaColorProbe({
      id,
      workspaceId,
      artifactId,
      manifestId,
      detection,
      producer: {
        provider: 'ffprobe',
        version: 'json-v1',
        binaryDigest: '4'.repeat(64),
      },
      createdAt,
    })
  const sourceColorProbe = probe(
    'color-probe-source',
    sourceArtifactId,
    sourceManifestId,
  )
  const proxyColorProbe = probe(
    'color-probe-proxy',
    proxyArtifactId,
    proxyManifestId,
  )
  const transcript = createMediaTranscript({
    language: 'pt-BR',
    text: 'teste',
    provider: 'controlled',
    model: 'transcriber-v1',
    words: [{ word: 'teste', start: 0, end: 0.5 }],
    segments: [{ id: 0, text: 'teste', start: 0, end: 0.5 }],
  })
  const colorRows = new Map()
  const snapshotRows = new Map()
  const versionRows = new Map()
  const eventRows = new Map()
  const parentVersionId = 'project-version-ingest-parent'
  const transaction = {
    v2Project: {
      async findFirst() { return { id: projectId, currentVersionId: parentVersionId } },
      async updateMany() { return { count: 1 } },
    },
    v2MediaArtifact: {
      async findFirst({ where }) {
        return [sourceArtifactId, proxyArtifactId].includes(where.id)
          ? { id: where.id }
          : null
      },
    },
    v2MediaArtifactManifest: {
      async findFirst({ where }) {
        if (where.id === sourceManifestId) {
          return {
            id: sourceManifestId,
            manifestHash: sourceManifest.manifestHash,
          }
        }
        if (where.id === proxyManifestId) {
          return {
            id: proxyManifestId,
            manifestHash: proxyManifest.manifestHash,
          }
        }
        return null
      },
    },
    v2MediaUpload: {
      async findFirst() { return { id: uploadId } },
    },
    v2MediaColorProbe: {
      async findUnique({ where }) {
        const key =
          where.workspaceId_artifactId_manifestId.artifactId
        return colorRows.get(key) ?? null
      },
      async create({ data }) {
        colorRows.set(data.artifactId, data)
        return data
      },
    },
    v2ProjectMediaAsset: {
      async upsert() { return {} },
    },
    v2MediaLibraryEntry: {
      async upsert() { return {} },
    },
    v2MediaTranscript: {
      async findUnique() { return null },
      async create() { return {} },
    },
    v2ProjectSnapshot: {
      async findUnique({ where }) { return snapshotRows.get(where.id) ?? null },
      async create({ data }) { snapshotRows.set(data.id, data); return data },
    },
    v2ProjectVersion: {
      async findUnique({ where }) { return versionRows.get(where.id) ?? null },
      async create({ data }) { versionRows.set(data.id, data); return data },
    },
    v2PublicEventOutbox: {
      async findUnique({ where }) { return eventRows.get(where.id) ?? null },
      async create({ data }) { eventRows.set(data.id, data); return data },
    },
  }
  const repository = new PrismaProjectMediaRepository({
    async $transaction(callback) {
      return callback(transaction)
    },
  })
  const input = {
    workspaceId,
    projectId,
    uploadId,
    originalFileName: 'master.mp4',
    sourceArtifactId,
    sourceManifestId,
    proxyArtifactId,
    proxyManifestId,
    transcriptId: 'transcript-color-probe',
    transcript,
    sourceManifest,
    proxyManifest,
    sourceColorProbe,
    proxyColorProbe,
    initialPlan: {
      snapshot: {
        id: 'snapshot-ingest-plan', workspaceId, projectId, kind: 'edit-plan',
        contentSchemaVersion: 2, contentJson: '{}', contentHash: '8'.repeat(64), createdAt,
      },
      version: {
        id: 'version-ingest-plan', workspaceId, projectId, sequence: 2,
        parentVersionId, snapshotRefs: {
          brief: 'snapshot-brief', editPlan: 'snapshot-ingest-plan', policies: 'snapshot-policies',
        },
        baseHash: '9'.repeat(64), createdBy: 'client-ingest', createdAt,
      },
      event: {
        id: '00000000-0000-4000-8000-000000000991',
        type: 'project.version.created', version: '1.0.0', workspaceId,
        occurredAt: createdAt, sequence: 2, actor: { clientId: 'client-ingest' },
        resource: { type: 'project-version', id: 'version-ingest-plan' },
        data: { projectId },
      },
    },
    createdAt,
  }
  await repository.persistCompletedIngest(input)
  await repository.persistCompletedIngest(input)
  assert.equal(colorRows.size, 2)
  assert.equal(snapshotRows.size, 1)
  assert.equal(versionRows.size, 1)
  assert.equal(eventRows.size, 1)
  assert.deepEqual(
    JSON.parse(colorRows.get(sourceArtifactId).metadataJson),
    detection.metadata,
  )
  assert.equal(colorRows.get(proxyArtifactId).state, 'ready')

  const conflictingSourceProbe = createMediaColorProbe({
    ...sourceColorProbe,
    detection: {
      state: 'unavailable',
      pixelFormat: 'yuv420p',
      reasons: ['missing-transfer'],
    },
  })
  await assert.rejects(
    repository.persistCompletedIngest({
      ...input,
      sourceColorProbe: conflictingSourceProbe,
    }),
    /collided with different evidence/,
  )
})

test('T-FR-236 ingest failure fences the exact project transition and rejects stale state', async () => {
  let query
  const repository = new PrismaProjectMediaRepository({
    v2Project: {
      async updateMany(input) {
        query = input
        return { count: 0 }
      },
    },
  })
  await assert.rejects(
    () => repository.markIngestFailed({ workspaceId: 'workspace-ingest-1', projectId: 'project-ingest-1' }),
    (error) => error.code === 'PROJECT_TRANSITION_REJECTED',
  )
  assert.deepEqual(query, {
    where: {
      id: 'project-ingest-1', workspaceId: 'workspace-ingest-1',
      status: { in: ['ingesting', 'failed'] },
    },
    data: { status: 'failed' },
  })
})

test('trusted color probe query rehydrates canonical evidence and remains workspace scoped', async () => {
  const probe = createMediaColorProbe({
    id: 'color-probe-query',
    workspaceId: 'workspace-ingest-1',
    artifactId: 'artifact-color-query',
    manifestId: 'manifest-color-query',
    detection: {
      state: 'ready',
      metadata: {
        colorSpace: 'rec2020',
        transfer: 'smpte2084',
        primaries: 'bt2020',
        matrix: 'bt2020nc',
        range: 'limited',
        bitDepth: 10,
      },
      pixelFormat: 'yuv420p10le',
      hdrMode: 'pq',
    },
    producer: {
      provider: 'ffprobe',
      version: 'json-v1',
      binaryDigest: '5'.repeat(64),
    },
    createdAt: '2026-07-18T18:00:00.000Z',
  })
  const row = {
    id: probe.id,
    workspaceId: probe.workspaceId,
    artifactId: probe.artifactId,
    manifestId: probe.manifestId,
    schemaVersion: probe.schemaVersion,
    state: probe.detection.state,
    metadataJson: JSON.stringify(probe.detection.metadata),
    pixelFormat: probe.detection.pixelFormat,
    hdrMode: probe.detection.hdrMode,
    reasonsJson: '[]',
    producerProvider: probe.producer.provider,
    producerVersion: probe.producer.version,
    producerBinaryDigest: probe.producer.binaryDigest,
    createdAt: new Date(probe.createdAt),
    probeHash: probe.probeHash,
  }
  const adapter = new PrismaMediaArtifactRepository({
    v2MediaColorProbe: {
      async findFirst({ where }) {
        return where.workspaceId === probe.workspaceId &&
          where.artifactId === probe.artifactId
          ? row
          : null
      },
    },
  })
  assert.deepEqual(
    await adapter.findColorProbe(probe.workspaceId, probe.artifactId),
    probe,
  )
  const read = readMediaColorProbeService({
    repository: {
      async findById(workspaceId, artifactId) {
        return workspaceId === probe.workspaceId &&
          artifactId === probe.artifactId
          ? { id: artifactId }
          : null
      },
      async findColorProbe(workspaceId, artifactId) {
        return adapter.findColorProbe(workspaceId, artifactId)
      },
    },
  })
  assert.equal(
    (await read(probe.workspaceId, probe.artifactId)).probeHash,
    probe.probeHash,
  )
  await assert.rejects(
    read('workspace-other', probe.artifactId),
    (error) => error.code === 'MEDIA_ARTIFACT_NOT_FOUND',
  )
  await assert.rejects(
    new PrismaMediaArtifactRepository({
      v2MediaColorProbe: {
        async findFirst() {
          return { ...row, probeHash: '6'.repeat(64) }
        },
      },
    }).findColorProbe(probe.workspaceId, probe.artifactId),
    /integrity validation/,
  )
})
