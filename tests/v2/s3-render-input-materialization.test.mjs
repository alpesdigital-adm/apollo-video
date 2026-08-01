import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import { materializeRenderInputService } from '../../src/v2/application/materialize-render-input.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { S3ArtifactRenderInputResolver } from '../../src/v2/infrastructure/s3-artifact-render-input-resolver.ts'
import { AwsS3RenderInputObjectClient } from '../../src/v2/infrastructure/s3-render-input-object-client.ts'

async function s3Server(response) {
  const requests = []
  const server = createServer((request, result) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers })
    assert.equal(request.method, 'HEAD')
    assert.match(request.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=APOLLO_TEST_ACCESS\//)
    assert.equal(request.headers['x-amz-checksum-mode'], 'ENABLED')
    result.writeHead(response.status ?? 200, response.headers)
    result.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function objectClient(endpoint) {
  return new AwsS3RenderInputObjectClient({
    endpoint, region: 'us-east-1', bucket: 'apollo-render-test',
    accessKeyId: 'APOLLO_TEST_ACCESS', secretAccessKey: 'apollo-test-secret',
    forcePathStyle: true, signedUrlTtlSeconds: 120,
    clock: () => new Date('2026-07-31T12:00:00.000Z'),
  })
}

test('T-FR-234 S3 adapter verifies full-object identity and signs the exact immutable version', async () => {
  const bytes = Buffer.from('immutable-s3-render-source')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const server = await s3Server({ headers: {
    'content-length': String(bytes.length),
    'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
    'x-amz-version-id': 'version-render-001',
    etag: '"opaque-etag"',
  } })
  try {
    const resolved = await objectClient(server.endpoint).resolve({
      artifactKey: 'workspaces/workspace-1/masters/source.mp4', sha256, byteSize: bytes.length,
      validUntil: '2026-07-31T12:00:17.000Z',
    })
    const uri = new URL(resolved.uri)
    assert.equal(uri.origin, server.endpoint)
    assert.equal(uri.pathname, '/apollo-render-test/workspaces/workspace-1/masters/source.mp4')
    assert.equal(uri.searchParams.get('versionId'), 'version-render-001')
    assert.equal(uri.searchParams.get('X-Amz-Expires'), '17')
    assert.equal(uri.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256')
    assert.match(uri.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/)
    assert.equal(resolved.sha256, sha256)
    assert.equal(resolved.byteSize, bytes.length)
    assert.equal(resolved.uri.includes('apollo-test-secret'), false)
    assert.equal(server.requests.length, 1)
  } finally {
    await server.close()
  }
})

test('T-FR-234 S3 adapter fails closed without exact checksum, byte size and versioning', async () => {
  const bytes = Buffer.from('expected-source')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const cases = [
    { 'content-length': String(bytes.length + 1), 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'), 'x-amz-version-id': 'version-1' },
    { 'content-length': String(bytes.length), 'x-amz-checksum-sha256': Buffer.alloc(32, 9).toString('base64'), 'x-amz-version-id': 'version-1' },
    { 'content-length': String(bytes.length), 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') },
  ]
  for (const headers of cases) {
    const server = await s3Server({ headers })
    try {
      await assert.rejects(
        objectClient(server.endpoint).resolve({
          artifactKey: 'objects/source.mp4', sha256, byteSize: bytes.length,
          validUntil: '2026-07-31T12:05:00.000Z',
        }),
        (error) => error.code === 'MATERIALIZATION_REVALIDATION_FAILED' && error.details.reasonCode === 'ASSET_CONTENT_MISMATCH',
      )
    } finally {
      await server.close()
    }
  }
})

test('T-FR-234 S3 adapter refuses storage access after authorization expiry', async () => {
  const bytes = Buffer.from('expired-source')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const server = await s3Server({ headers: {
    'content-length': String(bytes.length),
    'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
    'x-amz-version-id': 'version-expired',
  } })
  try {
    await assert.rejects(
      objectClient(server.endpoint).resolve({
        artifactKey: 'objects/expired.mp4', sha256, byteSize: bytes.length,
        validUntil: '2026-07-31T12:00:00.000Z',
      }),
      (error) => error.code === 'MATERIALIZATION_AUTHORIZATION_EXPIRED',
    )
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

test('T-FR-234 S3 resolver rechecks media, font and data identity before object storage and delegates LUT only', async () => {
  const sha256 = 'a'.repeat(64)
  const stored = { artifactKey: 'workspaces/1/source.mp4', sha256, byteSize: 123n, mediaType: 'video', status: 'available' }
  let objectCalls = 0
  let delegated = 0
  const resolver = new S3ArtifactRenderInputResolver(
    { v2MediaArtifact: { async findFirst() { return stored } } },
    'workspace-1',
    { async resolve(input) { objectCalls += 1; return { uri: 'https://objects.example/source?signature=opaque', sha256: input.sha256, byteSize: input.byteSize } } },
    { async resolve(asset) { delegated += 1; return { uri: 'file:///work/lut.cube', sha256: asset.sha256, byteSize: asset.byteSize } } },
    '2026-07-31T12:05:00.000Z',
  )
  const asset = { id: 'asset-source', artifactId: 'artifact-source', artifactKey: stored.artifactKey, kind: 'video', role: 'primary', ordinal: 0, sha256, byteSize: 123 }
  assert.match((await resolver.resolve(asset)).uri, /^https:/)
  assert.equal(objectCalls, 1)
  await assert.rejects(resolver.resolve({ ...asset, sha256: 'b'.repeat(64) }), (error) => error.details.reasonCode === 'ASSET_IDENTITY_MISMATCH')
  assert.equal(objectCalls, 1)
  await resolver.resolve({ ...asset, kind: 'lut', artifactKey: 'workspace-luts/lut-1/versions/1/intensity-1.000000-' + sha256 + '.cube' })
  assert.equal(delegated, 1)
  for (const kind of ['font', 'data']) {
    stored.mediaType = kind
    const resolved = await resolver.resolve({ ...asset, kind })
    assert.match(resolved.uri, /^https:/)
  }
  assert.equal(objectCalls, 3)
})

test('T-FR-234 materialized RenderInput allows HTTP only for loopback S3-compatible development', async () => {
  const spec = createRenderInputSpec({
    schemaVersion: 'render-input/v1', renderer: { id: 'remotion', version: '4.0.489', digest: 'c'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: 'plan-s3', versionId: 'plan-version-s3', hash: 'd'.repeat(64) },
    output: { id: 'output-s3', locale: 'pt-BR', aspectRatio: '16:9', width: 1920, height: 1080, fps: 30, safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 30 },
    assets: [{ id: 'source-s3', artifactId: 'artifact-s3', artifactKey: 'objects/source.mp4', kind: 'video', role: 'primary', ordinal: 0, sha256: 'e'.repeat(64), byteSize: 10 }], props: {},
  })
  const resolveAt = (uri) => materializeRenderInputService({ resolver: { async resolve(asset) { return { uri, sha256: asset.sha256, byteSize: asset.byteSize } } } })(spec)
  assert.match((await resolveAt('http://127.0.0.1:9000/bucket/source')).assets[0].uri, /^http:/)
  await assert.rejects(resolveAt('http://objects.example/source'), (error) => error.code === 'INVALID_RENDER_INPUT')
})
