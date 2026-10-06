import test from 'node:test'
import assert from 'node:assert/strict'

import { catalogApprovedOutputService } from '../../src/v2/application/catalog-approved-output.ts'
import { assetRightsRevision, createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { assertAutomaticCatalogCandidate, createInheritedCatalogRights } from '../../src/v2/domain/automatic-catalog.ts'

const candidate = (overrides = {}) => ({
  workspaceId: 'workspace-catalog', artifactId: 'artifact-output', manifestId: 'manifest-output',
  outputKind: 'final', searchableKind: 'asset', label: 'Final aprovado.mp4',
  eligibilityEvidenceHash: 'e'.repeat(64),
  lineage: [{ sourceArtifactId: 'artifact-source-a', role: 'base-video', ordinal: 0, provider: 'openai', model: 'video-model', modelVersion: '1' }],
  ...overrides,
})

function rights(artifactId, overrides = {}) {
  return createAssetRightsSnapshot({
    id: `rights-${artifactId}`, workspaceId: 'workspace-catalog', artifactId, sequence: 1,
    draft: { status: 'approved', allowedUses: ['editorial-reuse', 'social-publish'], prohibitedUses: [], allowedMarkets: ['BR', 'US'], allowedLocales: ['pt-BR', 'en-US'], consent: { status: 'approved', allowedUses: ['editorial-reuse', 'social-publish'], allowedMarkets: ['BR'] }, ...overrides },
    createdBy: { type: 'system', id: 'rights-seed' }, createdAt: '2026-08-12T12:00:00.000Z',
  })
}

test('T-FR-049 inherits the most restrictive rights and consent without widening scope', () => {
  const inherited = createInheritedCatalogRights({
    candidate: candidate({ lineage: [
      { sourceArtifactId: 'artifact-source-a', role: 'base-video', ordinal: 0 },
      { sourceArtifactId: 'artifact-source-b', role: 'audio', ordinal: 1 },
    ] }),
    sourceSnapshots: [rights('artifact-source-a'), rights('artifact-source-b', { allowedUses: ['editorial-reuse'], allowedMarkets: ['BR'], allowedLocales: ['pt-BR'], consent: { status: 'not-required', allowedUses: [] } })],
    sequence: 1, createdAt: '2026-08-12T13:00:00.000Z',
  })
  assert.deepEqual(inherited.allowedUses, ['editorial-reuse'])
  assert.deepEqual(inherited.allowedMarkets, ['BR'])
  assert.deepEqual(inherited.allowedLocales, ['pt-BR'])
  assert.equal(inherited.consent.status, 'approved')
  assert.deepEqual(inherited.consent.allowedUses, ['editorial-reuse', 'social-publish'])
  assert.match(inherited.sourceNote, /^Inherited fail-closed from 2 source\(s\); evidence [a-f0-9]{64}$/)
})

test('T-FR-049 gives equivalent inherited rights artifact-bound identities', () => {
  const sourceSnapshots = [rights('artifact-source-a')]
  const first = createInheritedCatalogRights({
    candidate: candidate({ artifactId: 'artifact-output-a', manifestId: 'manifest-output-a' }),
    sourceSnapshots,
    sequence: 1,
    createdAt: '2026-08-12T13:00:00.000Z',
  })
  const second = createInheritedCatalogRights({
    candidate: candidate({ artifactId: 'artifact-output-b', manifestId: 'manifest-output-b' }),
    sourceSnapshots,
    sequence: 1,
    createdAt: '2026-08-12T13:00:00.000Z',
  })

  assert.notEqual(first.id, second.id)
  assert.equal(first.artifactId, 'artifact-output-a')
  assert.equal(second.artifactId, 'artifact-output-b')
  assert.deepEqual(first.allowedUses, second.allowedUses)
})

test('T-FR-049 fails closed for missing, revoked or incompatible consent evidence', () => {
  assert.throws(() => createInheritedCatalogRights({ candidate: candidate(), sourceSnapshots: [], sequence: 1, createdAt: '2026-08-12T13:00:00Z' }), /no source rights evidence/)
  assert.throws(() => createInheritedCatalogRights({ candidate: candidate(), sourceSnapshots: [rights('artifact-source-a', { status: 'revoked', allowedUses: [], consent: { status: 'not-required', allowedUses: [] } })], sequence: 1, createdAt: '2026-08-12T13:00:00Z' }), /not approved/)
  assert.throws(() => createInheritedCatalogRights({ candidate: candidate(), sourceSnapshots: [rights('artifact-source-a', { consent: { status: 'approved', allowedUses: ['social-publish'] } })], sequence: 1, createdAt: '2026-08-12T13:00:00Z' }), /does not allow editorial reuse/)
  assert.throws(() => createInheritedCatalogRights({ candidate: candidate(), sourceSnapshots: [rights('artifact-source-a', { expiresAt: '2026-08-12T12:30:00Z' })], sequence: 1, createdAt: '2026-08-12T13:00:00Z' }), /expired/)
  assert.throws(() => createInheritedCatalogRights({ candidate: candidate(), sourceSnapshots: [rights('artifact-source-a', { consent: { status: 'approved', allowedUses: ['editorial-reuse'], expiresAt: '2026-08-12T12:30:00Z' } })], sequence: 1, createdAt: '2026-08-12T13:00:00Z' }), /expired/)
})

test('T-FR-049 skips cataloging when output source rights are incomplete or restricted', async () => {
  for (const source of [null, rights('artifact-source-a', { allowedUses: ['rendering'] }), rights('artifact-source-a', { expiresAt: '2026-08-12T12:30:00Z' })]) {
    let writes = 0
    const service = catalogApprovedOutputService({
      repository: {
        async inspect() { return candidate() },
        async persist() { writes++; throw new Error('must not persist') },
      },
      rights: {
        async findCurrentForArtifacts() { return new Map(source ? [['artifact-source-a', source]] : []) },
        async findCurrent() { return { artifactId: 'artifact-output', revision: assetRightsRevision('artifact-output', 0), snapshot: null } },
        async setCurrent() { writes++; throw new Error('must not mutate rights') },
      },
      clock: () => new Date('2026-08-12T13:00:00.000Z'),
    })
    assert.deepEqual(await service(candidate()), { status: 'ignored', reason: source ? 'source-rights-blocked' : 'source-rights-missing', record: null })
    assert.equal(writes, 0)
  }
})

test('T-FR-049 never replaces an explicit output rights decision on worker replay', async () => {
  const service = catalogApprovedOutputService({
    repository: { async inspect() { return candidate() }, async persist() { throw new Error('must not persist') } },
    rights: {
      async findCurrentForArtifacts() { return new Map([['artifact-source-a', rights('artifact-source-a')]]) },
      async findCurrent() { return { artifactId: 'artifact-output', revision: assetRightsRevision('artifact-output', 1), snapshot: rights('artifact-output', { status: 'revoked', allowedUses: [] }) } },
      async setCurrent() { throw new Error('manual revocation must remain current') },
    },
    clock: () => new Date('2026-08-12T13:00:00.000Z'),
  })
  assert.deepEqual(await service(candidate()), { status: 'ignored', reason: 'output-rights-managed', record: null })
})

test('T-FR-049 catalogs an eligible output idempotently by workspace artifact and manifest', async () => {
  const source = rights('artifact-source-a')
  let current = { artifactId: 'artifact-output', revision: assetRightsRevision('artifact-output', 0), snapshot: null }
  let saved
  let rightsWrites = 0
  const service = catalogApprovedOutputService({
    repository: {
      async find() { return saved ?? null },
      async inspect() { return candidate() },
      async persist(input) {
        if (saved) return { record: saved, replayed: true }
        saved = { id: 'catalog-record', ...input.candidate, rightsSnapshotId: input.rightsSnapshotId, rightsSnapshotHash: input.rightsSnapshotHash, recordHash: 'f'.repeat(64), createdAt: input.createdAt }
        return { record: saved, replayed: false }
      },
    },
    rights: {
      async findCurrent() { return current },
      async findCurrentForArtifacts() { return new Map([['artifact-source-a', source]]) },
      async setCurrent(snapshot) { rightsWrites++; current = { artifactId: snapshot.artifactId, revision: assetRightsRevision(snapshot.artifactId, 1), snapshot }; return { ...current, replayed: false } },
    },
    clock: () => new Date('2026-08-12T13:00:00.000Z'),
  })
  assert.equal((await service(candidate())).status, 'cataloged')
  assert.equal((await service(candidate())).status, 'already-cataloged')
  assert.equal(rightsWrites, 1)
  assert.equal(saved.lineage[0].provider, 'openai')
  assert.equal(saved.lineage[0].model, 'video-model')
})

test('T-FR-049 ignores ineligible persisted output and requires provider/model for deepfake segments', async () => {
  const service = catalogApprovedOutputService({ repository: { async find() { return null }, async inspect() { return null }, async persist() { throw new Error('must not persist') } }, rights: {} })
  assert.deepEqual(await service(candidate()), { status: 'ignored', reason: 'not-approved', record: null })
  assert.throws(() => assertAutomaticCatalogCandidate(candidate({ outputKind: 'deepfake-raw', searchableKind: 'segment', sourceDurationMs: 1000, lineage: [{ sourceArtifactId: 'artifact-source-a', role: 'generated-from', ordinal: 0 }] })), /requires provider and model/)
  assert.doesNotThrow(() => assertAutomaticCatalogCandidate(candidate({ outputKind: 'deepfake-raw', searchableKind: 'segment', sourceDurationMs: 1000 })))
})

test('W58 deepfake catalog preserves explicit output rights and refuses a wider or revoked decision', async () => {
  const raw = candidate({ outputKind: 'deepfake-raw', searchableKind: 'segment', sourceDurationMs: 2000 })
  const source = rights('artifact-source-a')
  for (const output of [
    rights('artifact-output', { allowedUses: ['editorial-reuse'] }),
    rights('artifact-output', { allowedUses: ['editorial-reuse', 'social-publish', 'unlicensed-use'] }),
    rights('artifact-output', { status: 'revoked', allowedUses: [] }),
  ]) {
    let writes = 0
    const service = catalogApprovedOutputService({
      repository: { async inspect() { return raw }, async persist() { writes++; return { record: { id: 'raw-record' }, replayed: false } } },
      rights: {
        async findCurrentForArtifacts() { return new Map([['artifact-source-a', source]]) },
        async findCurrent() { return { artifactId: 'artifact-output', revision: assetRightsRevision('artifact-output', 1), snapshot: output } },
        async setCurrent() { throw new Error('explicit output rights must never be overwritten') },
      },
      clock: () => new Date('2026-08-12T13:00:00.000Z'),
    })
    const result = await service(raw)
    assert.equal(result.status, writes ? 'cataloged' : 'ignored')
    assert.equal(writes, output.allowedUses.length === 1 && output.status === 'approved' ? 1 : 0)
  }
})
