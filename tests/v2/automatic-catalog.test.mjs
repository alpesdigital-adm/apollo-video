import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogApprovedOutput } from '../../src/v2/application/catalog-approved-output.ts'

const output = (overrides = {}) => ({ workspaceId: 'ws', artifactId: 'art', manifestId: 'm1', kind: 'final', promotionStatus: 'approved', parentArtifactIds: ['raw'], generation: { provider: 'fake', model: 'v1' }, rights: { status: 'eligible', consentStatus: 'granted', snapshotId: 'rights-7' }, ...overrides })
const repository = () => { const map = new Map(); return { map, findByKey: async (key) => map.get(key) ?? null, save: async (key, value) => (map.set(key, value), value) } }

test('T-FR-049 catalogs approved outputs idempotently with inherited rights and lineage', async () => {
  const repo = repository()
  const first = await catalogApprovedOutput(output(), repo)
  const replay = await catalogApprovedOutput(output(), repo)
  assert.equal(first.status, 'cataloged')
  assert.equal(replay.status, 'already-cataloged')
  assert.equal(repo.map.size, 1)
  assert.deepEqual(first.item.rights, output().rights)
  assert.deepEqual(first.item.lineage, { relation: 'generated-from', parents: ['raw'], generation: { provider: 'fake', model: 'v1' } })
})

test('T-FR-049 never indexes temporary, failed or rejected outputs', async () => {
  const repo = repository()
  for (const candidate of [output({ kind: 'temporary' }), output({ promotionStatus: 'failed' }), output({ promotionStatus: 'rejected' })]) assert.equal((await catalogApprovedOutput(candidate, repo)).status, 'ignored')
  assert.equal(repo.map.size, 0)
  assert.equal((await catalogApprovedOutput(output({ kind: 'deepfake-raw', artifactId: 'raw-avatar' }), repo)).item.searchableKind, 'segment')
})
