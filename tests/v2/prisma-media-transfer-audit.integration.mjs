import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { beginMediaUploadService } from '../../src/v2/application/begin-media-upload.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { issueMediaUploadSessionService } from '../../src/v2/application/issue-media-upload-session.ts'
import {
  abortMediaUploadService,
  completeMediaUploadService,
  recordMediaUploadPartService,
} from '../../src/v2/application/manage-media-upload.ts'
import { receiveMediaUploadContentService } from '../../src/v2/application/receive-media-upload-content.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaMediaTransferRepository } from '../../src/v2/infrastructure/prisma/media-transfer-repository.ts'
import { HmacMediaUploadSessionSigner } from '../../src/v2/infrastructure/security/media-upload-session-signer.ts'

function actor(workspaceId, clientId, credentialId) {
  const auditContext = createExternalAuditContext({
    workspaceId, clientId, credentialId, environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['media:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

test('media upload mutations persist an actor-bound immutable audit ledger', async () => {
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `media-transfer-audit-${suffix}`
  const clientId = `media-transfer-client-${suffix}`
  const primaryActor = actor(workspaceId, clientId, `media-transfer-credential-a-${suffix}`)
  const otherActor = actor(workspaceId, clientId, `media-transfer-credential-b-${suffix}`)
  const repository = new PrismaMediaTransferRepository(client)
  const signer = new HmacMediaUploadSessionSigner({
    baseUrl: 'https://uploads.example.test/', secret: 'm'.repeat(48),
  })
  let now = new Date('2026-08-04T18:00:00.000Z')
  const clock = () => now
  const cleanup = async () => {
    await client.v2MediaUpload.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await client.v2Workspace.create({ data: {
      id: workspaceId, slug: `media-transfer-${suffix}`, name: 'Media transfer audit integration',
    } })
    await client.v2ApiClient.create({ data: {
      id: clientId, workspaceId, name: 'Media transfer audit client',
      type: 'service-account', allowedEnvironmentsJson: '["sandbox"]',
      scopeGrantsJson: '["media:write"]', createdBy: 'integration-test',
    } })

    const begin = beginMediaUploadService({ repository, clock, createId: randomUUID })
    const intent = await begin({
      workspaceId, actor: primaryActor, idempotencyKey: `media-transfer-begin-${suffix}`,
      kind: 'video', size: String(128 * 1024 * 1024), mimeType: 'video/mp4',
      checksum: 'a'.repeat(64),
    })
    const issue = issueMediaUploadSessionService({ repository, signer, clock, createId: randomUUID })
    const firstSession = await issue({ workspaceId, actor: primaryActor, uploadId: intent.upload.id })
    now = new Date('2026-08-04T18:01:00.000Z')
    const secondSession = await issue({ workspaceId, actor: primaryActor, uploadId: intent.upload.id })
    assert.notEqual(firstSession.session.expiresAt, secondSession.session.expiresAt)

    const firstToken = new URL(firstSession.session.partUrlTemplate).searchParams.get('token')
    const firstClaims = signer.authorize(firstToken, new Date('2026-08-04T18:01:01.000Z'))
    let storageWrites = 0
    await assert.rejects(
      receiveMediaUploadContentService({
        repository,
        storage: { async write() { storageWrites += 1; throw new Error('must not write') } },
        clock: () => new Date('2026-08-04T18:01:01.000Z'),
      })({
        ...firstClaims, partNumber: 1, mimeType: 'video/mp4',
        expectedSha256: 'a'.repeat(64), body: new ReadableStream(),
      }),
      (error) => error instanceof DomainError && error.code === 'MEDIA_UPLOAD_TRANSITION_REJECTED',
    )
    assert.equal(storageWrites, 0)

    const record = recordMediaUploadPartService({ repository, clock, createId: randomUUID })
    for (const partNumber of [1, 2]) {
      await record({
        workspaceId, actor: primaryActor, uploadId: intent.upload.id, partNumber,
        byteSize: String(64 * 1024 * 1024), etag: `"auditpart0${partNumber}"`,
        checksum: String(partNumber).repeat(64),
      })
    }
    const complete = completeMediaUploadService({
      repository, clock, createId: randomUUID,
      verifier: { async verify() {
        return { byteSize: String(128 * 1024 * 1024), mimeType: 'video/mp4', sha256: 'a'.repeat(64) }
      } },
    })
    const completed = await complete({ workspaceId, actor: primaryActor, uploadId: intent.upload.id })
    assert.equal(completed.replayed, false)
    assert.equal((await complete({ workspaceId, actor: primaryActor, uploadId: intent.upload.id })).replayed, true)
    await assert.rejects(
      complete({ workspaceId, actor: otherActor, uploadId: intent.upload.id }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )

    const abortIntent = await begin({
      workspaceId, actor: primaryActor, idempotencyKey: `media-transfer-abort-${suffix}`,
      kind: 'video', size: '1024', mimeType: 'video/mp4', checksum: 'b'.repeat(64),
    })
    let discards = 0
    const abort = abortMediaUploadService({
      repository, clock, createId: randomUUID,
      storage: { async discard() { discards += 1 } },
    })
    assert.equal((await abort({ workspaceId, actor: primaryActor, uploadId: abortIntent.upload.id })).replayed, false)
    assert.equal((await abort({ workspaceId, actor: primaryActor, uploadId: abortIntent.upload.id })).replayed, true)
    await assert.rejects(
      abort({ workspaceId, actor: otherActor, uploadId: abortIntent.upload.id }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(discards, 2)

    const entries = await client.v2MediaUploadAuditEntry.findMany({
      where: { workspaceId }, orderBy: [{ occurredAt: 'asc' }, { action: 'asc' }],
    })
    assert.deepEqual(
      entries.map((entry) => entry.action).sort(),
      ['abort', 'begin', 'begin', 'complete', 'part-record', 'part-record', 'session-issue', 'session-issue'].sort(),
    )
    assert.equal(entries.every((entry) => entry.actorCredentialId === primaryActor.credentialId), true)
    assert.equal(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.actorContextHash)), true)
    assert.equal(entries.filter((entry) => entry.action === 'part-record').every((entry) => entry.partNumber !== null), true)

    const completionEntry = entries.find((entry) => entry.action === 'complete')
    await client.v2MediaUploadAuditEntry.update({
      where: { id: completionEntry.id }, data: { actorCredentialId: 'credential-tampered' },
    })
    await assert.rejects(
      complete({ workspaceId, actor: primaryActor, uploadId: intent.upload.id }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
