import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { exportProjectSubtitleSidecarService } from '../../src/v2/application/export-subtitle-sidecar.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PUBLISHED_CONSUMPTION_REASONS } from '../../src/v2/domain/output-consumption.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { requireCriticOutputConsumption } from '../../src/v2/infrastructure/prisma/critic-output-consumption.ts'
import { PrismaProjectWorkspaceQueryRepository } from '../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts'
import { PrismaQualityIterationRepository } from '../../src/v2/infrastructure/prisma/quality-iteration-repository.ts'
import { PrismaReviewAnnotationRepository, readReviewPreviewAvailability, readReviewPreviewContext } from '../../src/v2/infrastructure/prisma/review-annotation-repository.ts'
import { PrismaSubtitleSidecarRepository } from '../../src/v2/infrastructure/prisma/subtitle-sidecar-repository.ts'
import { blockedEntry, fakeTable, historicalVersion, materializedEntry, ownSpec, previewArtifact, previewProject, proxyRenders, proxyReviewRow,
  renderElementMapRow, sha, stateClient, storedState, withRow } from './helpers/output-consumption-readers-fakes.mjs'

/**
 * The readers that critique or describe the output of a Version (sidecar alignment, review preview and annotation, quality iteration,
 * workspace read) take their verdict from the one persisted consumption reader: the sealed State of the exact Version they are asked
 * about, the entry of the exact variant, the purpose. These tests stand a fake in for the database, answering only the reader's query
 * with canonical sealed rows, and prove each consumer's refusals and answers (the real bundles are proven by
 * output-consumption-readers.pg.integration.mjs against PostgreSQL).
 */
