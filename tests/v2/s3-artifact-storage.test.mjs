import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { readArtifactContentService } from '../../src/v2/application/read-artifact-content.ts'
import {
  S3ArtifactContentStorage,
  S3ArtifactSourceMaterializer,
  S3VerifiedMediaStorage,
} from '../../src/v2/infrastructure/media/s3-artifact-storage.ts'

function memoryS3({ versioned = true } = {}) {
  const objects = new Map()
  let version = 0
  return {
    objects,
    client: {
      async send(command) {
        const name = command.constructor.name
        const input = command.input
        if (name === 'PutObjectCommand') {
          const chunks = []
          for await (const chunk of input.Body) chunks.push(Buffer.from(chunk))
          const body = Buffer.concat(chunks)
          const versionId = versioned ? `version-${++version}` : undefined
          objects.set(`${input.Key}:${versionId}`, {
            body, versionId, metadata: input.Metadata, checksum: input.ChecksumSHA256,
          })
          objects.set(input.Key, objects.get(`${input.Key}:${versionId}`))
          return { VersionId: versionId }
        }
        const stored = objects.get(input.VersionId ? `${input.Key}:${input.VersionId}` : input.Key)
        if (!stored) throw new Error('not found')
        if (name === 'HeadObjectCommand') return {
          VersionId: stored.versionId,
          ContentLength: stored.body.length,
          ChecksumSHA256: stored.checksum,
          Metadata: stored.metadata,
        }
        if (name === 'GetObjectCommand') {
          let body = stored.body
          let contentRange
          if (input.Range) {
            const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range)
            if (!match) throw new Error('invalid range')
            const start = Number(match[1])
            const end = Number(match[2])
            body = stored.body.subarray(start, end + 1)
            contentRange = stored.contentRangeOverride ?? `bytes ${start}-${end}/${stored.body.length}`
          }
          return {
            Body: Readable.from(body),
            VersionId: stored.versionId,
            ContentLength: body.length,
            ...(contentRange ? { ContentRange: contentRange } : {}),
          }
        }
        throw new Error(`unexpected ${name}`)
      },
    },
  }
}

test('S3 artifact storage promotes versioned immutable bytes and rematerializes them after local state is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-s3-artifact-'))
  const stagingRoot = join(root, 'staging')
  const workRoot = join(root, 'fresh-worker')
  const sourcePath = join(root, 'source.mp4')
  const bytes = Buffer.from('immutable-video-bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(sourcePath, bytes)
  const s3 = memoryS3()
  const storage = new S3VerifiedMediaStorage(new LocalMediaUploadStorage(stagingRoot), {
    bucket: 'apollo-v2', client: s3.client,
  })
  const promoted = await storage.promoteDerived({
    workspaceId: 'workspace-s3-test', sourcePath, sha256, extension: 'mp4', prefix: 'editorial-proxies',
  })
  assert.match(promoted.key, /^workspaces\/[a-f0-9]{32}\/editorial-proxies\/sha256\//)
  assert.equal(promoted.byteSize, bytes.length)
  await rm(sourcePath)

  const materializer = new S3ArtifactSourceMaterializer(workRoot, { bucket: 'apollo-v2', client: s3.client })
  const resolved = await materializer.materialize({
    operationId: 'operation-reconstruct-s3', artifactKey: promoted.key, sha256, byteSize: bytes.length,
  })
  assert.deepEqual(await readFile(resolved.path), bytes)
  await materializer.cleanup('operation-reconstruct-s3')
  await assert.rejects(stat(resolved.path), /ENOENT/)
})

