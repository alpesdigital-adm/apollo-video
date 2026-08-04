import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { setExternalAssetRightsService } from '../../src/v2/application/set-asset-rights.ts'
import { assetRightsRevision } from '../../src/v2/domain/asset-rights.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'

function actor(workspaceId, clientId, credentialId) {
  const auditContext = createExternalAuditContext({
    workspaceId, clientId, credentialId, environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['artifacts:rights']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

test('asset rights revisions persist exact external actors while reusing snapshots', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `rights-audit-${suffix}`
  const clientId = `rights-client-${suffix}`
  const artifactId = `rights-artifact-${suffix}`
  const repository = new PrismaAssetRightsRepository(prisma)
  const cleanup = async () => {
    await prisma.v2AssetRightsChange.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifact.updateMany({
      where: { workspaceId }, data: { currentRightsSnapshotId: null },
    })
    await prisma.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
    await prisma.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await prisma.v2ApiClient.deleteMany({ where: { workspaceId } })
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }
  try {
    await cleanup()
    await prisma.v2Workspace.create({ data: {
      id: workspaceId, slug: `rights-audit-${suffix}`, name: 'Rights audit integration',
    } })
    await prisma.v2ApiClient.create({ data: {
      id: clientId, workspaceId, name: 'Rights audit client', type: 'service-account',
      allowedEnvironmentsJson: '["sandbox"]', scopeGrantsJson: '["artifacts:rights"]',
      createdBy: 'integration-test',
    } })
    await prisma.v2MediaArtifact.create({ data: {
      id: artifactId, workspaceId, artifactKey: `rights-audit/${suffix}/source.mp4`,
      sha256: 'a'.repeat(64), byteSize: 1024n, mediaType: 'video', container: 'mp4',
    } })
    const service = setExternalAssetRightsService({
      repository,
      clock: () => new Date('2026-08-04T21:00:00.000Z'),
      createId: () => `rights-snapshot-${suffix}`,
    })
    const draft = {
      status: 'approved', allowedUses: ['rendering'], prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] },
    }
    const actorA = actor(workspaceId, clientId, `rights-credential-a-${suffix}`)
    const actorB = actor(workspaceId, clientId, `rights-credential-b-${suffix}`)
    const base = assetRightsRevision(artifactId, 0)
    const first = await service({ workspaceId, artifactId, baseRevision: base, draft, actor: actorA })
    assert.equal(first.replayed, false)
    assert.equal((await service({ workspaceId, artifactId, baseRevision: base, draft, actor: actorA })).replayed, true)
    await assert.rejects(
      service({ workspaceId, artifactId, baseRevision: base, draft, actor: actorB }),
      (error) => error instanceof DomainError && error.code === 'ASSET_RIGHTS_REVISION_MISMATCH',
    )
    const second = await service({
      workspaceId, artifactId, baseRevision: first.revision, draft, actor: actorB,
    })
    assert.equal(second.replayed, false)

    const [snapshots, changes] = await Promise.all([
      prisma.v2AssetRightsSnapshot.findMany({ where: { workspaceId } }),
      prisma.v2AssetRightsChange.findMany({ where: { workspaceId }, orderBy: { sequence: 'asc' } }),
    ])
    assert.equal(snapshots.length, 1)
    assert.equal(changes.length, 2)
    assert.deepEqual(changes.map((row) => row.actorCredentialId), [
      actorA.credentialId, actorB.credentialId,
    ])
    assert.deepEqual(changes.map((row) => row.sequence), [1, 2])
    assert.equal(changes[0].snapshotId, changes[1].snapshotId)
    assert.equal(changes.every((row) => row.actorContextHash?.length === 64), true)

    await prisma.v2AssetRightsChange.update({
      where: { id: changes[1].id }, data: { actorCredentialId: 'rights-credential-tampered' },
    })
    await assert.rejects(
      repository.findCurrent(workspaceId, artifactId),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
  } finally {
    await cleanup()
    await prisma.$disconnect()
  }
})
