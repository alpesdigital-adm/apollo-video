import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { enqueueMediaIngestService } from '../../src/v2/application/enqueue-media-ingest.ts'
import { readArtifactContentService } from '../../src/v2/application/read-artifact-content.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createMediaUpload } from '../../src/v2/domain/media-transfer.ts'
import { GroqMediaTranscriber } from '../../src/v2/infrastructure/media/groq-media-transcriber.ts'
import { LocalArtifactContentStorage } from '../../src/v2/infrastructure/media/local-artifact-content-storage.ts'
import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'

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

test('media ingest identity is stable inside one workspace and isolated between workspaces', async () => {
  const records = []
  const enqueue = enqueueMediaIngestService({
    operations: { async createOrReplay(record) { records.push(record); return { operation: record.operation, context: record.context, replayed: false } } },
    clock: () => new Date('2026-07-18T18:15:00.000Z'), createId: () => 'operation-ingest-test-1',
  })
  const first = await enqueue({ upload: verifiedUpload('workspace-ingest-1') })
  const second = await enqueue({ upload: verifiedUpload('workspace-ingest-2') })
  const repeatedBytes = await enqueue({ upload: createMediaUpload({
    ...verifiedUpload('workspace-ingest-1'), id: '123e4567-e89b-42d3-a456-426614174902',
  }) })
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

  await storage.discard(uploadId)
  await assert.rejects(() => storage.verifiedSourcePath(upload, receipts), /missing|ENOENT/)
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
