import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'presenter-lifecycle-workspace'
const clientId = 'presenter-lifecycle-client'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2026-08-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-103 presenter profiles version, activate, deactivate and expire under strict lifecycle', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 240_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })

  const cleanup = async () => {
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const {
      attachSyntheticPresenterConsentProofService,
      createSyntheticPresenterProfileVersionService,
      listSyntheticPresenterProfilesService,
      readSyntheticPresenterProfileService,
      setSyntheticPresenterProfileStatusService,
    } = await import('../../src/v2/application/synthetic-presenter-lifecycle.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Presenter lifecycle', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId: 'presenter-lifecycle-credential', workspaceId, name: 'Lifecycle client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    await client.v2MediaArtifact.create({
      data: {
        id: 'lifecycle-consent-evidence', workspaceId, artifactKey: 'lifecycle/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: 'lifecycle-consent-evidence-2', workspaceId, artifactKey: 'lifecycle/consent-2.json',
        sha256: hash('b'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })

    const repository = new PrismaSyntheticProductionRepository(client)
    const register = registerSyntheticPresenterProfileService({
      repository, artifacts: new PrismaMediaArtifactRepository(client), clock: () => new Date(at(1)),
    })
    const list = listSyntheticPresenterProfilesService({ repository })
    const read = readSyntheticPresenterProfileService({ repository })
    const createVersion = createSyntheticPresenterProfileVersionService({ repository, register })
    const setStatus = setSyntheticPresenterProfileStatusService({ repository, createVersion, clock: () => new Date(at(2)) })
    const attachConsent = attachSyntheticPresenterConsentProofService({ createVersion })

    const consent = (overrides = {}) => ({
      id: 'lifecycle-consent-1', evidenceArtifactId: 'lifecycle-consent-evidence', granted: true,
      allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
      allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      ...overrides,
    })

    // 1. Registering v1 creates the head; new optional fields are hash-bound.
    const v1 = await register({
      workspaceId, profileId: 'lifecycle-presenter', version: 1, actorIdentityId: 'lifecycle-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_lifecycle' },
      voice: { id: 'voice_lifecycle_a', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: consent(),
      visualContinuity: { wardrobe: 'blazer azul', background: 'estúdio neutro' },
      restrictions: ['nunca conteúdo político'],
      actor, idempotencyKey: 'lifecycle-register-v1',
    })
    assert.equal(v1.replayed, false)
    assert.deepEqual(v1.profile.snapshot.restrictions, ['nunca conteúdo político'])
    assert.equal(v1.profile.snapshot.visualContinuity.wardrobe, 'blazer azul')
    const heads = await list({ workspaceId, actor })
    assert.equal(heads.length, 1)
    assert.equal(heads[0].head.currentVersion, 1)
    assert.equal(heads[0].current.profileSnapshotId, 'lifecycle-presenter:v1')

    // 2. A relevant change appends exactly the next version under OCC.
    const v2 = await createVersion({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 1,
      changes: { voice: { id: 'voice_lifecycle_b', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' } },
      actor, idempotencyKey: 'lifecycle-version-v2',
    })
    assert.equal(v2.profile.snapshot.version, 2)
    assert.equal(v2.profile.snapshot.voice.id, 'voice_lifecycle_b')
    assert.equal(v2.profile.snapshot.visualContinuity.wardrobe, 'blazer azul', 'untouched fields carry forward')
    await assert.rejects(
      createVersion({
        workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 1,
        changes: { disclosure: 'Outra divulgação obrigatória' }, actor, idempotencyKey: 'lifecycle-stale',
      }),
      (error) => error.code === 'VERSION_CONFLICT',
    )

    // 3. Deactivation and reactivation are auditable versions.
    const v3 = await setStatus({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 2, status: 'disabled',
      actor, idempotencyKey: 'lifecycle-disable',
    })
    assert.equal(v3.profile.snapshot.status, 'disabled')
    const v4 = await setStatus({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 3, status: 'active',
      actor, idempotencyKey: 'lifecycle-enable',
    })
    assert.equal(v4.profile.snapshot.status, 'active')

    // 4. Attaching a revoked consent proof is recorded; reactivation with an
    //    invalid consent fails closed until a fresh proof replaces it.
    const v5 = await attachConsent({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 4,
      consent: consent({ id: 'lifecycle-consent-2', revokedAt: '2026-06-01T00:00:00.000Z' }),
      actor, idempotencyKey: 'lifecycle-revoke',
    })
    assert.equal(v5.profile.snapshot.consent.revokedAt, '2026-06-01T00:00:00.000Z')
    const v6 = await setStatus({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 5, status: 'disabled',
      actor, idempotencyKey: 'lifecycle-disable-2',
    })
    await assert.rejects(
      setStatus({
        workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 6, status: 'active',
        actor, idempotencyKey: 'lifecycle-enable-blocked',
      }),
      (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
    )
    const v7 = await attachConsent({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 6,
      consent: consent({ id: 'lifecycle-consent-3', evidenceArtifactId: 'lifecycle-consent-evidence-2' }),
      actor, idempotencyKey: 'lifecycle-fresh-consent',
    })
    assert.equal(v7.profile.snapshot.consent.evidenceSha256, hash('b'))
    const v8 = await setStatus({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 7, status: 'active',
      actor, idempotencyKey: 'lifecycle-enable-again',
    })
    assert.equal(v8.profile.snapshot.status, 'active')

    // 5. History stays fully readable; replay is idempotent.
    const detail = await read({ workspaceId, profileId: 'lifecycle-presenter', actor })
    assert.equal(detail.head.currentVersion, 8)
    assert.deepEqual(detail.versions.map(({ snapshot }) => snapshot.version), [1, 2, 3, 4, 5, 6, 7, 8])
    const replayed = await setStatus({
      workspaceId, profileId: 'lifecycle-presenter', expectedVersion: 7, status: 'active',
      actor, idempotencyKey: 'lifecycle-enable-again',
    })
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.profile.snapshot.version, 8)

    // 6. Cross-workspace isolation.
    await assert.rejects(
      read({ workspaceId: 'other-workspace', profileId: 'lifecycle-presenter', actor }),
      (error) => error.code === 'AUTH_INVALID',
    )
    assert.equal(await repository.readProfileHead({ workspaceId: 'other-workspace', profileId: 'lifecycle-presenter' }), null)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
