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
function sidecarWorld({ stored, versions = [V1], currentVersionId = versions[0], finals = [], proxies = versions, workspaceId = W }) {
  const reader = stateClient(stored)
  const render = (projectVersionId, extra = {}) => ({ workspaceId: W, projectId: P, projectVersionId, outputArtifactId: 'artifact-render', outputManifestId: 'manifest-render',
    inputHash: sha('9'), editPlanSnapshotId: 'plan-1', editPlanSnapshot: plan, createdAt: new Date('2026-10-12T12:00:00.000Z'), ...extra })
  const client = {
    ...reader,
    v2Project: fakeTable([{ id: P, workspaceId: W, currentVersionId }]),
    v2ProjectVersion: fakeTable(versions.map((id, index) => ({ id, workspaceId: W, projectId: P, sequence: versions.length - index }))),
    v2ProjectFinalExportOperation: fakeTable(finals.map(({ versionId, aspectRatio }) => render(versionId, { outputAspectRatio: aspectRatio }))),
    v2ProjectProxyRenderOperation: fakeTable(proxies.map((id) => render(id))),
    v2MediaArtifact: fakeTable([{ id: 'artifact-render', workspaceId: W, artifactKey: 'renders/out.mp4', sha256: sha('e'), status: 'available' }]),
    v2RenderElementMap: fakeTable(versions.map((projectVersionId) => ({ ...renderElementMapRow({ proxyHash: sha('e') }), workspaceId: W, projectId: P, projectVersionId, proxyArtifactId: 'artifact-render' }))),
  }
  const read = (input = {}) => new PrismaSubtitleSidecarRepository(client).readRenderedAlignment({ workspaceId, projectId: P, variantId: '9:16', ...input })
  return { client, reader, read }
}

test('sidecar: the alignment of a single-output Version is admitted for render and sealed; the variant asked must be the ratio the sealed entry carries', async () => {
  const world = sidecarWorld({ stored: [single(V1)] })
  const alignment = await world.read()
  assert.equal(alignment.variantId, '9:16')
  assert.equal(alignment.outputKind, 'proxy')
  assert.equal(alignment.projectVersionId, V1)
  assert.equal(alignment.outputConsumption.render.seal.purpose, 'render')
  assert.equal(alignment.outputConsumption.render.seal.projectVersionId, V1)
  assert.equal(alignment.outputConsumption.render.seal.variantId, 'variant-a')
  assert.equal(alignment.outputConsumption.final, undefined)
  // The project's format is not consulted and no variant is invented: another ratio than the entry's has nothing to align.
  assert.equal(await world.read({ variantId: '16:9' }), null)
  assert.deepEqual([...new Set(world.reader.reads)], [V1])
})

test('sidecar: an explicit State variant names the output, and the ratio asked must still be the one that output carries', async () => {
  const world = sidecarWorld({ stored: [twoOutputs(V1)] })
  const wide = await world.read({ variantId: '16:9', stateVariantId: 'variant-b' })
  assert.equal(wide.outputConsumption.render.seal.variantId, 'variant-b')
  assert.equal(await world.read({ variantId: '9:16', stateVariantId: 'variant-b' }), null, 'variant-b carries 16:9')
  await assert.rejects(() => world.read({ variantId: '16:9', stateVariantId: 'variant-z' }), refusedWith('output-variant-unknown'))
})

test('sidecar: a final export is also admitted for final, and its seal is separate from the render seal', async () => {
  const world = sidecarWorld({ stored: [single(V1)], finals: [{ versionId: V1, aspectRatio: '9:16' }] })
  const alignment = await world.read()
  assert.equal(alignment.outputKind, 'final')
  assert.equal(alignment.outputConsumption.final.seal.purpose, 'final')
  assert.notEqual(alignment.outputConsumption.final.sealHash, alignment.outputConsumption.render.sealHash)
})

