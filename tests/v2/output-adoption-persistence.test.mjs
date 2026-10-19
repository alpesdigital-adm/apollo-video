import assert from 'node:assert/strict'
import test from 'node:test'

import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { readAdoptableObservationsV3 } from '../../src/v2/infrastructure/prisma/output-adoptable-observations.ts'
import { assertAdoptedObservationsCurrentV3 } from '../../src/v2/infrastructure/prisma/output-version-materializer.ts'
import { ingestedRecordings, recompiledChild, rightsEvidenceFor } from './helpers/output-world.mjs'

/**
 * The persistence side of adoption without a database: what the repository reads to OFFER a recording's receipt, and
 * what the commit transaction re-checks (under lock, before any rights read) before a Version that adopted it is
 * written. The SQL guard that checks the same facts again at COMMIT is covered by the PostgreSQL suite.
 */
const SLUGS = ['cam-a', 'cam-b', 'master']
let worldPromise
const world = () => (worldPromise ??= ingestedRecordings(SLUGS))

function cutOver(w, slugs) {
  return (plan) => {
    const audio = w.names('master').sourceArtifactId
    const clips = slugs.map((slug, index) => ({
      id: `clip-persist-${index + 1}`, sourceArtifactId: w.names(slug).sourceArtifactId, audioSourceArtifactId: audio,
      sourceInFrame: index * 30, sourceOutFrame: index * 30 + 30, timelineInFrame: index * 30, timelineOutFrame: index * 30 + 30, rate: 1,
    }))
    const ids = [...new Set([...slugs.map((slug) => w.names(slug).sourceArtifactId), audio])]
    return { ...plan, durationFrames: clips.length * 30, videoTracks: [{ ...plan.videoTracks[0], clips }], subtitleTracks: [],
      sources: ids.map((id) => ({ id, artifactId: id, kind: 'video', durationSeconds: 2 })), lineageRefs: ids }
  }
}

