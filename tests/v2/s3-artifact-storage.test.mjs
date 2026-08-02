import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import {
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
        if (name === 'GetObjectCommand') return { Body: Readable.from(stored.body) }
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