test('sidecar: a cut copy aligns its proxy, but a final export of it is refused until the target owns perception authority', async () => {
  const proxyOnly = sidecarWorld({ stored: [cutCopy(V1)] })
  assert.equal((await proxyOnly.read()).outputKind, 'proxy')
  const exported = sidecarWorld({ stored: [cutCopy(V1)], finals: [{ versionId: V1, aspectRatio: '9:16' }] })
  await assert.rejects(() => exported.read(), refusedWith('derived-source-perception-authority-required'))
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

test('sidecar: several outputs are told apart by the ratio the sealed entries carry; two outputs with one ratio are refused as ambiguous', async () => {
  const world = sidecarWorld({ stored: [twoOutputs(V1)] })
  const wide = await world.read({ variantId: '16:9' })
  assert.equal(wide.variantId, '16:9')
  assert.equal(wide.outputConsumption.render.seal.variantId, 'variant-b')
  assert.equal(await world.read({ variantId: '1:1' }), null)
  const twins = sidecarWorld({ stored: [state(V1, [materializedEntry('variant-a'), materializedEntry('variant-b')])] })
  await assert.rejects(() => twins.read(), refusedWith('output-variant-ambiguous'))
})

test('sidecar: an older Version answers about that Version only, never about the head that superseded it', async () => {
  const world = sidecarWorld({ stored: [single(V1), twoOutputs(V2)], versions: [V2, V1], currentVersionId: V2 })
  const older = await world.read({ projectVersionId: V1 })
  assert.equal(older.projectVersionId, V1)
  assert.equal(older.isCurrentVersion, false)
  assert.equal(older.outputConsumption.render.seal.projectVersionId, V1)
  assert.deepEqual([...new Set(world.reader.reads)], [V1], 'the head State was never read')
  // The head carries a 16:9 output the older Version never had.
  assert.equal(await world.read({ projectVersionId: V1, variantId: '16:9' }), null)
  assert.equal((await world.read({ projectVersionId: V2, variantId: '16:9' })).isCurrentVersion, true)
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
  const request = { workspaceId: W, actor, projectId: P, variantId: '9:16', format: 'srt', idempotencyKey: 'idem-readers-1' }
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
function previewWorld({ stored, versions = [V1], currentVersionId = versions[0], project }) {
  const reader = stateClient(stored)
  const row = project ?? previewProject({ projectId: P, workspaceId: W, versions: versions.map((id) => ({ id })), currentVersionId })
  const client = {
    ...reader,
    v2Project: fakeTable([row]),
    v2ProjectFinalExportOperation: fakeTable([]),
    v2ProjectProxyRenderOperation: fakeTable(proxyRenders({ workspaceId: W, projectId: P, versionIds: versions })),
    v2ProjectMediaAsset: fakeTable([]),
    v2MediaArtifact: { async findFirst({ where }) { return where.id === artifact.id ? artifact : null } },
  }
  return { client, reader, preview: (input = {}) => readReviewPreviewContext(client, { workspaceId: W, projectId: P, ...input }),
    availability: (input = {}) => readReviewPreviewAvailability(client, { workspaceId: W, projectId: P, ...input }) }
}

test('review preview: the format is the ratio the sealed entry carries, the scope counts follow it and the admission is sealed for critic', async () => {
  const world = previewWorld({ stored: [single(V1)] })
  const context = await world.preview()
  assert.equal(context.formatId, '9:16')
  assert.equal(context.availableScopeCounts.formats, 1)
  assert.equal(context.outputConsumption.seal.purpose, 'critic')
  assert.equal(context.outputConsumption.seal.projectVersionId, V1)
  assert.equal(context.outputConsumption.seal.variantId, 'variant-a')
  // The availability read model describes the same proxy and admits nothing.
  const availability = await world.availability()
  assert.deepEqual(availability, Object.fromEntries(Object.keys(availability).map((key) => [key, context[key]])))
  assert.equal('formatId' in availability, false)
})

test('review preview: an explicit variant names the output of a State with several; an unknown one is refused', async () => {
  const world = previewWorld({ stored: [twoOutputs(V1)] })
  const wide = await world.preview({ variantId: 'variant-b' })
  assert.equal(wide.formatId, '16:9')
  assert.equal(wide.outputConsumption.seal.variantId, 'variant-b')
  assert.equal((await world.preview({ variantId: 'variant-a' })).formatId, '9:16')
  await assert.rejects(() => world.preview({ variantId: 'variant-z' }), refusedWith('output-variant-unknown'))
  await assert.rejects(() => world.preview(), refusedWith('output-variant-required'))
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
  }
  const cut = await workspaceWorld({ stored: [cutCopy(V1)] }).read()
  assert.equal(cut.project.format, '9:16')
  assert.equal(cut.reviewAvailability.annotations.state, 'available')
})

test('workspace: several outputs, none, an unsealed head and a project without a head show no format and do not fail', async () => {
  for (const stored of [twoOutputs(V1), creationEmpty(V1), historicalVersion({ workspaceId: W, projectId: P, versionId: V1 })]) {
    const record = await workspaceWorld({ stored: [stored] }).read()
    assert.equal('format' in record.project, false)
  }
  const headless = workspaceWorld({ stored: [], versions: [], currentVersionId: null })
  const record = await headless.read()
  assert.equal('format' in record.project, false)
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
  // The edit endpoints name the output they act on: without a single output format the actions are refused before any request.
  assert.match(source, /const outputFormat = workspace\?\.project\.format \?\? null/)
  assert.match(source, /if \(!outputFormat\) \{\s*setNotice\(OUTPUT_FORMAT_REQUIRED_MESSAGE\)/)
})