/** A transaction double that answers exactly the statements the two helpers issue, and records their order. */
function fakeStore(w, { receipts = w.receipts, artifacts } = {}) {
  const calls = []
  const rows = [...receipts.values()]
  const artifactRows = artifacts ?? [...receipts.entries()].map(([slug, receipt]) => ({
    id: w.names(slug).sourceArtifactId, workspaceId: receipt.document.workspaceId, rightsRevision: rightsEvidenceFor(slug).revision,
    currentRightsSnapshot: { id: rightsEvidenceFor(slug).snapshotId, snapshotHash: rightsEvidenceFor(slug).snapshotHash },
  }))
  return {
    calls,
    async $queryRawUnsafe(sql, ...params) {
      calls.push(['sql', sql.replace(/\s+/g, ' ').slice(0, 70), params])
      if (sql.startsWith('SELECT "sourceArtifactId","derivativeArtifactId" FROM output_normalization_receipts')) {
        const ids = params.slice(2)
        return ids.map((id) => rows.find((r) => r.document.id === id)).filter(Boolean)
          .map((r) => ({ sourceArtifactId: r.document.source.artifactId, derivativeArtifactId: r.document.derivative.artifactId }))
      }
      if (sql.startsWith('SELECT id FROM media_artifacts')) return params.slice(1).map((id) => ({ id }))
      if (sql.startsWith('SELECT id,"receiptJson","receiptHash" FROM output_normalization_receipts')) {
        return params.slice(2).map((id) => rows.find((r) => r.document.id === id)).filter(Boolean)
          .map((r) => ({ id: r.document.id, receiptJson: serializeOutputCanonicalJson(r.document), receiptHash: r.receiptHash }))
      }
      if (sql.startsWith('SELECT 1 AS verified FROM w66_assert_normalization_v3')) return [{ verified: 1 }]
      if (sql.startsWith('SELECT id,"sourceArtifactId" FROM output_normalization_receipts')) {
        const wanted = params.slice(2)
        return rows.filter((r) => wanted.includes(r.document.source.artifactId)).map((r) => ({ id: r.document.id, sourceArtifactId: r.document.source.artifactId }))
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 80)}`)
    },
    v2MediaArtifact: {
      async findMany({ where }) {
        calls.push(['findMany', where.id.in])
        return artifactRows.filter((row) => where.id.in.includes(row.id))
      },
    },
  }
}

async function adopted() {
  const w = await world()
  const bundle = recompiledChild(w.parent, w.actor, cutOver(w, ['cam-a', 'cam-b']), { suffix: 'persist-adopt', adoptable: w.adoptable })
  return { w, bundle }
}

test('the commit re-reads every adopted receipt under lock and finds the rights it was sealed under', async () => {
  const { w, bundle } = await adopted()
  const store = fakeStore(w)
  await assert.doesNotReject(() => assertAdoptedObservationsCurrentV3(store, bundle))
  const lock = store.calls.findIndex((call) => call[0] === 'sql' && call[1].startsWith('SELECT id FROM media_artifacts'))
  const rights = store.calls.findIndex((call) => call[0] === 'findMany')
  assert.ok(lock >= 0 && rights > lock, 'artifacts are locked before their rights are read')
  const locked = store.calls[lock][2].slice(1)
  assert.deepEqual([...locked], [...locked].sort(), 'artifacts are locked in C order')
})

test('a Version that adopted nothing costs the commit no read', async () => {
  const w = await world()
  const none = recompiledChild(w.parent, w.actor, (plan) => structuredClone(plan), { suffix: 'persist-none', adoptable: w.adoptable })
  const store = fakeStore(w)
  await assertAdoptedObservationsCurrentV3(store, none)
  assert.deepEqual(store.calls, [])
})

test('rights that moved since the Command was sealed make it a stale Command', async () => {
  const { w, bundle } = await adopted()
  const moved = (change) => [...w.receipts.entries()].map(([slug, receipt]) => {
    const evidence = rightsEvidenceFor(slug)
    return { id: w.names(slug).sourceArtifactId, workspaceId: receipt.document.workspaceId, rightsRevision: evidence.revision,
      currentRightsSnapshot: { id: evidence.snapshotId, snapshotHash: evidence.snapshotHash },
      ...(w.names(slug).sourceArtifactId === 'artifact-cam-b' ? change : {}) }
  })
  for (const [label, change] of [
    ['another snapshot', { currentRightsSnapshot: { id: 'rights-newer', snapshotHash: rightsEvidenceFor('cam-b').snapshotHash } }],
    ['another seal', { currentRightsSnapshot: { id: rightsEvidenceFor('cam-b').snapshotId, snapshotHash: 'f'.repeat(64) } }],
    ['another revision', { rightsRevision: 2 }],
    ['no current snapshot', { currentRightsSnapshot: null }],
  ]) {
    await assert.rejects(() => assertAdoptedObservationsCurrentV3(fakeStore(w, { artifacts: moved(change) }), bundle),
      (error) => error.code === 'VERSION_CONFLICT' && error.details.artifactId === 'artifact-cam-b', label)
  }
})

test('an adopted receipt that is not the persisted one is refused', async () => {
  const { w, bundle } = await adopted()
  const missing = new Map([...w.receipts].filter(([slug]) => slug !== 'cam-a'))
  await assert.rejects(() => assertAdoptedObservationsCurrentV3(fakeStore(w, { receipts: missing }), bundle), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const altered = new Map(w.receipts)
  altered.set('cam-a', { ...w.receipts.get('cam-a'), receiptHash: 'f'.repeat(64) })
  await assert.rejects(() => assertAdoptedObservationsCurrentV3(fakeStore(w, { receipts: altered }), bundle), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('the repository offers only the requested sources, verified, with the rights evidence of each', async () => {
  const w = await world()
  const store = fakeStore(w)
  const offered = await readAdoptableObservationsV3(store, { workspaceId: w.parent.version.workspaceId, projectId: w.parent.version.projectId,
    sourceArtifactIds: ['artifact-cam-a', 'artifact-cam-a'] })
  assert.deepEqual(offered.map((offer) => offer.normalization.document.source.artifactId), ['artifact-cam-a'])
  assert.equal(offered[0].normalization.receiptHash, w.receipts.get('cam-a').receiptHash)
  assert.deepEqual(offered[0].rights, rightsEvidenceFor('cam-a'))
  const selection = store.calls.find((call) => call[0] === 'sql' && call[1].startsWith('SELECT id,"sourceArtifactId" FROM output_normalization_receipts'))
  assert.deepEqual(selection[2].slice(2), ['artifact-cam-a'], 'a source is requested once')

  const unrighted = fakeStore(w, { artifacts: [{ id: 'artifact-cam-b', workspaceId: w.parent.version.workspaceId, rightsRevision: 0, currentRightsSnapshot: null }] })
  const [bare] = await readAdoptableObservationsV3(unrighted, { workspaceId: w.parent.version.workspaceId, projectId: w.parent.version.projectId,
    sourceArtifactIds: ['artifact-cam-b'] })
  assert.equal(bare.rights, null, 'a source with no current rights is offered without evidence, and the transition refuses it')

  const nothing = fakeStore(w)
  assert.deepEqual(await readAdoptableObservationsV3(nothing, { workspaceId: 'workspace-x', projectId: 'project-x', sourceArtifactIds: [] }), [])
  assert.deepEqual(nothing.calls, [], 'nothing requested, nothing read')
  assert.deepEqual(await readAdoptableObservationsV3(fakeStore(w), { workspaceId: w.parent.version.workspaceId, projectId: w.parent.version.projectId,
    sourceArtifactIds: ['artifact-never-ingested'] }), [])
})
