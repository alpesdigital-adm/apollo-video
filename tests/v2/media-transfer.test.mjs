import assert from 'node:assert/strict'
import test from 'node:test'

import { beginMediaUploadService } from '../../src/v2/application/begin-media-upload.ts'
import { issueMediaUploadSessionService } from '../../src/v2/application/issue-media-upload-session.ts'
import { abortMediaUploadService, completeMediaUploadService, inspectMediaUploadService, recordMediaUploadPartService } from '../../src/v2/application/manage-media-upload.ts'
import { HmacMediaUploadSessionSigner } from '../../src/v2/infrastructure/security/media-upload-session-signer.ts'
import { HttpMediaUploadVerifier } from '../../src/v2/infrastructure/media-upload-verifier.ts'
import { PrismaMediaTransferRepository } from '../../src/v2/infrastructure/prisma/media-transfer-repository.ts'
import { receiveMediaUploadContentService } from '../../src/v2/application/receive-media-upload-content.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { readSeedArguments } from '../../scripts/seed-v2-project-source.mjs'
import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createMediaUploadAuditEntry } from '../../src/v2/domain/media-upload-audit-entry.ts'

function uploadActor(credentialId = 'credential-upload-1') {
  const auditContext = createExternalAuditContext({
    workspaceId: 'workspace-upload-1', clientId: 'client-upload-1',
    credentialId, environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['media:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

const MEDIA_UPLOAD_ACTOR = uploadActor()

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
    workspaceId: 'workspace-upload-1', actor: MEDIA_UPLOAD_ACTOR, idempotencyKey: 'upload-intent-001',
    kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64),
  }
  const created = await begin(request)
  const replay = await begin(request)
  assert.equal(created.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(created.upload.status, 'pending-session')
  assert.equal(created.upload.expiresAt, '2026-07-16T22:30:00.000Z')
  assert.equal(store.records.size, 1)
  assert.equal([...store.records.values()][0].auditEntry.audit.credentialId, 'credential-upload-1')
  await assert.rejects(
    begin({ ...request, actor: uploadActor('credential-upload-2') }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('begin-upload rejects kind/MIME mismatch, unsafe size and malformed checksum', async () => {
  const begin = beginMediaUploadService({ repository: repository() })
  const base = {
    workspaceId: 'workspace-upload-1', actor: MEDIA_UPLOAD_ACTOR, idempotencyKey: 'upload-intent-002',
    kind: 'video', size: '10', mimeType: 'video/mp4', checksum: 'b'.repeat(64),
  }
  await assert.rejects(() => begin({ ...base, mimeType: 'audio/mpeg' }), /MIME does not match/)
  await assert.rejects(() => begin({ ...base, size: '0' }), /size must be a positive/)
  await assert.rejects(() => begin({ ...base, checksum: 'not-a-sha' }), /checksum must be lowercase/)
})

test('signed upload sessions choose single or multipart and bind mandatory headers', async () => {
  const singleId = '123e4567-e89b-42d3-a456-426614174201'
  const multiId = '123e4567-e89b-42d3-a456-426614174202'
  const uploads = new Map([
    [singleId, { id: singleId, workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', kind: 'video', byteSize: '1048576', mimeType: 'video/mp4', expectedSha256: 'a'.repeat(64), status: 'pending-session', createdAt: '2026-07-16T22:00:00.000Z', expiresAt: '2026-07-16T22:30:00.000Z' }],
    [multiId, { id: multiId, workspaceId: 'workspace-upload-1', clientId: 'client-upload-1', kind: 'video', byteSize: String(200 * 1024 * 1024), mimeType: 'video/mp4', expectedSha256: 'b'.repeat(64), status: 'pending-session', createdAt: '2026-07-16T22:00:00.000Z', expiresAt: '2026-07-16T22:30:00.000Z' }],
  ])
  const sessionAudits = []
  const repository = {
    async findUpload({ uploadId }) { return uploads.get(uploadId) },
    async markSessionIssued(input) {
      sessionAudits.push(input.auditEntry)
      const value = { ...uploads.get(input.uploadId), status: 'uploading', sessionMode: input.mode, partSize: input.partSize, sessionExpiresAt: input.sessionExpiresAt }
      uploads.set(input.uploadId, value); return value
    },
  }
  const signer = new HmacMediaUploadSessionSigner({ baseUrl: 'https://uploads.example.com/', secret: 's'.repeat(32) })
  const issue = issueMediaUploadSessionService({ repository, signer, clock: () => new Date('2026-07-16T22:10:00.000Z') })
  const single = await issue({ workspaceId: 'workspace-upload-1', actor: MEDIA_UPLOAD_ACTOR, uploadId: singleId })
  const multi = await issue({ workspaceId: 'workspace-upload-1', actor: MEDIA_UPLOAD_ACTOR, uploadId: multiId })
  assert.equal(single.session.mode, 'single')
  assert.match(single.session.uploadUrl, /^https:\/\/uploads\.example\.com\//)
  assert.equal(single.session.requiredHeaders['x-apollo-content-sha256'], 'a'.repeat(64))
  assert.equal(multi.session.mode, 'multipart')
  assert.equal(multi.session.partSize, String(64 * 1024 * 1024))
  assert.equal(multi.session.maxParts, 4)
  assert.match(multi.session.partUrlTemplate, /partNumber=\{partNumber\}/)
  assert.deepEqual(sessionAudits.map((entry) => entry.audit.credentialId), ['credential-upload-1', 'credential-upload-1'])
  assert.equal(JSON.stringify({ single, multi }).includes('ssssssss'), false)
})

function resumableRepository(upload) {
  let current = { ...upload }
  const parts = new Map()
  const auditEntries = []
  return {
    auditEntries,
    async findUpload({ uploadId }) { return uploadId === current.id ? current : undefined },
    async listUploadParts() { return [...parts.values()].sort((a, b) => a.partNumber - b.partNumber) },
    async recordUploadPart({ part, auditEntry }) { parts.set(part.partNumber, part); auditEntries.push(auditEntry); return part },
    async markUploadVerifiedOrReplay(input) {
      if (current.status === 'verified') return { upload: current, replayed: true }
      current = { ...current, status: 'verified', actualByteSize: input.actualByteSize, actualSha256: input.actualSha256, verifiedAt: input.verifiedAt }
      return { upload: current, replayed: false }
    },
  }
}

const multipartUpload = {
  id: '123e4567-e89b-42d3-a456-426614174222', workspaceId: 'workspace-upload-1', clientId: 'client-upload-1',
  kind: 'video', byteSize: String(128 * 1024 * 1024), mimeType: 'video/mp4', expectedSha256: 'c'.repeat(64),
  status: 'uploading', sessionMode: 'multipart', partSize: String(64 * 1024 * 1024),
  createdAt: '2026-07-16T22:00:00.000Z', expiresAt: '2026-07-16T23:00:00.000Z', sessionExpiresAt: '2026-07-16T22:30:00.000Z',
}

test('multipart upload resumes from durable receipts and replaces one part naturally', async () => {
  const store = resumableRepository(multipartUpload)
  const record = recordMediaUploadPartService({ repository: store, clock: () => new Date('2026-07-16T22:10:00.000Z') })
  const base = { workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id, partNumber: 1, byteSize: multipartUpload.partSize, etag: '"partetag001"', checksum: 'd'.repeat(64) }
  await record(base)
  await record({ ...base, etag: '"partetag002"' })
  const resumed = await inspectMediaUploadService({ repository: store })(base)
  assert.deepEqual(resumed.missingPartNumbers, [2])
  assert.equal(resumed.parts.length, 1)
  assert.equal(resumed.parts[0].etag, '"partetag002"')
  assert.equal(store.auditEntries.every((entry) => entry.action === 'part-record' && entry.audit.credentialId === 'credential-upload-1'), true)
})

test('abort persists its actor with terminal state and rejects replay by another credential', async () => {
  let upload = { ...multipartUpload, status: 'uploading' }
  let abortAudit
  let discards = 0
  const repository = {
    async markUploadAbortedOrReplay(input) {
      if (upload.status === 'aborted') {
        if (abortAudit.audit.contextHash !== input.auditEntry.audit.contextHash) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'abort actor mismatch')
        }
        return { upload, replayed: true }
      }
      upload = { ...upload, status: 'aborted' }
      abortAudit = input.auditEntry
      return { upload, replayed: false }
    },
  }
  const abort = abortMediaUploadService({
    repository, storage: { async discard() { discards += 1 } },
    clock: () => new Date('2026-07-16T22:12:00.000Z'),
    createId: () => '123e4567-e89b-42d3-a456-426614174211',
  })
  const request = { workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id }
  assert.equal((await abort(request)).replayed, false)
  assert.equal((await abort(request)).replayed, true)
  assert.equal(abortAudit.action, 'abort')
  assert.equal(discards, 2)
  await assert.rejects(
    abort({ ...request, actor: uploadActor('credential-upload-2') }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('completion rejects incomplete multipart and any authoritative verification mismatch', async () => {
  const store = resumableRepository(multipartUpload)
  const complete = completeMediaUploadService({ repository: store, verifier: { async verify() { return { byteSize: multipartUpload.byteSize, mimeType: multipartUpload.mimeType, sha256: 'f'.repeat(64) } } } })
  await assert.rejects(() => complete({ workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id }), /incomplete/)
  const record = recordMediaUploadPartService({ repository: store, clock: () => new Date('2026-07-16T22:10:00.000Z') })
  for (const partNumber of [1, 2]) await record({ workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id, partNumber, byteSize: multipartUpload.partSize, etag: `"partetag00${partNumber}"`, checksum: 'd'.repeat(64) })
  await assert.rejects(() => complete({ workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id }), /checksum/)
})

test('exact verification completes once and subsequent completion is a safe replay', async () => {
  const store = resumableRepository(multipartUpload)
  const record = recordMediaUploadPartService({ repository: store, clock: () => new Date('2026-07-16T22:10:00.000Z') })
  for (const partNumber of [1, 2]) await record({ workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id, partNumber, byteSize: multipartUpload.partSize, etag: `"partetag00${partNumber}"`, checksum: 'd'.repeat(64) })
  let verifications = 0
  const complete = completeMediaUploadService({ repository: store, verifier: { async verify() { verifications += 1; return { byteSize: multipartUpload.byteSize, mimeType: multipartUpload.mimeType, sha256: multipartUpload.expectedSha256 } } }, clock: () => new Date('2026-07-16T22:15:00.000Z') })
  const first = await complete({ workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id })
  const replay = await complete({ workspaceId: multipartUpload.workspaceId, actor: MEDIA_UPLOAD_ACTOR, uploadId: multipartUpload.id })
  assert.equal(first.upload.status, 'verified')
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(verifications, 1)
})

test('HTTP verifier requires a safe fixed origin and rejects oversized metadata', async () => {
  assert.throws(() => new HttpMediaUploadVerifier({ baseUrl: 'http://storage.example.com/', token: 't'.repeat(20) }), /HTTPS/)
  const verifier = new HttpMediaUploadVerifier({
    baseUrl: 'https://storage.example.com/', token: 't'.repeat(20),
    fetchImplementation: async () => new Response('{}', { status: 200, headers: { 'content-length': '65537' } }),
  })
  await assert.rejects(() => verifier.verify({ upload: multipartUpload, parts: [] }), /too large/)
})

test('a replaced signed upload session is rejected before storage receives bytes', async () => {
  let storageWrites = 0
  const receive = receiveMediaUploadContentService({
    repository: {
      async findUpload() {
        return {
          ...multipartUpload,
          sessionExpiresAt: '2026-07-16T22:20:00.000Z',
        }
      },
    },
    storage: { async write() { storageWrites += 1; throw new Error('must not write') } },
    clock: () => new Date('2026-07-16T22:10:00.000Z'),
  })
  await assert.rejects(
    receive({
      workspaceId: multipartUpload.workspaceId, clientId: multipartUpload.clientId,
      uploadId: multipartUpload.id, mode: 'multipart', maxParts: 2, partNumber: 1,
      sessionExpiresAt: '2026-07-16T22:15:00.000Z', mimeType: multipartUpload.mimeType,
      expectedSha256: multipartUpload.expectedSha256,
      body: new ReadableStream(),
    }),
    /replaced/,
  )
  assert.equal(storageWrites, 0)
})

test('project source seed arguments are explicit, bounded and deterministic', () => {
  const parsed = readSeedArguments([
    '--seed-id', 'welcome-v1',
    '--workspace-id', 'workspace-seed-1',
    '--client-id', 'client-seed-1',
    '--project-name', 'Projeto de boas-vindas',
    '--source-file', './master.mp4',
  ])
  assert.equal(parsed.seedId, 'welcome-v1')
  assert.equal(parsed.objective, 'discovery')
  assert.equal(parsed.format, '9:16')
  assert.equal(parsed.locale, 'pt-BR')
  assert.equal(parsed.sourceMime, 'video/mp4')
  assert.match(parsed.sourceFile, /master\.mp4$/)
  assert.throws(() => readSeedArguments(['--seed-id', 'x']), /3-80/)
  assert.throws(() => readSeedArguments([
    '--seed-id', 'welcome-v1', '--seed-id', 'again',
  ]), /more than once/)
  assert.throws(() => readSeedArguments([
    '--seed-id', 'welcome-v1', '--workspace-id', 'workspace-seed-1',
    '--client-id', 'client-seed-1', '--project-name', 'Projeto',
    '--source-file', './master.mp4', '--unsafe-bypass', 'true',
  ]), /not a supported seed argument/)
})

test('Prisma upload replay preserves verified source metadata needed by durable ingest', async () => {
  const seedAudit = materializeActorAuditContext((() => {
    const auditContext = createExternalAuditContext({
      workspaceId: 'workspace-seed-1', clientId: 'client-seed-1',
      credentialId: 'credential-seed-1', environment: 'sandbox',
    })
    return { ...auditContext, scopes: new Set(['media:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
  })())
  const existing = {
    id: '123e4567-e89b-42d3-a456-426614174199',
    workspaceId: 'workspace-seed-1',
    clientId: 'client-seed-1',
    projectId: 'project-seed-1',
    fileName: 'master.mp4',
    rightsConfirmed: true,
    kind: 'video',
    byteSize: 42n,
    mimeType: 'video/mp4',
    expectedSha256: 'a'.repeat(64),
    actualSha256: 'a'.repeat(64),
    actualByteSize: 42n,
    status: 'verified',
    idempotencyKey: 'seed-upload:welcome-v1',
    requestFingerprint: 'f'.repeat(64),
    expiresAt: new Date('2026-08-02T18:00:00.000Z'),
    createdAt: new Date('2026-08-02T17:00:00.000Z'),
    sessionMode: 'single',
    partSize: null,
    sessionExpiresAt: new Date('2026-08-02T17:10:00.000Z'),
    verifiedAt: new Date('2026-08-02T17:01:00.000Z'),
    sessionAuditEntryId: null,
  }
  const storedAudit = {
    id: '123e4567-e89b-42d3-a456-426614174198',
    workspaceId: existing.workspaceId, uploadId: existing.id, action: 'begin', partNumber: null,
    actorClientId: seedAudit.clientId, actorCredentialId: seedAudit.credentialId,
    actorEnvironment: seedAudit.environment, actorAuthenticationKind: seedAudit.authenticationKind,
    actorContextHash: seedAudit.contextHash, delegatedUserId: null, delegatedIdentityId: null,
    workspaceRole: null, requestFingerprint: existing.requestFingerprint,
    occurredAt: existing.createdAt,
  }
  const repository = new PrismaMediaTransferRepository({
    async $transaction(callback) {
      return callback({
        v2MediaUpload: { async findUnique() { return existing } },
        v2MediaUploadAuditEntry: { async findFirst() { return storedAudit } },
      })
    },
  })
  const candidateUpload = {
    ...multipartUpload, workspaceId: existing.workspaceId, clientId: existing.clientId,
  }
  const replay = await repository.createOrReplayUpload({
    upload: candidateUpload,
    idempotencyKey: existing.idempotencyKey,
    requestFingerprint: existing.requestFingerprint,
    auditEntry: createMediaUploadAuditEntry({
      id: '123e4567-e89b-42d3-a456-426614174197',
      workspaceId: existing.workspaceId, uploadId: candidateUpload.id,
      action: 'begin', audit: seedAudit, requestFingerprint: existing.requestFingerprint,
      occurredAt: existing.createdAt.toISOString(),
    }),
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.upload.projectId, existing.projectId)
  assert.equal(replay.upload.fileName, existing.fileName)
  assert.equal(replay.upload.rightsConfirmed, true)
  assert.equal(replay.upload.status, 'verified')
  assert.equal(replay.upload.actualSha256, existing.actualSha256)
  assert.equal(replay.upload.sessionMode, 'single')
  const otherAuditContext = createExternalAuditContext({
    workspaceId: existing.workspaceId, clientId: existing.clientId,
    credentialId: 'credential-seed-2', environment: 'sandbox',
  })
  const otherAudit = materializeActorAuditContext({
    ...otherAuditContext, scopes: new Set(['media:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: otherAuditContext,
  })
  const completionStored = {
    ...storedAudit, id: '123e4567-e89b-42d3-a456-426614174195',
    action: 'complete', requestFingerprint: 'c'.repeat(64),
  }
  const completionRepository = new PrismaMediaTransferRepository({
    async $transaction(callback) {
      return callback({
        v2MediaUpload: { async findFirst() { return existing } },
        v2MediaUploadAuditEntry: { async findFirst() { return completionStored } },
      })
    },
  })
  await assert.rejects(
    completionRepository.markUploadVerifiedOrReplay({
      workspaceId: existing.workspaceId, clientId: existing.clientId, uploadId: existing.id,
      actualByteSize: existing.actualByteSize.toString(), actualSha256: existing.actualSha256,
      verifiedAt: existing.verifiedAt.toISOString(),
      auditEntry: createMediaUploadAuditEntry({
        id: '123e4567-e89b-42d3-a456-426614174194',
        workspaceId: existing.workspaceId, uploadId: existing.id, action: 'complete',
        audit: otherAudit, requestFingerprint: completionStored.requestFingerprint,
        occurredAt: existing.verifiedAt.toISOString(),
      }),
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  storedAudit.actorCredentialId = 'credential-forged'
  await assert.rejects(
    repository.createOrReplayUpload({
      upload: candidateUpload, idempotencyKey: existing.idempotencyKey,
      requestFingerprint: existing.requestFingerprint,
      auditEntry: createMediaUploadAuditEntry({
        id: '123e4567-e89b-42d3-a456-426614174196',
        workspaceId: existing.workspaceId, uploadId: candidateUpload.id,
        action: 'begin', audit: seedAudit, requestFingerprint: existing.requestFingerprint,
        occurredAt: existing.createdAt.toISOString(),
      }),
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})
