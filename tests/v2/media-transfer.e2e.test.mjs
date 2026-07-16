import assert from 'node:assert/strict'
import test from 'node:test'

import { beginMediaUploadService } from '../../src/v2/application/begin-media-upload.ts'
import { issueMediaUploadSessionService } from '../../src/v2/application/issue-media-upload-session.ts'
import { completeMediaUploadService, inspectMediaUploadService, recordMediaUploadPartService } from '../../src/v2/application/manage-media-upload.ts'
import { authorizeMediaDownloadGrantService, issueMediaDownloadGrantService, revokeMediaDownloadGrantService } from '../../src/v2/application/manage-media-download-grant.ts'
import { HmacMediaDownloadGrantSigner } from '../../src/v2/infrastructure/security/media-download-grant-signer.ts'
import { HmacMediaUploadSessionSigner } from '../../src/v2/infrastructure/security/media-upload-session-signer.ts'

function transferRepository() {
  let upload
  const parts = new Map()
  return {
    async createOrReplayUpload(record) { upload = record.upload; return { upload, replayed: false } },
    async findUpload({ uploadId }) { return upload?.id === uploadId ? upload : undefined },
    async markSessionIssued(input) { upload = { ...upload, status: 'uploading', sessionMode: input.mode, partSize: input.partSize, sessionExpiresAt: input.sessionExpiresAt }; return upload },
    async listUploadParts() { return [...parts.values()].sort((a, b) => a.partNumber - b.partNumber) },
    async recordUploadPart({ part }) { parts.set(part.partNumber, part); return part },
    async markUploadVerified(input) { upload = { ...upload, status: 'verified', actualByteSize: input.actualByteSize, actualSha256: input.actualSha256, verifiedAt: input.verifiedAt }; return upload },
  }
}

function grantRepository() {
  const records = new Map()
  return {
    async createOrReplay(grant) { records.set(grant.id, grant); return { grant, replayed: false } },
    async find({ workspaceId, clientId, grantId }) { const grant = records.get(grantId); return grant?.workspaceId === workspaceId && grant?.clientId === clientId ? grant : undefined },
    async revoke({ grantId, revokedAt }) { const grant = { ...records.get(grantId), status: 'revoked', revokedAt }; records.set(grantId, grant); return grant },
  }
}

test('large media survives interruption, rejects corruption and revoked download end to end', async () => {
  let now = new Date('2026-07-16T23:10:00.000Z')
  const clock = () => now
  const actor = { workspaceId: 'workspace-e2e-1', clientId: 'client-e2e-1' }
  const checksum = 'a'.repeat(64)
  const byteSize = String(256 * 1024 * 1024)
  const uploads = transferRepository()
  const begin = beginMediaUploadService({ repository: uploads, clock, createId: () => '123e4567-e89b-42d3-a456-426614174401', sessionTtlMs: 30 * 60_000 })
  const begun = await begin({ ...actor, idempotencyKey: 'large-upload-e2e-001', kind: 'video', size: byteSize, mimeType: 'video/mp4', checksum })

  const issue = issueMediaUploadSessionService({ repository: uploads, signer: new HmacMediaUploadSessionSigner({ baseUrl: 'https://uploads.example.com/', secret: 'u'.repeat(32) }), clock, signedTtlMs: 2 * 60_000 })
  const firstSession = await issue({ ...actor, uploadId: begun.upload.id })
  assert.equal(firstSession.session.mode, 'multipart')
  assert.equal(firstSession.session.maxParts, 4)

  const record = recordMediaUploadPartService({ repository: uploads, clock })
  for (const partNumber of [1, 2]) await record({ ...actor, uploadId: begun.upload.id, partNumber, byteSize: firstSession.session.partSize, etag: `"largepart0${partNumber}"`, checksum: 'b'.repeat(64) })
  assert.deepEqual((await inspectMediaUploadService({ repository: uploads })({ ...actor, uploadId: begun.upload.id })).missingPartNumbers, [3, 4])

  now = new Date('2026-07-16T23:13:00.000Z')
  await assert.rejects(() => record({ ...actor, uploadId: begun.upload.id, partNumber: 3, byteSize: firstSession.session.partSize, etag: '"largepart03"', checksum: 'b'.repeat(64) }), /expired/)
  await issue({ ...actor, uploadId: begun.upload.id })
  for (const partNumber of [3, 4]) await record({ ...actor, uploadId: begun.upload.id, partNumber, byteSize: firstSession.session.partSize, etag: `"largepart0${partNumber}"`, checksum: 'b'.repeat(64) })

  const corrupted = completeMediaUploadService({ repository: uploads, verifier: { async verify() { return { byteSize, mimeType: 'video/mp4', sha256: 'f'.repeat(64) } } }, clock })
  await assert.rejects(() => corrupted({ ...actor, uploadId: begun.upload.id }), /checksum/)
  const complete = completeMediaUploadService({ repository: uploads, verifier: { async verify() { return { byteSize, mimeType: 'video/mp4', sha256: checksum } } }, clock })
  const completed = await complete({ ...actor, uploadId: begun.upload.id })
  assert.equal(completed.upload.status, 'verified')

  const grants = grantRepository()
  const issueDownload = issueMediaDownloadGrantService({
    artifacts: { async findById() { return { id: 'artifact-from-large-upload', status: 'available' } } }, grants,
    signer: new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 'd'.repeat(32) }), clock,
    createId: () => '123e4567-e89b-42d3-a456-426614174402',
  })
  const download = await issueDownload({ ...actor, artifactId: 'artifact-from-large-upload', idempotencyKey: 'large-download-e2e-001' })
  const token = new URL(download.downloadUrl).searchParams.get('token')
  const authorize = authorizeMediaDownloadGrantService({ grants, clock })
  assert.equal((await authorize({ ...actor, grantId: download.grant.id, token })).artifactId, 'artifact-from-large-upload')
  await revokeMediaDownloadGrantService({ grants, clock })({ ...actor, grantId: download.grant.id })
  await assert.rejects(() => authorize({ ...actor, grantId: download.grant.id, token }), /inactive/)
})