test('S3 artifact content streams the exact version and byte range through the application port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-s3-content-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'source.mp4')
  const bytes = Buffer.from('version-bound-download-bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(sourcePath, bytes)
  const s3 = memoryS3()
  const promoted = await new S3VerifiedMediaStorage(
    new LocalMediaUploadStorage(join(root, 'staging')),
    { bucket: 'apollo-v2', client: s3.client },
  ).promoteDerived({
    workspaceId: 'workspace-s3-content', sourcePath, sha256,
    extension: 'mp4', prefix: 'masters',
  })
  const artifact = {
    id: 'artifact-s3-content', workspaceId: 'workspace-s3-content',
    artifactKey: promoted.key, sha256, byteSize: BigInt(bytes.length),
    mediaType: 'video', container: 'mp4', status: 'available', manifests: [],
    createdAt: '2026-08-04T20:00:00.000Z',
  }
  const service = readArtifactContentService({
    artifacts: { async findById() { return artifact } },
    storage: new S3ArtifactContentStorage({ bucket: 'apollo-v2', client: s3.client }),
  })
  const full = await service({
    workspaceId: artifact.workspaceId, artifactId: artifact.id, rangeHeader: null,
  })
  assert.deepEqual(Buffer.from(await new Response(full.body).arrayBuffer()), bytes)
  assert.equal(full.partial, false)
  assert.equal(full.etag, `"sha256-${sha256}"`)

  const ranged = await service({
    workspaceId: artifact.workspaceId, artifactId: artifact.id,
    rangeHeader: 'bytes=8-12',
  })
  assert.deepEqual(
    Buffer.from(await new Response(ranged.body).arrayBuffer()),
    bytes.subarray(8, 13),
  )
  assert.deepEqual(
    { start: ranged.start, end: ranged.end, byteSize: ranged.byteSize, total: ranged.totalByteSize },
    { start: 8, end: 12, byteSize: 5, total: bytes.length },
  )

  const stored = s3.objects.get(promoted.key)
  const originalVersionId = stored.versionId
  stored.checksum = Buffer.from('0'.repeat(64), 'hex').toString('base64')
  stored.metadata = { 'apollo-sha256': '0'.repeat(64) }
  await assert.rejects(
    service({ workspaceId: artifact.workspaceId, artifactId: artifact.id, rangeHeader: null }),
    /immutable identity verification/,
  )

  stored.checksum = Buffer.from(sha256, 'hex').toString('base64')
  stored.metadata = { 'apollo-sha256': sha256 }
  stored.versionId = undefined
  await assert.rejects(
    service({ workspaceId: artifact.workspaceId, artifactId: artifact.id, rangeHeader: null }),
    /not version-bound/,
  )

  stored.versionId = originalVersionId
  stored.contentRangeOverride = `bytes 0-4/${bytes.length}`
  await assert.rejects(
    service({
      workspaceId: artifact.workspaceId, artifactId: artifact.id,
      rangeHeader: 'bytes=8-12',
    }),
    /content response is inconsistent/,
  )
})

test('S3 artifact storage fails closed without bucket versioning or with changed immutable bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-s3-artifact-failure-'))
  const sourcePath = join(root, 'source.mp4')
  const bytes = Buffer.from('expected')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(sourcePath, bytes)
  const unversioned = memoryS3({ versioned: false })
  const storage = new S3VerifiedMediaStorage(new LocalMediaUploadStorage(join(root, 'staging')), {
    bucket: 'apollo-v2', client: unversioned.client,
  })
  await assert.rejects(
    storage.promoteDerived({ workspaceId: 'workspace-s3-test', sourcePath, sha256, extension: 'mp4', prefix: 'masters' }),
    /versioning is required/,
  )

  const s3 = memoryS3()
  const validStorage = new S3VerifiedMediaStorage(new LocalMediaUploadStorage(join(root, 'other-staging')), {
    bucket: 'apollo-v2', client: s3.client,
  })
  const promoted = await validStorage.promoteDerived({ workspaceId: 'workspace-s3-test', sourcePath, sha256, extension: 'mp4', prefix: 'masters' })
  const stored = s3.objects.get(promoted.key)
  stored.body = Buffer.from('tampered')
  await assert.rejects(
    new S3ArtifactSourceMaterializer(join(root, 'work'), { bucket: 'apollo-v2', client: s3.client }).materialize({
      operationId: 'operation-tampered', artifactKey: promoted.key, sha256, byteSize: bytes.length,
    }),
    /immutable identity verification|does not match/,
  )
})

test('artifact content composition follows the same configured production driver', async () => {
  const source = await readFile(
    new URL('../../src/v2/infrastructure/repository-factory.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /createArtifactContentStorage[\s\S]*artifactStorageDriver\(environment\)[\s\S]*createLocalArtifactContentStorageFromEnvironment[\s\S]*S3ArtifactContentStorage/,
  )
  assert.match(source, /driver !== 'local' && driver !== 's3'/)
})
