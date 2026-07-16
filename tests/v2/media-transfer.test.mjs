import assert from 'node:assert/strict'
import test from 'node:test'

import { beginMediaUploadService } from '../../src/v2/application/begin-media-upload.ts'
import { issueMediaUploadSessionService } from '../../src/v2/application/issue-media-upload-session.ts'
import { HmacMediaUploadSessionSigner } from '../../src/v2/infrastructure/security/media-upload-session-signer.ts'

function repository() {
  const records = new Map()
  return {
    records,
    async createOrReplayUpload(record) {
      const key = `${record.upload.workspaceId}:${record.upload.clientId}:${record.idempotencyKey}`
      const existing = records.get(key)
      if (existing) {
        if (existing.requestFingerprint !== record.requestFingerprint) {
          const error = new Error('mismatch'); error.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH'; throw error
        }
        return { upload: existing.upload, replayed: true }
      }
      records.set(key, record)
      return { upload: record.upload, replayed: false }
    },
  }
}

test('begin-upload validates intent, persists a bounded session and replays identical requests', async () => {
  const store = repository()
  const begin = beginMediaUploadService({
    repository: store,
    clock: () => new Date('2026-07-16T22:15:00.000Z'),
    createId: () => '123e4567-e89b-42d3-a456-426614174111',
  })
  const request = {
    workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', idempotencyKey: 'upload-intent-001',
    kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64),
  }
  const created = await begin(request)
  const replay = await begin(request)
  assert.equal(created.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(created.upload.status, 'pending-session')
  assert.equal(created.upload.expiresAt, '2026-07-16T22:30:00.000Z')
  assert.equal(store.records.size, 1)
})

test('begin-upload rejects kind/MIME mismatch, unsafe size and malformed checksum', async () => {
  const begin = beginMediaUploadService({ repository: repository() })
  const base = {
    workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', idempotencyKey: 'upload-intent-002',
    kind: 'video', size: '10', mimeType: 'video/mp4', checksum: 'b'.repeat(64),
  }
  await assert.rejects(() => begin({ ...base, mimeType: 'audio/mpeg' }), /MIME does not match/)
  await assert.rejects(() => begin({ ...base, size: '0' }), /size must be a positive/)
  await assert.rejects(() => begin({ ...base, checksum: 'not-a-sha' }), /checksum must be lowercase/)
})

test('signed upload sessions choose single or multipart and bind mandatory headers', async () => {
  const uploads = new Map([
    ['single', { id: 'single', workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', kind: 'video', byteSize: '1048576', mimeType: 'video/mp4', expectedSha256: 'a'.repeat(64), status: 'pending-session', createdAt: '2026-07-16T22:00:00.000Z', expiresAt: '2026-07-16T22:30:00.000Z' }],
    ['multi', { id: 'multi', workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', kind: 'video', byteSize: String(200 * 1024 * 1024), mimeType: 'video/mp4', expectedSha256: 'b'.repeat(64), status: 'pending-session', createdAt: '2026-07-16T22:00:00.000Z', expiresAt: '2026-07-16T22:30:00.000Z' }],
  ])
  const repository = {
    async findUpload({ uploadId }) { return uploads.get(uploadId) },
    async markSessionIssued(input) {
      const value = { ...uploads.get(input.uploadId), status: 'uploading', sessionMode: input.mode, partSize: input.partSize, sessionExpiresAt: input.sessionExpiresAt }
      uploads.set(input.uploadId, value); return value
    },
  }
  const signer = new HmacMediaUploadSessionSigner({ baseUrl: 'https://uploads.example.com/', secret: 's'.repeat(32) })
  const issue = issueMediaUploadSessionService({ repository, signer, clock: () => new Date('2026-07-16T22:10:00.000Z') })
  const single = await issue({ workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', uploadId: 'single' })
  const multi = await issue({ workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', uploadId: 'multi' })
  assert.equal(single.session.mode, 'single')
  assert.match(single.session.uploadUrl, /^https:\/\/uploads\.example\.com\//)
  assert.equal(single.session.requiredHeaders['x-apollo-content-sha256'], 'a'.repeat(64))
  assert.equal(multi.session.mode, 'multipart')
  assert.equal(multi.session.partSize, String(64 * 1024 * 1024))
  assert.equal(multi.session.maxParts, 4)
  assert.match(multi.session.partUrlTemplate, /partNumber=\{partNumber\}/)
  assert.equal(JSON.stringify({ single, multi }).includes('ssssssss'), false)
})
