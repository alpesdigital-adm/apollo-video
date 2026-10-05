import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'

// Actual HTTP routes, signed PUT bytes, local storage and PostgreSQL. The
// transfer payload is controlled bytes; this does not assert successful ingest
// or media perception, and the downloadable artifact metadata is a PG seed.
export async function proveMediaTransferHttp({ baseUrl, client, authorization, workspaceId, projectId, artifactRoot, createMediaArtifactManifest }) {
  const tag = randomUUID().slice(0, 8)
  const uploads = []
  const artifactId = `w51-download-${tag}`
  const evidence = { schemaVersion: 'media-transfer-http-proof/v1', sourceSha: process.env.GITHUB_SHA,
    provenance: { transport: 'real HTTP', persistence: 'real PostgreSQL', storage: 'real local bytes', payload: 'controlled binary', artifactMetadata: 'controlled PG seed', ingest: 'queued only; not executed', s3: 'not exercised' }, cases: [] }
  const call = async (path, body, key) => {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: {
      authorization, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}),
    }, body: JSON.stringify(body ?? {}) })
    const result = await response.json()
    return { status: response.status, result }
  }
  const begin = async (bytes, key) => {
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const body = { projectId, fileName: 'controlled-transfer.mp4', rightsConfirmed: true, kind: 'video', size: String(bytes.length), mimeType: 'video/mp4', checksum }
    const first = await call('/v1/media/uploads', body, key)
    assert.equal(first.status, 201, JSON.stringify(first.result))
    const id = first.result.data.upload.id
    uploads.push(id)
    const replay = await call('/v1/media/uploads', body, key)
    assert.equal(replay.status, 200)
    assert.equal(replay.result.data.upload.id, id)
    assert.equal(replay.result.data.replayed, true)
    return { id, checksum }
  }
  const issue = async (id) => {
    const issued = await call(`/v1/media/uploads/${id}/session`)
    assert.equal(issued.status, 200, JSON.stringify(issued.result))
    return issued.result.data.session
  }
  const send = (session, bytes, partNumber) => fetch(partNumber
    ? session.partUrlTemplate.replace('{partNumber}', String(partNumber)) : session.uploadUrl,
  { method: 'PUT', headers: session.requiredHeaders, body: bytes })
  const refused = async (response) => {
    assert.equal(response.ok, false)
    return { status: response.status, code: (await response.json()).error.code }
  }
  try {
    const bytes = Buffer.alloc(128 * 1024 * 1024, 0x51)
    const intent = await begin(bytes, `w51-large-${tag}`)
    let session = await issue(intent.id)
    assert.equal(session.mode, 'multipart')
    assert.equal(session.maxParts, 2)
    const partSize = Number(session.partSize)
    assert.equal((await send(session, bytes.subarray(0, partSize), 1)).status, 201)
    const inspected = await (await fetch(`${baseUrl}/v1/media/uploads/${intent.id}`, { headers: { authorization } })).json()
    assert.deepEqual(inspected.data.missingPartNumbers, [2])
    const incomplete = await call(`/v1/media/uploads/${intent.id}/complete`)
    assert.equal(incomplete.status, 409)
    assert.equal(await client.v2MediaIngestOperation.count({ where: { workspaceId, uploadId: intent.id } }), 0)
    // A persisted expired session models elapsed wall time without sleeping ten
    // minutes. The signed URL is untouched, and the route must reject its PUT.
    await client.v2MediaUpload.update({ where: { id: intent.id }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } })
    const expired = await refused(await send(session, bytes.subarray(partSize), 2))
    session = await issue(intent.id)
    const corrupt = Buffer.from(bytes.subarray(partSize))
    corrupt[0] ^= 1
    assert.equal((await send(session, corrupt, 2)).status, 201)
    const corrupted = await call(`/v1/media/uploads/${intent.id}/complete`)
    assert.equal(corrupted.status, 409)
    assert.equal(await client.v2MediaIngestOperation.count({ where: { workspaceId, uploadId: intent.id } }), 0)
    assert.equal((await send(session, bytes.subarray(partSize), 2)).status, 201)
    const complete = await call(`/v1/media/uploads/${intent.id}/complete`)
    assert.equal(complete.status, 202, JSON.stringify(complete.result))
    const replay = await call(`/v1/media/uploads/${intent.id}/complete`)
    assert.equal(replay.status, 202)
    assert.equal(replay.result.data.operation.id, complete.result.data.operation.id)
    const stored = await client.v2MediaUpload.findUniqueOrThrow({ where: { id: intent.id } })
    assert.equal(stored.actualSha256, intent.checksum)
    assert.equal(stored.actualByteSize, BigInt(bytes.length))
    const audit = await client.v2MediaUploadAuditEntry.findMany({ where: { uploadId: intent.id } })
    assert.ok(audit.some((entry) => entry.action === 'complete'))
    evidence.cases.push({ id: 'multipart-interruption-expiry-corruption-resume', uploadId: intent.id, operationId: complete.result.data.operation.id, byteSize: bytes.length, sha256: intent.checksum, expired, incomplete: incomplete.result.error.code, corrupted: corrupted.result.error.code, auditActions: audit.map((entry) => entry.action) })

    const small = Buffer.from('w51-real-http-single-bytes')
    const single = await begin(small, `w51-single-${tag}`)
    const singleSession = await issue(single.id)
    assert.equal(singleSession.mode, 'single')
    assert.equal((await send(singleSession, small)).status, 201)
    assert.equal((await call(`/v1/media/uploads/${single.id}/complete`)).status, 202)

    const key = `workspaces/${workspaceId}/w51/${tag}.mp4`
    const path = join(artifactRoot, ...key.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, small)
    const manifest = createMediaArtifactManifest({ artifactKey: key, artifactSha256: single.checksum, byteSize: small.length, mediaType: 'video', container: 'mp4', recipe: { id: 'w51-controlled-transfer', version: '1', parameters: {} }, probe: { width: 16, height: 16, duration: 1, fps: 1 } })
    await client.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey: key, sha256: single.checksum, byteSize: BigInt(small.length), mediaType: 'video', container: 'mp4', status: 'available' } })
    await client.v2MediaArtifactManifest.create({ data: { id: `manifest-${artifactId}`, workspaceId, artifactId, schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash, manifestJson: JSON.stringify(manifest) } })
    const grant = await call(`/v1/artifacts/${artifactId}/download-grants`, { ttlSeconds: 30 }, `w51-grant-${tag}`)
    assert.equal(grant.status, 201, JSON.stringify(grant.result))
    const url = grant.result.data.downloadUrl
    const full = await fetch(url)
    assert.equal(full.status, 200)
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), small)
    const range = await fetch(url, { headers: { range: 'bytes=2-7' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), small.subarray(2, 8))
    const revoke = await call(`/v1/media/download-grants/${grant.result.data.grant.id}/revoke`)
    assert.equal(revoke.status, 200)
    const revokedFull = await refused(await fetch(url))
    const revokedRange = await refused(await fetch(url, { headers: { range: 'bytes=2-7' } }))
    evidence.cases.push({ id: 'single-and-grant-full-range-revocation', uploadId: single.id, artifactId, grantId: grant.result.data.grant.id, byteSize: small.length, sha256: single.checksum, full: 200, range: 206, revokedFull, revokedRange })
    evidence.outcome = 'passed'
    if (process.env.APOLLO_W51_EVIDENCE_ROOT) {
      await mkdir(process.env.APOLLO_W51_EVIDENCE_ROOT, { recursive: true })
      await writeFile(join(process.env.APOLLO_W51_EVIDENCE_ROOT, 'media-transfer-http.json'), JSON.stringify(evidence, null, 2))
    }
    assert.deepEqual(await readFile(path), small)
    return evidence
  } finally {
    await client.v2MediaDownloadGrant.deleteMany({ where: { workspaceId, artifactId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { artifactId } })
    await client.v2MediaArtifact.deleteMany({ where: { id: artifactId } })
    const operations = await client.v2MediaIngestOperation.findMany({ where: { workspaceId, uploadId: { in: uploads } }, select: { operationId: true } })
    const ids = operations.map((operation) => operation.operationId)
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId, resourceId: { in: ids } } })
    await client.v2MediaIngestOperation.deleteMany({ where: { workspaceId, uploadId: { in: uploads } } })
    await client.v2PublicOperation.deleteMany({ where: { id: { in: ids } } })
    await client.v2MediaUpload.deleteMany({ where: { id: { in: uploads } } })
  }
}