const W = 'workspace-readers', P = 'project-readers', V1 = 'version-readers-1', V2 = 'version-readers-2'
const state = (versionId, entries, extra = {}) => storedState({ workspaceId: W, projectId: P, versionId, entries, ...extra })
const refusedWith = (reason) => (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === reason
const single = (versionId) => state(versionId, [materializedEntry('variant-a')])
const twoOutputs = (versionId) => state(versionId, [materializedEntry('variant-a', { aspectRatio: '9:16' }), materializedEntry('variant-b', { aspectRatio: '16:9' })])
const neverCut = (versionId) => state(versionId, [blockedEntry('variant-a')])
const forkRoot = (versionId) => state(versionId, [blockedEntry('variant-a')], { contract: 2, reasons: ['fork-target-materialization-required'] })
const cutCopy = (versionId) => state(versionId, [materializedEntry('variant-a', { derived: true })], { sourceDependencies: { forkDerivationId: 'derivation-1' } })
const creationEmpty = (versionId) => state(versionId, [], { contract: 2, reasons: ['empty-project'] })

// ===== the shared critic admission =====

test('the critic admission answers the format the sealed entry carries; an output with no format is refused with a published reason', async () => {
  const client = stateClient([single(V1), state(V2, [materializedEntry('variant-a', { spec: ownSpec(undefined) })])])
  const admitted = await requireCriticOutputConsumption(client, { workspaceId: W, projectId: P, versionId: V1 })
  assert.equal(admitted.formatId, '9:16')
  assert.equal(admitted.seal.purpose, 'critic')
  assert.equal(admitted.seal.projectVersionId, V1)
  assert.match(admitted.sealHash, /^[0-9a-f]{64}$/)
  await assert.rejects(() => requireCriticOutputConsumption(client, { workspaceId: W, projectId: P, versionId: V2 }), refusedWith('output-not-consumable'))
  // An explicit variant names the output of a State with several; the one an unknown variant names is refused.
  const several = stateClient([twoOutputs(V1)])
  assert.equal((await requireCriticOutputConsumption(several, { workspaceId: W, projectId: P, versionId: V1, variantId: 'variant-b' })).formatId, '16:9')
  await assert.rejects(() => requireCriticOutputConsumption(several, { workspaceId: W, projectId: P, versionId: V1 }), refusedWith('output-variant-required'))
  await assert.rejects(() => requireCriticOutputConsumption(several, { workspaceId: W, projectId: P, versionId: V1, variantId: 'variant-z' }), refusedWith('output-variant-unknown'))
})

// ===== sidecar alignment =====

const plan = { contentHash: sha('d'), contentJson: JSON.stringify({ subtitleTracks: [{ cues: [{ id: 'cue-1', text: 'Ação' }] }] }) }
/**
 * `proxies` / `finals` are the succeeded renders. A bare version id (or a final without `variantId`) is a LEGACY row written before the
 * render named its output (it belongs to an output only when that is exact); an object names the stable State variant it was made for.
 */
function sidecarWorld({ stored, versions = [V1], currentVersionId = versions[0], finals = [], proxies = versions, workspaceId = W }) {
  const reader = stateClient(stored)
  const render = (projectVersionId, extra = {}) => ({ workspaceId: W, projectId: P, projectVersionId, outputArtifactId: 'artifact-render', outputManifestId: 'manifest-render',
    inputHash: sha('9'), editPlanSnapshotId: 'plan-1', editPlanSnapshot: plan, createdAt: new Date('2026-10-12T12:00:00.000Z'), outputVariantId: null, ...extra })
  const proxyRows = proxies.map((entry) => typeof entry === 'string' ? render(entry)
    : render(entry.versionId, { outputVariantId: entry.variantId, outputArtifactId: entry.artifactId ?? 'artifact-render', outputManifestId: `manifest-${entry.artifactId ?? 'render'}` }))
  const finalRows = finals.map(({ versionId, aspectRatio, variantId = null, artifactId = 'artifact-render' }) =>
    render(versionId, { outputAspectRatio: aspectRatio, outputVariantId: variantId, outputArtifactId: artifactId }))
  const artifactIds = [...new Set([...proxyRows, ...finalRows].map((row) => row.outputArtifactId))]
  const client = {
    ...reader,
    v2Project: fakeTable([{ id: P, workspaceId: W, currentVersionId }]),
    v2ProjectVersion: fakeTable(versions.map((id, index) => ({ id, workspaceId: W, projectId: P, sequence: versions.length - index }))),
    v2ProjectFinalExportOperation: fakeTable(finalRows),
    v2ProjectProxyRenderOperation: fakeTable(proxyRows),
    v2MediaArtifact: fakeTable(artifactIds.map((id) => ({ id, workspaceId: W, artifactKey: `renders/${id}.mp4`, sha256: sha('e'), status: 'available' }))),
    v2RenderElementMap: fakeTable(versions.flatMap((projectVersionId) => artifactIds.map((artifactId) => ({ ...renderElementMapRow({ id: `map-${artifactId}`, proxyHash: sha('e') }),
      workspaceId: W, projectId: P, projectVersionId, proxyArtifactId: artifactId })))),
  }
  // `variantId` is the stable State variant of the output aligned (variant-a is the 9:16 output of every single-output State here).
  const read = (input = {}) => new PrismaSubtitleSidecarRepository(client).readRenderedAlignment({ workspaceId, projectId: P, variantId: 'variant-a', ...input })
  return { client, reader, read }
}

test('sidecar: the alignment of a single-output Version is admitted for render and sealed; the variant asked is the stable State variant', async () => {
  const world = sidecarWorld({ stored: [single(V1)] })
  const alignment = await world.read()
  assert.equal(alignment.variantId, 'variant-a')
  assert.equal(alignment.outputKind, 'proxy')
  assert.equal(alignment.projectVersionId, V1)
  assert.equal(alignment.outputConsumption.render.seal.purpose, 'render')
  assert.equal(alignment.outputConsumption.render.seal.projectVersionId, V1)
  assert.equal(alignment.outputConsumption.render.seal.variantId, 'variant-a')
  assert.equal(alignment.outputConsumption.final, undefined)
  // The project's format is not consulted and no variant is invented: a name that is no member of the State (an aspect ratio, a
  // stranger) is refused with the published reason.
  await assert.rejects(() => world.read({ variantId: '9:16' }), refusedWith('output-variant-unknown'))
  await assert.rejects(() => world.read({ variantId: 'variant-z' }), refusedWith('output-variant-unknown'))
  assert.deepEqual([...new Set(world.reader.reads)], [V1])
})

test('sidecar: the stable State variant names the output and the render of THAT output is the evidence', async () => {
  const world = sidecarWorld({ stored: [twoOutputs(V1)], proxies: [
    { versionId: V1, variantId: 'variant-a', artifactId: 'artifact-render-a' }, { versionId: V1, variantId: 'variant-b', artifactId: 'artifact-render-b' }] })
  const wide = await world.read({ variantId: 'variant-b' })
  assert.equal(wide.variantId, 'variant-b')
  assert.equal(wide.outputConsumption.render.seal.variantId, 'variant-b')
  assert.equal(wide.outputArtifactId, 'artifact-render-b', 'the 16:9 output aligns its own proxy')
  assert.equal((await world.read({ variantId: 'variant-a' })).outputArtifactId, 'artifact-render-a', 'and the 9:16 output its own')
  await assert.rejects(() => world.read({ variantId: 'variant-z' }), refusedWith('output-variant-unknown'))
  await assert.rejects(() => world.read({ variantId: '16:9' }), refusedWith('output-variant-unknown'))
})

test('sidecar: a final export is also admitted for final, and its seal is separate from the render seal', async () => {
  const world = sidecarWorld({ stored: [single(V1)], finals: [{ versionId: V1, aspectRatio: '9:16', variantId: 'variant-a' }] })
  const alignment = await world.read()
  assert.equal(alignment.outputKind, 'final')
  assert.equal(alignment.outputConsumption.final.seal.purpose, 'final')
  assert.notEqual(alignment.outputConsumption.final.sealHash, alignment.outputConsumption.render.sealHash)
})

test('sidecar: a cut copy aligns its proxy, but a final export of it is refused until the target owns perception authority', async () => {
  const proxyOnly = sidecarWorld({ stored: [cutCopy(V1)] })
  assert.equal((await proxyOnly.read()).outputKind, 'proxy')
  const exported = sidecarWorld({ stored: [cutCopy(V1)], finals: [{ versionId: V1, aspectRatio: '9:16', variantId: 'variant-a' }] })
  await assert.rejects(() => exported.read(), refusedWith('derived-source-perception-authority-required'))
  // A final written before renders named their output belongs to the output carrying its aspect ratio, when that is exact.
  const legacyFinal = sidecarWorld({ stored: [single(V1)], finals: [{ versionId: V1, aspectRatio: '9:16' }] })
  assert.equal((await legacyFinal.read()).outputKind, 'final')
  const otherRatio = sidecarWorld({ stored: [single(V1)], finals: [{ versionId: V1, aspectRatio: '16:9' }] })
  assert.equal((await otherRatio.read()).outputKind, 'proxy', 'a final of another ratio is no evidence for this output')
})

test('sidecar: a never-cut copy, a Creation fork root and a project without outputs are refused with the published reason, before any artifact is read', async () => {
  for (const [label, stored, reason] of [['never-cut copy', neverCut(V1), 'copy-requires-editorial-cut'], ['Creation fork root', forkRoot(V1), 'copy-requires-editorial-cut'],
    ['no outputs', creationEmpty(V1), 'empty-project']]) {
    const world = sidecarWorld({ stored: [stored] })
    let artifactReads = 0
    const read = world.client.v2MediaArtifact.findFirst
    world.client.v2MediaArtifact.findFirst = async (...args) => { artifactReads++; return read(...args) }
    await assert.rejects(() => world.read(), refusedWith(reason), label)
    assert.equal(artifactReads, 0, label)
  }
})

test('sidecar: several outputs are told apart by their stable variant; another output\'s render is no evidence; two outputs with one ratio are refused as ambiguous', async () => {
  const world = sidecarWorld({ stored: [twoOutputs(V1)], proxies: [{ versionId: V1, variantId: 'variant-a', artifactId: 'artifact-render-a' }],
    finals: [{ versionId: V1, aspectRatio: '9:16', variantId: 'variant-a', artifactId: 'artifact-final-a' }] })
  const vertical = await world.read({ variantId: 'variant-a' })
  assert.equal(vertical.outputKind, 'final')
  assert.equal(vertical.outputArtifactId, 'artifact-final-a')
  // The 16:9 output has no render of its own: the 9:16 output's proxy and final are not its alignment.
  assert.equal(await world.read({ variantId: 'variant-b' }), null)
  await assert.rejects(() => world.read({ variantId: '1:1' }), refusedWith('output-variant-unknown'))
  const twins = sidecarWorld({ stored: [state(V1, [materializedEntry('variant-a'), materializedEntry('variant-b')])] })
  await assert.rejects(() => twins.read({ variantId: 'variant-a' }), refusedWith('output-variant-ambiguous'))
  await assert.rejects(() => twins.read({ variantId: 'variant-b' }), refusedWith('output-variant-ambiguous'))
  // A legacy proxy (no output named) cannot be attributed in a Version with several outputs: it is no evidence for either.
  const legacy = sidecarWorld({ stored: [twoOutputs(V1)] })
  assert.equal(await legacy.read({ variantId: 'variant-a' }), null)
  assert.equal(await legacy.read({ variantId: 'variant-b' }), null)
})

test('sidecar: an older Version answers about that Version only, never about the head that superseded it', async () => {
  const world = sidecarWorld({ stored: [single(V1), twoOutputs(V2)], versions: [V2, V1], currentVersionId: V2, proxies: [V1, { versionId: V2, variantId: 'variant-b' }] })
  const older = await world.read({ projectVersionId: V1 })
  assert.equal(older.projectVersionId, V1)
  assert.equal(older.isCurrentVersion, false)
  assert.equal(older.outputConsumption.render.seal.projectVersionId, V1)
  assert.deepEqual([...new Set(world.reader.reads)], [V1], 'the head State was never read')
  // The head carries a 16:9 output (variant-b) the older Version never had.
  await assert.rejects(() => world.read({ projectVersionId: V1, variantId: 'variant-b' }), refusedWith('output-variant-unknown'))
  assert.equal((await world.read({ projectVersionId: V2, variantId: 'variant-b' })).isCurrentVersion, true)
})

test('sidecar: a Version of another project or workspace is not answered, and its State is never read', async () => {
  const foreign = storedState({ workspaceId: W, projectId: 'project-sister', versionId: 'version-sister', entries: [materializedEntry('variant-a')] })
  const world = sidecarWorld({ stored: [single(V1), foreign] })
  assert.equal(await world.read({ projectVersionId: 'version-sister' }), null)
  assert.equal(world.reader.reads.length, 0)
  assert.equal(await sidecarWorld({ stored: [single(V1)], workspaceId: 'workspace-sister' }).read(), null)
})

test('sidecar: a State that fails its seal is an integrity failure, not an answer', async () => {
  const forged = sidecarWorld({ stored: [withRow(single(V1), { stateHash: sha('f') })] })
  await assert.rejects(() => forged.read(), (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  const unsealed = sidecarWorld({ stored: [historicalVersion({ workspaceId: W, projectId: P, versionId: V1 })] })
  await assert.rejects(() => unsealed.read(), refusedWith('output-not-consumable'))
})

const actor = Object.freeze({ clientId: 'client-readers', credentialId: 'credential-readers', workspaceId: W, environment: 'production', scopes: new Set(['projects:write']),
  authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active',
  auditContext: { clientId: 'client-readers', credentialId: 'credential-readers', workspaceId: W, environment: 'production', actor: { type: 'api-client', id: 'client-readers' } } })

test('sidecar export: a rendered artifact whose checksum moved is refused as before, and a refused Version never reaches the artifact store', async () => {
  const lookups = []
  const exporter = (world, artifact) => exportProjectSubtitleSidecarService({ sidecars: new PrismaSubtitleSidecarRepository(world.client),
    artifacts: { async findById(workspaceId, artifactId) { lookups.push(artifactId); return artifact }, async findColorProbe() { return null } },
    persistence: {}, storage: {}, staging: {} })
  const request = { workspaceId: W, actor, projectId: P, variantId: 'variant-a', format: 'srt', idempotencyKey: 'idem-readers-1' }
  const rendered = { id: 'artifact-render', workspaceId: W, artifactKey: 'renders/out.mp4', status: 'available', mediaType: 'video',
    manifests: [{ id: 'manifest-render', recipe: { id: 'editorial-proxy' } }] }
  await assert.rejects(() => exporter(sidecarWorld({ stored: [single(V1)] }), { ...rendered, sha256: sha('f') })(request),
    (error) => error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH' && /no longer matches/.test(error.message))
  assert.deepEqual(lookups, ['artifact-render'])
  await assert.rejects(() => exporter(sidecarWorld({ stored: [neverCut(V1)] }), { ...rendered, sha256: sha('e') })(request), refusedWith('copy-requires-editorial-cut'))
  assert.deepEqual(lookups, ['artifact-render'], 'the refusal came before the artifact lookup')
})

// ===== review preview and annotation =====

const artifact = previewArtifact({ workspaceId: W })
const artifactB = previewArtifact({ workspaceId: W, artifactId: 'artifact-preview-b' })
/** `proxies` overrides the renders (default: one LEGACY proxy per Version, written before renders named their output). */
function previewWorld({ stored, versions = [V1], currentVersionId = versions[0], project, proxies }) {
  const reader = stateClient(stored)
  const row = project ?? previewProject({ projectId: P, workspaceId: W, versions: versions.map((id) => ({ id })), currentVersionId })
  const client = {
    ...reader,
    v2Project: fakeTable([row]),
    v2ProjectFinalExportOperation: fakeTable([]),
    v2ProjectProxyRenderOperation: fakeTable(proxies ?? proxyRenders({ workspaceId: W, projectId: P, versionIds: versions })),
    v2ProjectMediaAsset: fakeTable([]),
    v2MediaArtifact: { async findFirst({ where }) { return [artifact, artifactB].find((candidate) => candidate.id === where.id) ?? null } },
  }
  return { client, reader, preview: (input = {}) => readReviewPreviewContext(client, { workspaceId: W, projectId: P, ...input }),
    availability: (input = {}) => readReviewPreviewAvailability(client, { workspaceId: W, projectId: P, ...input }) }
}

test('review preview: the format is the ratio the sealed entry carries, the scope counts follow it and the admission is sealed for critic', async () => {
  const world = previewWorld({ stored: [single(V1)] })
  const context = await world.preview()
  assert.equal(context.formatId, '9:16')
  assert.equal(context.variantId, 'variant-a', 'the preview names the stable variant of the output it is about')
  assert.deepEqual([...context.variantIds], ['variant-a'])
  assert.equal(context.availableScopeCounts.formats, 1)
  assert.equal(context.outputConsumption.seal.purpose, 'critic')
  assert.equal(context.outputConsumption.seal.projectVersionId, V1)
  assert.equal(context.outputConsumption.seal.variantId, 'variant-a')
  // The availability read model describes the same proxy and admits nothing.
  const availability = await world.availability()
  assert.deepEqual(availability, Object.fromEntries(Object.keys(availability).map((key) => [key, context[key]])))
  assert.equal('formatId' in availability, false)
  assert.equal('variantId' in availability, false)
})

test('review preview: an explicit variant names the output of a State with several and the proxy is the one made for it; an unknown one is refused', async () => {
  const proxies = [...proxyRenders({ workspaceId: W, projectId: P, versionIds: [V1], artifactId: artifact.id, variantId: 'variant-a' }),
    ...proxyRenders({ workspaceId: W, projectId: P, versionIds: [V1], artifactId: artifactB.id, variantId: 'variant-b' })]
  const world = previewWorld({ stored: [twoOutputs(V1)], proxies })
  const wide = await world.preview({ variantId: 'variant-b' })
  assert.equal(wide.formatId, '16:9')
  assert.equal(wide.variantId, 'variant-b')
  assert.equal(wide.proxyArtifactId, artifactB.id, 'the 16:9 preview is the 16:9 proxy')
  assert.equal(wide.outputConsumption.seal.variantId, 'variant-b')
  assert.deepEqual([...wide.variantIds], ['variant-a', 'variant-b'])
  assert.equal(wide.availableScopeCounts.formats, 2, 'a format scope can name either output')
  const vertical = await world.preview({ variantId: 'variant-a' })
  assert.equal(vertical.formatId, '9:16')
  assert.equal(vertical.proxyArtifactId, artifact.id)
  await assert.rejects(() => world.preview({ variantId: 'variant-z' }), refusedWith('output-variant-unknown'))
  await assert.rejects(() => world.preview(), refusedWith('output-variant-required'))
})

test('review preview: another output\'s proxy of the same Version is never offered, and its being current does not make this output current', async () => {
  // Only the 9:16 output has a proxy; the 16:9 output has none of its own.
  const onlyVertical = previewWorld({ stored: [twoOutputs(V1)], proxies: proxyRenders({ workspaceId: W, projectId: P, versionIds: [V1], artifactId: artifact.id, variantId: 'variant-a' }) })
  assert.equal((await onlyVertical.preview({ variantId: 'variant-a' })).stale, false)
  assert.equal(await onlyVertical.preview({ variantId: 'variant-b' }), null, 'no proxy was made for the 16:9 output')
  // The 16:9 proxy is from an older Version: the 16:9 preview is stale while the 9:16 one, rendered from the head, is not.
  const mixed = previewWorld({ stored: [twoOutputs(V2), twoOutputs(V1)], versions: [V2, V1], currentVersionId: V2, proxies: [
    ...proxyRenders({ workspaceId: W, projectId: P, versionIds: [V2], artifactId: artifact.id, variantId: 'variant-a' }),
    ...proxyRenders({ workspaceId: W, projectId: P, versionIds: [V1], artifactId: artifactB.id, variantId: 'variant-b' })] })
  const vertical = await mixed.preview({ variantId: 'variant-a' })
  assert.equal(vertical.stale, false)
  assert.equal(vertical.sourceVersionId, V2)
  const wide = await mixed.preview({ variantId: 'variant-b' })
  assert.equal(wide.stale, true, 'the 16:9 proxy was rendered from an older Version')
  assert.equal(wide.sourceVersionId, V1)
  assert.equal(wide.proxyArtifactId, artifactB.id)
})

test('review preview: a cut copy is critiqued with the geometry it was copied with', async () => {
  const copy = state(V1, [materializedEntry('variant-a', { derived: true, spec: { schemaVersion: 'output-spec-revision/v3', effectiveSpec: { output: { aspectRatio: '1:1' } } } })],
    { sourceDependencies: { forkDerivationId: 'derivation-1' } })
  assert.equal((await previewWorld({ stored: [copy] }).preview()).formatId, '1:1')
})

test('review preview: a copy no editorial cut materialized, a project without outputs, several outputs and an output with no format are refused with a published reason', async () => {
  for (const [label, stored, reason] of [['never-cut copy', neverCut(V1), 'copy-requires-editorial-cut'], ['Creation fork root', forkRoot(V1), 'copy-requires-editorial-cut'],
    ['no outputs', creationEmpty(V1), 'empty-project'], ['several outputs', twoOutputs(V1), 'output-variant-required'],
    ['no format', state(V1, [materializedEntry('variant-a', { spec: ownSpec(undefined) })]), 'output-not-consumable'],
    ['blocked entry', state(V1, [blockedEntry('variant-a', ['normalization-required'])]), 'normalization-required']]) {
    const world = previewWorld({ stored: [stored] })
    await assert.rejects(() => world.preview(), refusedWith(reason), label)
    // The same Version in the read model that only describes the proxy: the proxy exists, the consumers refuse to critique it.
    assert.equal((await world.availability()).proxyArtifactId, artifact.id, label)
  }
})

test('review preview: an older Version is previewed as that Version (stale), never as the head; a Version of another project is not found', async () => {
  const world = previewWorld({ stored: [single(V1), twoOutputs(V2)], versions: [V2, V1], currentVersionId: V2 })
  const older = await world.preview({ projectVersionId: V1 })
  assert.equal(older.projectVersionId, V1)
  assert.equal(older.currentProjectVersionId, V2)
  assert.equal(older.stale, true)
  assert.equal(older.formatId, '9:16')
  assert.deepEqual([...new Set(world.reader.reads)], [V1])
  await assert.rejects(() => world.preview({ projectVersionId: V2 }), refusedWith('output-variant-required'), 'the head has two outputs')
  const reads = world.reader.reads.length
  assert.equal(await world.preview({ projectVersionId: 'version-sister' }), null)
  assert.equal(world.reader.reads.length, reads, 'a Version that is not the project\'s is never read')
})

test('review preview: a State that fails its seal fails the read, and an unsealed historical Version is refused', async () => {
  const forged = previewWorld({ stored: [withRow(single(V1), { stateJson: single(V1).row.stateJson.replace('variant-a', 'variant-z') })] })
  await assert.rejects(() => forged.preview(), (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  const historic = previewWorld({ stored: [historicalVersion({ workspaceId: W, projectId: P, versionId: V1 })] })
  await assert.rejects(() => historic.preview(), refusedWith('output-not-consumable'))
  assert.equal((await historic.availability()).projectVersionId, V1)
})

function annotationRepository({ stored, currentVersionId = V1, variantId }) {
  const reader = stateClient(stored)
  const transaction = { ...reader,
    v2ReviewAnnotation: { async findFirst() { return null }, async create() { throw new Error('the gate must refuse before any row is written') } },
    v2Project: fakeTable([{ id: P, workspaceId: W, currentVersionId }]),
    v2MediaArtifact: { async findFirst() { return null } }, v2ProjectMediaAsset: { async findFirst() { return null } } }
  const create = (projectVersionId = V1) => new PrismaReviewAnnotationRepository({ async $transaction(callback) { return callback(transaction) } }).create({
    ...(variantId ? { variantId } : {}), workspaceId: W, projectId: P, idempotencyKey: 'idem-annotation-1', requestFingerprint: sha('1'),
    annotation: { projectVersionId, proxyArtifactId: 'artifact-preview', proxyHash: sha('a'), authenticationAudit: { contextHash: sha('2') } } })
  return { reader, create }
}

test('annotation create: the critique of a Version whose output cannot be critiqued is refused with the published reason before anything is written', async () => {
  for (const [label, stored, reason] of [['never-cut copy', neverCut(V1), 'copy-requires-editorial-cut'], ['Creation fork root', forkRoot(V1), 'copy-requires-editorial-cut'],
    ['several outputs', twoOutputs(V1), 'output-variant-required']]) {
    await assert.rejects(() => annotationRepository({ stored: [stored] }).create(), refusedWith(reason), label)
  }
  // A cut copy passes the gate; the next fence (the proxy must still be linked) is what stops this fixture.
  await assert.rejects(() => annotationRepository({ stored: [cutCopy(V1)] }).create(),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT' && /no longer available/.test(error.message))
})

test('annotation create: a State with several outputs is critiqued through the explicit variant, and an unknown variant is refused', async () => {
  await assert.rejects(() => annotationRepository({ stored: [twoOutputs(V1)], variantId: 'variant-b' }).create(),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT' && /no longer available/.test(error.message), 'the gate passed')
  await assert.rejects(() => annotationRepository({ stored: [twoOutputs(V1)], variantId: 'variant-z' }).create(), refusedWith('output-variant-unknown'))
})

test('annotation create: a stale Version conflicts before the State is read', async () => {
  const world = annotationRepository({ stored: [single(V1)], currentVersionId: V2 })
  await assert.rejects(() => world.create(V1), (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')
  assert.equal(world.reader.reads.length, 0)
})

// ===== quality iteration =====

function qualityWorld({ stored, headVersionId = V1, reviewedVersionId = V1, workspaceId = W }) {
  const reader = stateClient(stored)
  const client = { ...reader,
    v2Project: fakeTable([{ id: P, workspaceId: W, objective: 'discovery', locale: 'pt-BR', currentVersion: { id: headVersionId, baseHash: sha('c') } }]),
    v2ProxyReview: fakeTable([proxyReviewRow({ workspaceId: W, projectId: P, projectVersionId: reviewedVersionId })]),
    v2AssetSelection: fakeTable([]), v2QualityIteration: fakeTable([]), v2MediaArtifact: fakeTable([]) }
  const readContext = (input = {}) => new PrismaQualityIterationRepository(client).readContext({ workspaceId, projectId: P, projectVersionId: reviewedVersionId,
    proxyReviewId: 'proxy-review-1', assetSelectionIds: [], ...input })
  return { reader, readContext }
}

test('quality iteration: the context carries the format of the sealed output of the reviewed Version, sealed for critic', async () => {
  const world = qualityWorld({ stored: [single(V1)] })
  const context = await world.readContext()
  assert.equal(context.format, '9:16')
  assert.equal(context.projectVersionId, V1)
  assert.equal(context.outputConsumption.seal.purpose, 'critic')
  assert.equal(context.outputConsumption.seal.projectVersionId, V1)
  assert.match(context.outputConsumption.sealHash, /^[0-9a-f]{64}$/)
})

test('quality iteration: a Version whose output cannot be critiqued is refused with the published reason instead of a missing format', async () => {
  for (const [label, stored, reason] of [['never-cut copy', neverCut(V1), 'copy-requires-editorial-cut'], ['Creation fork root', forkRoot(V1), 'copy-requires-editorial-cut'],
    ['no outputs', creationEmpty(V1), 'empty-project'], ['several outputs', twoOutputs(V1), 'output-variant-required'],
    ['no format', state(V1, [materializedEntry('variant-a', { spec: ownSpec(undefined) })]), 'output-not-consumable']]) {
    await assert.rejects(() => qualityWorld({ stored: [stored] }).readContext(), refusedWith(reason), label)
  }
  assert.equal((await qualityWorld({ stored: [cutCopy(V1)] }).readContext()).format, '9:16', 'a cut copy is critiqued')
})

test('quality iteration: a State with several outputs is scored through the explicit variant', async () => {
  const world = qualityWorld({ stored: [twoOutputs(V1)] })
  const context = await world.readContext({ variantId: 'variant-b' })
  assert.equal(context.format, '16:9')
  assert.equal(context.outputConsumption.seal.variantId, 'variant-b')
  await assert.rejects(() => world.readContext({ variantId: 'variant-z' }), refusedWith('output-variant-unknown'))
  await assert.rejects(() => world.readContext(), refusedWith('output-variant-required'))
})

test('quality iteration: a review of an older Version is scored against that Version\'s State while the context still names the head, so the request is told it is stale', async () => {
  const world = qualityWorld({ stored: [single(V1), twoOutputs(V2)], headVersionId: V2, reviewedVersionId: V1 })
  const context = await world.readContext()
  assert.equal(context.projectVersionId, V2, 'the head, for the application to compare')
  assert.equal(context.format, '9:16')
  assert.equal(context.outputConsumption.seal.projectVersionId, V1)
  assert.deepEqual([...new Set(world.reader.reads)], [V1])
})

test('quality iteration: evidence of another project or workspace finds nothing and reads no State', async () => {
  const world = qualityWorld({ stored: [single(V1)] })
  assert.equal(await world.readContext({ proxyReviewId: 'proxy-review-sister' }), null)
  assert.equal(await qualityWorld({ stored: [single(V1)], workspaceId: 'workspace-sister' }).readContext(), null)
  assert.equal(world.reader.reads.length, 0)
})

// ===== workspace read =====

function workspaceWorld({ stored, versions = [V1], currentVersionId = versions[0], column = null, withRenders = true }) {
  const reader = stateClient(stored)
  const base = previewProject({ projectId: P, workspaceId: W, versions: versions.map((id) => ({ id })), currentVersionId, format: column })
  const head = currentVersionId === null ? null : { id: currentVersionId, projectId: P, workspaceId: W, sequence: 1, baseHash: sha('c'), createdAt: new Date('2026-10-12T12:00:00.000Z'),
    editPlanSnapshotId: 'plan-1', briefSnapshot: { contentJson: JSON.stringify({ productionBrief: createProductionBrief({}) }) },
    editPlanSnapshot: { contentJson: JSON.stringify({ id: 'plan-1', state: 'draft', fps: 30, durationFrames: 60, videoTracks: [] }) } }
  const project = { ...base, currentVersion: head, editCommands: [], directorRuns: [], mediaAssets: [], mediaTranscripts: [], mediaIngestOperations: [],
    proxyRenderOperations: [], finalExportOperations: [] }
  const transaction = { ...reader,
    v2Project: fakeTable([project]),
    v2ProjectFinalExportOperation: fakeTable([]),
    v2ProjectProxyRenderOperation: fakeTable(withRenders ? proxyRenders({ workspaceId: W, projectId: P, versionIds: versions }) : []),
    v2ProjectMediaAsset: fakeTable([]), v2ProxyReview: fakeTable([]),
    v2MediaArtifact: { async findFirst({ where }) { return where.id === artifact.id ? artifact : null } } }
  const repository = new PrismaProjectWorkspaceQueryRepository({ async $transaction(callback) { return callback(transaction) } })
  return { reader, read: () => repository.read({ workspaceId: W, projectId: P }) }
}

test('workspace: the project format is the ratio of the only output its head Version seals, whatever the stored column says', async () => {
  const world = workspaceWorld({ stored: [single(V1)], column: '16:9' })
  const record = await world.read()
  assert.equal(record.project.format, '9:16')
  assert.deepEqual(record.outputs, [{ variantId: 'variant-a', aspectRatio: '9:16',
    consumption: { render: { status: 'allowed' }, critic: { status: 'allowed' }, final: { status: 'allowed' } } }])
  assert.equal(record.reviewAvailability.annotations.state, 'available')
  // The column is no authority at all: a project whose head has no single output has no format, even if the column holds one.
  for (const stored of [twoOutputs(V1), creationEmpty(V1), state(V1, [])]) {
    assert.equal('format' in (await workspaceWorld({ stored: [stored], column: '16:9' }).read()).project, false)
  }
})

test('workspace: a copy no editorial cut materialized is still shown with its format; the read describes, the consumers refuse', async () => {
  for (const [label, stored] of [['configured never-cut copy', neverCut(V1)], ['Creation fork root', forkRoot(V1)]]) {
    const record = await workspaceWorld({ stored: [stored] }).read()
    assert.equal(record.project.format, '9:16', label)
    assert.equal(record.reviewAvailability.annotations.state, 'available', label)
    // The outputs list describes the refusal every consumer would publish; it never throws for a blocked entry.
    const blocked = { status: 'blocked', reason: 'copy-requires-editorial-cut' }
    assert.deepEqual(record.outputs.map((output) => output.consumption), [{ render: blocked, critic: blocked, final: blocked }], label)
  }
  const cut = await workspaceWorld({ stored: [cutCopy(V1)] }).read()
  assert.equal(cut.project.format, '9:16')
  assert.equal(cut.reviewAvailability.annotations.state, 'available')
  // A cut copy renders and is critiqued; its final export is refused until the target owns perception authority.
  assert.deepEqual(cut.outputs[0].consumption, { render: { status: 'allowed' }, critic: { status: 'allowed' },
    final: { status: 'blocked', reason: 'derived-source-perception-authority-required' } })
})

test('workspace: the outputs list names every output of the head with its verdicts; two outputs of one ratio are blocked as ambiguous; no format blocks the critic', async () => {
  const record = await workspaceWorld({ stored: [twoOutputs(V1)] }).read()
  assert.equal('format' in record.project, false, 'two outputs have no single format')
  assert.deepEqual(record.outputs.map((output) => [output.variantId, output.aspectRatio]), [['variant-a', '9:16'], ['variant-b', '16:9']])
  for (const output of record.outputs) assert.deepEqual(output.consumption, { render: { status: 'allowed' }, critic: { status: 'allowed' }, final: { status: 'allowed' } })
  const twins = await workspaceWorld({ stored: [state(V1, [materializedEntry('variant-a'), materializedEntry('variant-b')])] }).read()
  const ambiguous = { status: 'blocked', reason: 'output-variant-ambiguous' }
  assert.deepEqual(twins.outputs.map((output) => output.consumption), [{ render: ambiguous, critic: ambiguous, final: ambiguous }, { render: ambiguous, critic: ambiguous, final: ambiguous }])
  const noFormat = await workspaceWorld({ stored: [state(V1, [materializedEntry('variant-a', { spec: ownSpec(undefined) })])] }).read()
  assert.equal('aspectRatio' in noFormat.outputs[0], false)
  assert.deepEqual(noFormat.outputs[0].consumption, { render: { status: 'allowed' }, critic: { status: 'blocked', reason: 'output-not-consumable' }, final: { status: 'allowed' } })
})

test('workspace: several outputs, none, an unsealed head and a project without a head show no format and do not fail', async () => {
  for (const stored of [twoOutputs(V1), creationEmpty(V1), historicalVersion({ workspaceId: W, projectId: P, versionId: V1 })]) {
    const record = await workspaceWorld({ stored: [stored] }).read()
    assert.equal('format' in record.project, false)
  }
  const headless = workspaceWorld({ stored: [], versions: [], currentVersionId: null })
  const record = await headless.read()
  assert.equal('format' in record.project, false)
  assert.deepEqual(record.outputs, [], 'no head, no outputs')
  assert.equal(headless.reader.reads.length, 0)
})

test('workspace: the format is read from the head Version\'s own State, and a State that fails its seal fails the read', async () => {
  const world = workspaceWorld({ stored: [single(V1), twoOutputs(V2)], versions: [V2, V1], currentVersionId: V2 })
  const record = await world.read()
  assert.equal('format' in record.project, false, 'the head has two outputs, whatever the older Version had')
  assert.deepEqual([...new Set(world.reader.reads)], [V2])
  const forged = workspaceWorld({ stored: [withRow(single(V1), { stateHash: sha('f') })] })
  await assert.rejects(() => forged.read(), (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
})

// ===== operator page =====

test('project page: every published consumption refusal has an operator message, and the page guesses no output format', () => {
  const source = readFileSync(new URL('../../src/app/projects/[id]/page.tsx', import.meta.url), 'utf8')
  const messages = source.slice(source.indexOf('const REFUSAL_REASON_MESSAGES'), source.indexOf('function apiError'))
  for (const reason of PUBLISHED_CONSUMPTION_REASONS) assert.ok(messages.includes(`'${reason}':`), `${reason} has an operator message`)
  assert.equal(/format\s*\?\?\s*'9:16'/.test(source), false, 'no default format is guessed')
  // The page knows the outputs of the current version (the workspace `outputs`). Every variant-specific request names the SELECTED
  // output by its stable variant id; with none selected there is nothing to name and the actions are refused before any request.
  assert.match(source, /const outputVariantId = selectedOutput\?\.variantId \?\? null/)
  assert.match(source, /if \(!outputVariantId\) \{\s*setNotice\(OUTPUT_FORMAT_REQUIRED_MESSAGE\)/)
  assert.equal(source.includes('workspace.project.format'), false, 'the page never reads the project format to name an output')
  assert.equal(/variantId: outputFormat/.test(source), false)
  assert.ok(source.includes('variantId: outputVariantId,'), 'the manual edit names the selected output')
  assert.ok(source.includes("query.set('variantId', selectedOutputIdRef.current)"), 'the review and proxy-review reads name the selected output')
  assert.ok(source.includes('variantId: review.scopeContext.variantId'), 'an annotation names the output of the displayed proxy')
  assert.ok(source.includes('variantId: outputVariantId,\n          approval:'), 'the final export names the selected output')
  assert.ok(source.includes('data-testid="output-selector"'), 'several outputs offer a selector')
  assert.ok(source.includes('(outputAspectRatio ?? \'16:9\').replace'), 'the preview frame uses the selected output ratio')
})
