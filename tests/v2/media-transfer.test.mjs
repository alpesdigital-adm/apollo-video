import assert from 'node:assert/strict'
import test from 'node:test'

import { beginMediaUploadService } from '../../src/v2/application/begin-media-upload.ts'

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
