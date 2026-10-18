import assert from 'node:assert/strict'
import test from 'node:test'

import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { PrismaEditorialCommandRepository } from '../../src/v2/infrastructure/prisma/editorial-command-repository.ts'
import { twoOutputIngestedWorld } from './helpers/m1b-two-output-world.mjs'
import { persistedOutputQueries } from './helpers/persisted-output-client.mjs'

/**
 * An editorial cut changes the ONE EditPlan every output of a project re-materializes from: it makes the renders of EVERY output stale,
 * proxies and published finals alike, each under its own stable variant. `variantId` is the VIEW the cut was made on.
 *
 * The cut's admission context is read here against a client that answers the sealed reads (no database): every render of the head is
 * attributed to the output it was enqueued for, a published final no longer refuses the cut, a render that cannot be attributed
 * exactly is a conflict, and the source inventory of a cut of the project itself lists its editorial sources, never the links of the
 * renders it makes stale. The same cut against a real PostgreSQL (proxies of both outputs, the database guards) is
 * multi-output-plan-commands.pg.integration.mjs; the unit-level cut over a double repository is apply-editorial-cut-command.test.mjs.
 */
const two = await twoOutputIngestedWorld({ sourceDurationSeconds: 6 })
const head = two.parent
const { workspaceId, projectId } = head.version
const WIDE = two.wideVariantId
const VERTICAL = two.verticalVariantId
const BOTH = [WIDE, VERTICAL].toSorted()

const transcriptRow = {
  id: two.names.transcriptId, workspaceId, projectId, sourceArtifactId: two.names.sourceArtifactId, sourceManifestId: two.names.sourceManifestId,
  transcriptJson: stableSerialize(two.transcript), transcriptHash: two.transcript.transcriptHash, createdAt: new Date('2026-10-14T12:00:02.000Z'),
}
/** The source links of the world (source master and editing proxy), and the links the renders of the head leave behind. */
const sourceLinks = two.refs.map((ref) => ({ id: ref.sourceLinkId, artifactId: ref.artifactId, role: ref.role }))
const renderLinks = [
  { id: 'link-render-proxy-wide', artifactId: 'artifact-proxy-wide', role: 'editorial-proxy' },
  { id: 'link-render-proxy-vertical', artifactId: 'artifact-proxy-vertical', role: 'editorial-proxy' },
  { id: 'link-render-final-wide', artifactId: 'artifact-final-wide', role: 'final-output' },
]
const artifactRows = new Map(two.refs.map((ref) => [ref.artifactId, { id: ref.artifactId, sha256: ref.artifactSha256, currentRightsSnapshotId: null, currentRightsSnapshot: null, rightsRevision: 0 }]))

function repositoryWith({ proxies, finals, links = [...sourceLinks, ...renderLinks] }) {
  return new PrismaEditorialCommandRepository({
    $queryRawUnsafe: persistedOutputQueries(two.chain),
    v2Project: { async findFirst() { return { id: projectId, workspaceId, status: 'draft', currentVersionId: head.version.id } } },
    v2MediaTranscript: { async findFirst() { return transcriptRow } },
    v2ProjectMediaAsset: { async findMany() { return links } },
    v2MediaArtifact: { async findFirst({ where }) { return artifactRows.get(where.id) ?? null } },
    v2ProjectProxyRenderOperation: { async findMany() { return proxies } },
    v2ProjectFinalExportOperation: { async findMany() { return finals } },
  })
}
const read = (repository, variantId = VERTICAL) => repository.readContext({ workspaceId, projectId, transcriptId: two.names.transcriptId, variantId })
const proxies = [{ outputArtifactId: 'artifact-proxy-wide', outputVariantId: WIDE }, { outputArtifactId: 'artifact-proxy-vertical', outputVariantId: VERTICAL }]
const finals = [{ outputArtifactId: 'artifact-final-wide', outputVariantId: WIDE, outputAspectRatio: '16:9' },
  // written before the column existed: it names its ratio, which is the 9:16 output's alone
  { outputArtifactId: 'artifact-final-vertical', outputVariantId: null, outputAspectRatio: '9:16' }]
const refusal = (reason) => (error) => error.code === 'PRECONDITION_REQUIRED' && error.details?.reason === reason

test('W66 multi-output the cut context lists the proxies AND the published finals of every output, each under its own output', async () => {
  const context = await read(repositoryWith({ proxies, finals }))
  assert.equal(context.variantId, VERTICAL, 'the view the cut is made on')
  assert.deepEqual(context.outputReferences.map((item) => [item.kind, item.artifactId, item.variantId, item.sourceVersionId]), [
    ['final', 'artifact-final-vertical', VERTICAL, head.version.id], ['final', 'artifact-final-wide', WIDE, head.version.id],
    ['proxy', 'artifact-proxy-vertical', VERTICAL, head.version.id], ['proxy', 'artifact-proxy-wide', WIDE, head.version.id],
  ])
  // The cut is plan-wide: the context offers every State output, so the impact the service seals names them all.
  assert.deepEqual(context.parent.state.document.entries.map((entry) => entry.variantId).toSorted(), BOTH)
  assert.deepEqual(context.normalizations.map((normalization) => normalization.document.source.artifactId), [two.names.sourceArtifactId])
})

test('W66 multi-output the source inventory of a cut of the project itself lists its editorial sources, not the links of the renders it makes stale', async () => {
  const context = await read(repositoryWith({ proxies, finals }))
  assert.deepEqual(context.sourceBindingFacts.inventory.map((item) => [item.linkId, item.role]).toSorted(),
    sourceLinks.map((link) => [link.id, link.role]).toSorted())
  assert.ok(context.sourceBindingFacts.inventory.every((item) => item.role !== 'editorial-proxy' && item.role !== 'final-output'))
  assert.equal(context.sourceBindingFacts.authority.kind, 'same-project-state3')
})

test('W66 multi-output a cut names an output of its State as its view, or is refused with the published reason', async () => {
  const repository = repositoryWith({ proxies, finals })
  for (const variantId of ['variant-m1b-stranger', '9:16', '16:9']) await assert.rejects(read(repository, variantId), refusal('output-variant-unknown'), variantId)
})

test('W66 multi-output a render that cannot be attributed exactly refuses the cut instead of being guessed', async () => {
  const conflict = (error) => error.code === 'PERSISTENCE_CONFLICT'
  // a proxy written before the column existed belongs to neither of two outputs
  await assert.rejects(read(repositoryWith({ proxies: [{ outputArtifactId: 'artifact-proxy-legacy', outputVariantId: null }], finals: [] })), conflict)
  // a final whose ratio matches no output, and a render naming an output the State does not carry
  await assert.rejects(read(repositoryWith({ proxies: [], finals: [{ outputArtifactId: 'artifact-final-odd', outputVariantId: null, outputAspectRatio: '4:5' }] })), conflict)
  await assert.rejects(read(repositoryWith({ proxies: [{ outputArtifactId: 'artifact-proxy-stranger', outputVariantId: 'variant-m1b-stranger' }], finals: [] })), conflict)
})
