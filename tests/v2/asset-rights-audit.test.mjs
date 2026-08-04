import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { setExternalAssetRightsService } from '../../src/v2/application/set-asset-rights.ts'
import { assetRightsRevision } from '../../src/v2/domain/asset-rights.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'

function actor(credentialId) {
  const auditContext = createExternalAuditContext({
    clientId: 'rights-client-1',
    credentialId,
    workspaceId: 'workspace-rights-1',
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['artifacts:rights']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function fakePrisma() {
  const artifact = {
    id: 'artifact-rights-1',
    workspaceId: 'workspace-rights-1',
    status: 'available',
    rightsRevision: 0,
    currentRightsSnapshotId: null,
  }
  const snapshots = []
  const changes = []
  const currentSnapshot = () => snapshots.find((row) => row.id === artifact.currentRightsSnapshotId) ?? null
  const artifactRecord = (include = false) => include
    ? {
        ...artifact,
        currentRightsSnapshot: currentSnapshot(),
        rightsChanges: [...changes].sort((left, right) => right.sequence - left.sequence).slice(0, 1),
      }
    : { ...artifact }
  const tx = {
    v2MediaArtifact: {
      async findFirst(input) {
        if (input.where.id !== artifact.id || input.where.workspaceId !== artifact.workspaceId) return null
        return artifactRecord(Boolean(input.include))
      },
      async findMany() { return [artifactRecord(true)] },
      async updateMany(input) {
        if (input.where.rightsRevision !== artifact.rightsRevision) return { count: 0 }
        artifact.rightsRevision += input.data.rightsRevision.increment
        if (input.data.currentRightsSnapshotId) {
          artifact.currentRightsSnapshotId = input.data.currentRightsSnapshotId
        }
        return { count: 1 }
      },
      async update(input) {
        artifact.currentRightsSnapshotId = input.data.currentRightsSnapshotId
        return artifactRecord()
      },
    },
    v2AssetRightsSnapshot: {
      async findUnique(input) {
        const key = input.where.artifactId_snapshotHash
        return snapshots.find((row) => row.artifactId === key.artifactId && row.snapshotHash === key.snapshotHash) ?? null
      },
      async create(input) {
        const row = { ...input.data }
        for (const field of [
          'owner', 'license', 'allowedMarketsJson', 'allowedLocalesJson',
          'allowedSyntheticOperationsJson', 'expiresAt',
          'consentAllowedMarketsJson', 'consentAllowedLocalesJson',
          'consentSyntheticOperationsJson', 'consentExpiresAt',
          'consentDocumentArtifactId', 'sourceNote',
        ]) row[field] ??= null
        snapshots.push(row)
        return snapshots.at(-1)
      },
    },
    v2AssetRightsChange: {
      async findUnique(input) {
        const key = input.where.artifactId_sequence
        return changes.find((row) => row.artifactId === key.artifactId && row.sequence === key.sequence) ?? null
      },
      async create(input) {
        const row = { ...input.data }
        for (const field of [
          'actorClientId', 'actorCredentialId', 'actorEnvironment',
          'actorAuthenticationKind', 'actorDelegatedUserId',
          'actorDelegatedIdentityId', 'actorWorkspaceRole', 'actorContextHash',
        ]) row[field] ??= null
        changes.push(row)
        return changes.at(-1)
      },
    },
  }
  return {
    artifact,
    snapshots,
    changes,
    client: {
      ...tx,
      async $transaction(action) { return action(tx) },
    },
  }
}

test('asset rights revisions bind exact credentials while reusing content-addressed snapshots', async () => {
  const state = fakePrisma()
  const repository = new PrismaAssetRightsRepository(state.client)
  const fixedClock = () => new Date('2026-08-04T21:00:00.000Z')
  const service = setExternalAssetRightsService({
    repository,
    clock: fixedClock,
    createId: () => 'rights-snapshot-1',
  })
  const draft = {
    status: 'approved',
    allowedUses: ['rendering'],
    prohibitedUses: [],
    consent: { status: 'not-required', allowedUses: [] },
  }
  const base = assetRightsRevision(state.artifact.id, 0)
  const credentialA = actor('rights-credential-a')
  const credentialB = actor('rights-credential-b')

  const first = await service({
    workspaceId: state.artifact.workspaceId,
    artifactId: state.artifact.id,
    baseRevision: base,
    draft,
    actor: credentialA,
  })
  assert.equal(first.replayed, false)
  assert.equal((await service({
    workspaceId: state.artifact.workspaceId,
    artifactId: state.artifact.id,
    baseRevision: base,
    draft,
    actor: credentialA,
  })).replayed, true)
  await assert.rejects(
    service({
      workspaceId: state.artifact.workspaceId,
      artifactId: state.artifact.id,
      baseRevision: base,
      draft,
      actor: credentialB,
    }),
    (error) => error instanceof DomainError && error.code === 'ASSET_RIGHTS_REVISION_MISMATCH',
  )

  const second = await service({
    workspaceId: state.artifact.workspaceId,
    artifactId: state.artifact.id,
    baseRevision: first.revision,
    draft,
    actor: credentialB,
  })
  assert.equal(second.replayed, false)
  assert.equal(state.snapshots.length, 1)
  assert.equal(state.changes.length, 2)
  assert.deepEqual(state.changes.map((row) => row.actorCredentialId), [
    'rights-credential-a',
    'rights-credential-b',
  ])
  assert.deepEqual(state.changes.map((row) => row.sequence), [1, 2])
  assert.equal(state.changes[1].snapshotId, state.changes[0].snapshotId)

  state.changes[1].actorCredentialId = 'rights-credential-tampered'
  await assert.rejects(
    repository.findCurrent(state.artifact.workspaceId, state.artifact.id),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('external asset rights boundary enforces scope and hides another workspace', async () => {
  let writes = 0
  const service = setExternalAssetRightsService({
    repository: { async setCurrent() { writes += 1; throw new Error('must not write') } },
    clock: () => new Date('2026-08-04T21:00:00.000Z'),
    createId: () => 'rights-snapshot-denied',
  })
  const authorized = actor('rights-credential-a')
  await assert.rejects(
    service({
      workspaceId: 'workspace-rights-other', artifactId: 'artifact-rights-1',
      baseRevision: 'a'.repeat(64), draft: {}, actor: authorized,
    }),
    (error) => error instanceof DomainError && error.code === 'MEDIA_ARTIFACT_NOT_FOUND',
  )
  const withoutScope = Object.freeze({ ...authorized, scopes: new Set() })
  await assert.rejects(
    service({
      workspaceId: authorized.workspaceId, artifactId: 'artifact-rights-1',
      baseRevision: 'a'.repeat(64), draft: {}, actor: withoutScope,
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )
  assert.equal(writes, 0)
})
