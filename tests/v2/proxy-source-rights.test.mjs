import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { assembleDirectedEditPlan, calculateRenderablePlanHash } from '../../src/v2/application/renderable-edit-plan.ts'
import { assertInlineProxySourceAuthority } from '../../src/v2/infrastructure/prisma/proxy-source-authority.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { fakeOutputWorld } from './helpers/output-consumption-fakes.mjs'
import { configureIdempotencyWinnerWait } from '../../src/v2/infrastructure/prisma/idempotency-record-persistence.ts'

// The exhaustion tests below count attempts: keep the lost-race budget at three attempts and never sleep (this file's process only).
configureIdempotencyWinnerWait({ delaysMs: [0, 0], async sleep() {} })

const workspaceId = 'workspace-proxy-rights', projectId = 'project-proxy-rights'
const createdAt = '2026-10-01T00:00:00.000Z'

function rightsRow(artifactId, overrides = {}) {
  const { workspace = workspaceId, ...draft } = overrides
  const rights = createAssetRightsSnapshot({ id: `rights-${artifactId}`, workspaceId: workspace,
    artifactId, sequence: 1, draft: { status: 'approved', allowedUses: ['rendering'],
      prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] }, ...draft },
    createdBy: { type: 'user', id: 'owner-proxy-rights' }, createdAt })
  return { ...rights, allowedUsesJson: JSON.stringify(rights.allowedUses),
    prohibitedUsesJson: JSON.stringify(rights.prohibitedUses),
    allowedWorkspaceIdsJson: JSON.stringify(rights.allowedWorkspaceIds),
    allowedLocalesJson: rights.allowedLocales ? JSON.stringify(rights.allowedLocales) : null,
    allowedMarketsJson: null, allowedSyntheticOperationsJson: null,
    consentStatus: rights.consent.status, consentAllowedUsesJson: JSON.stringify(rights.consent.allowedUses),
    consentAllowedLocalesJson: null, consentAllowedMarketsJson: null,
    consentSyntheticOperationsJson: null, consentExpiresAt: rights.consent.expiresAt ? new Date(rights.consent.expiresAt) : null,
    consentDocumentArtifactId: null, owner: null, license: null, sourceNote: null,
    expiresAt: rights.expiresAt ? new Date(rights.expiresAt) : null,
    createdByType: 'user', createdById: 'owner-proxy-rights', createdAt: new Date(createdAt) }
}

function fixture({ role = 'selected-insert', mediaType = 'video', rights = { allowedUses: ['editorial-reuse'] },
  ambiguous = false, reverse = false, music = false, world: worldOptions = {} } = {}) {
  const masterId = 'artifact-rights-master', secondId = 'artifact-rights-second'
  const plan = { ...assembleDirectedEditPlan({ planId: 'plan-proxy-rights',
    projectVersionId: 'version-proxy-rights', derivedFrom: { origin: 'react-playback',
      id: 'playback-proxy-rights', hash: 'a'.repeat(64) }, objective: 'discovery', fps: 30,
    sources: [{ id: masterId, artifactId: masterId, kind: 'video', durationSeconds: 2 },
      { id: secondId, artifactId: secondId, kind: 'video', durationSeconds: 2 }],
    clips: [{ id: 'clip-rights-1', sourceArtifactId: masterId, sourceInFrame: 0,
      sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
    { id: 'clip-rights-2', sourceArtifactId: mediaType === 'video' ? secondId : masterId,
      ...(mediaType === 'audio' ? { audioSourceArtifactId: secondId } : {}), sourceInFrame: 30,
      sourceOutFrame: 60, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 }],
    seams: [{ reason: 'Controlled rights repository fixture continuity' }],
    lineageRefs: [masterId, secondId], assumptions: ['Controlled rights checks only'], createdAt }),
    formatVariantRefs: ['9:16'] }
  const link = (artifactId, linkRole, type, draft) => ({ artifactId, role: linkRole,
    originalFileName: `${artifactId}.mp4`, createdAt: new Date(createdAt), upload: null,
    artifact: { id: artifactId, sha256: 'b'.repeat(64), byteSize: 1024n, mediaType: type,
      status: 'available', container: type === 'audio' ? 'wav' : 'mp4',
      currentRightsSnapshot: rightsRow(artifactId, draft), manifests: [{ id: `manifest-${artifactId}`,
        manifestJson: JSON.stringify({ artifact: { artifactKey: `${artifactId}.mp4` } }) }] } })
  const second = link(secondId, role, mediaType, rights)
  if (music) plan.audioTracks = [{ artifactId: secondId, rightsSnapshotId: second.artifact.currentRightsSnapshot.id }]
  const links = [link(masterId, 'source-master', 'video', {}), second]
  if (ambiguous) links.push({ ...second, role: 'source-master' })
  if (reverse) links.reverse()
  // The sealed State of the Version the render consumes. The project row carries NO format (the 6.0.0 world): the sealed entry is the
  // only authority for it.
  const world = fakeOutputWorld({ workspaceId, projectId, versionId: plan.projectVersionId, ...worldOptions })
  const project = { id: projectId, workspaceId, locale: 'pt-BR', format: null,
    currentVersionId: plan.projectVersionId, mediaAssets: links,
    versions: [{ id: plan.projectVersionId, baseHash: world.version.baseHash, editPlanSnapshotId: 'snapshot-proxy-rights',
      editPlanSnapshot: { workspaceId, projectId, contentJson: JSON.stringify(plan),
        contentHash: calculateVersionHash(plan) }, command: null, directorRunAsResult: null }] }
  const hash = calculateRenderablePlanHash(plan)
  const client = { async $queryRaw() { return [{ now: new Date() }] }, $queryRawUnsafe: world.queryRawUnsafe, v2VariantReframePlan: { async findFirst() { return null } }, v2SubtitleSegmentOverrideHead: { async findMany() { return [] } },
    v2MediaArtifactManifest: { async findFirst() { return { manifestJson: JSON.stringify({ sources: links.map((link) => ({
      artifactKey: link.artifactId + '.mp4', sha256: link.artifact.sha256,
      role: music && link.artifactId === secondId ? 'approved-music' : link.role === 'selected-insert' ? 'selected-insert' : 'source-master' })) }) } } },
    v2Project: { async findFirst() { return project } },
    v2RenderablePlanSnapshot: { async findFirst() { return { workspaceId, projectId,
      projectVersionId: plan.projectVersionId, planId: plan.id, origin: 'react-playback',
      sourceId: 'playback-proxy-rights', sourceHash: 'a'.repeat(64), sourceVersion: null,
      fps: 30, durationFrames: 60, clipCount: 2, planJson: JSON.stringify(plan),
      planHash: hash, createdAt: new Date(createdAt) } } } }
  const repository = new PrismaProjectProxyRenderRepository(client)
  return { secondId, project, repository, client, world,
    inlineRead: () => assertInlineProxySourceAuthority(client, { workspaceId, projectId, projectVersionId: plan.projectVersionId,
      editPlanSnapshotId: 'snapshot-proxy-rights', sourceArtifactId: masterId, sourceManifestId: 'manifest-' + masterId,
      outputArtifactId: 'output-inline-rights', outputManifestId: 'manifest-inline-rights' }),
    projectRead: () => repository.readCurrentSource({ workspaceId, projectId }),
    snapshotRead: () => repository.readRenderableSnapshotSource({ workspaceId, projectId,
      planId: plan.id, planHash: hash, format: '9:16' }) }
}

for (const path of ['projectRead', 'snapshotRead', 'inlineRead']) {
  test(`${path}: direct video/audio require rendering and selected inserts require editorial reuse`, async () => {
    for (const [role, mediaType, use, expectedRole] of [
      ['source-master', 'video', 'rendering', 'source-master'],
      ['source-audio', 'audio', 'rendering', 'source-master'],
      ['selected-insert', 'video', 'editorial-reuse', 'selected-insert'],
      ['selected-insert', 'audio', 'editorial-reuse', 'selected-insert'],
    ]) {
      const good = fixture({ role, mediaType, rights: { allowedUses: [use] } })
      assert.equal((await good[path]()).renderSources.find((s) => s.artifactId === good.secondId).role, expectedRole)
      const bad = fixture({ role, mediaType, rights: { allowedUses: [use === 'rendering' ? 'editorial-reuse' : 'rendering'] } })
      await assert.rejects(bad[path](), (e) => e.code === 'ASSET_RIGHTS_BLOCKED')
    }
  })

  test(`${path}: current rights status, consent, expiry, prohibition, locale and workspace remain gates`, async () => {
    for (const rights of [
      { status: 'revoked' }, { status: 'expired' }, { expiresAt: '2020-01-01T00:00:00Z' },
      { allowedUses: ['editing'], prohibitedUses: ['rendering'] }, { allowedLocales: ['en-US'] }, { workspace: 'workspace-other-rights' },
      { consent: { status: 'revoked', allowedUses: [] } },
      { consent: { status: 'approved', allowedUses: ['editing'] } },
      { consent: { status: 'approved', allowedUses: ['rendering'], expiresAt: '2020-01-01T00:00:00Z' } },
    ]) await assert.rejects(fixture({ role: 'source-master', rights })[path](), (e) => e.code === 'ASSET_RIGHTS_BLOCKED')
  })

  test(`${path}: unsupported roles and ambiguous provenance fail regardless of query ordering`, async () => {
    for (const role of ['source-video', 'source-image', 'source-document', 'editing-proxy', 'approved-music', 'unknown']) {
      await assert.rejects(fixture({ role })[path](), (e) => e.code === 'PERSISTENCE_CONFLICT')
    }
    for (const reverse of [false, true]) {
      await assert.rejects(fixture({ ambiguous: true, reverse })[path](), (e) => e.code === 'PERSISTENCE_CONFLICT')
    }
    await assert.rejects(fixture({ role: 'source-audio', mediaType: 'video' })[path](), (e) => e.code === 'PERSISTENCE_CONFLICT')
  })
}

test('project path: music retains its pinned current snapshot branch but never an ambiguous association', async () => {
  const good = fixture({ role: 'source-audio', mediaType: 'audio', music: true })
  assert.equal((await good.projectRead()).renderSources.find((s) => s.artifactId === good.secondId).role, 'approved-music')
  const stale = fixture({ role: 'source-audio', mediaType: 'audio', music: true })
  stale.project.mediaAssets[1].artifact.currentRightsSnapshot.id = 'different-rights-snapshot'
  await assert.rejects(stale.projectRead(), (e) => e.code === 'ASSET_RIGHTS_BLOCKED')
  await assert.rejects(fixture({ role: 'source-audio', mediaType: 'audio', music: true,
    ambiguous: true }).projectRead(), (e) => e.code === 'PERSISTENCE_CONFLICT')
})

test('publication fences lock project then all video/audio/music/output identities in deterministic order before clock refresh', async () => {
  const { project, repository, secondId, world } = fixture({ role: 'source-audio', mediaType: 'audio' })
  const snapshot = project.versions[0].editPlanSnapshot
  const plan = JSON.parse(snapshot.contentJson)
  plan.audioTracks = [{ artifactId: 'artifact-rights-music' }]
  // C collation follows UTF-8 bytes, not JS UTF-16 ordering. No extra ID
  // prohibition belongs in the publication lock helper.
  plan.videoTracks[0].clips[0].audioSourceArtifactId = 'artifact-\uE000'
  plan.videoTracks[0].clips[1].sourceArtifactId = 'artifact-\u{10000}'
  snapshot.contentJson = JSON.stringify(plan)
  snapshot.contentHash = calculateVersionHash(plan)
  const expected = ['artifact-rights-master', 'artifact-rights-music', 'artifact-rights-output', secondId,
    'artifact-\uE000', 'artifact-\u{10000}'].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const order = []
  const tx = { $queryRawUnsafe: world.queryRawUnsafe, v2VariantReframePlan: { async findFirst() { return null } }, v2SubtitleSegmentOverrideHead: { async findMany() { return [] } }, v2Project: { async findFirst() { return project } }, async $queryRaw(strings, ...values) {
    const sql = strings.join('?')
    if (sql.includes('FROM projects')) {
      order.push('project')
      assert.deepEqual(values, [projectId, workspaceId])
      assert.match(sql, /FOR UPDATE/)
      return [{ id: projectId }]
    }
    assert.match(sql, /FROM media_artifacts/)
    assert.match(sql, /ORDER BY id COLLATE "C" FOR UPDATE/)
    assert.equal(values[0], workspaceId)
    assert.deepEqual(values[1].values, expected)
    order.push('artifacts')
    return expected.map((id) => ({ id }))
  } }
  repository.assertCompletionLease = async () => { order.push('clock-lease'); return new Date(createdAt) }
  await repository.lockCompletionSources(tx, { workspaceId, projectId, outputArtifactId: 'artifact-rights-output' }, {
    projectVersionId: project.versions[0].id, editPlanSnapshotId: 'snapshot-proxy-rights',
    sourceArtifactId: 'artifact-rights-master' })
  assert.deepEqual(order, ['project', 'artifacts', 'clock-lease'])
  tx.$queryRaw = async (strings) => strings.join('').includes('FROM projects')
    ? [{ id: projectId }] : expected.slice(1).map((id) => ({ id }))
  await assert.rejects(repository.lockCompletionSources(tx, { workspaceId, projectId,
    outputArtifactId: 'artifact-rights-output' }, { projectVersionId: project.versions[0].id,
    editPlanSnapshotId: 'snapshot-proxy-rights', sourceArtifactId: 'artifact-rights-master' }),
  (error) => error.code === 'PERSISTENCE_CONFLICT')
})

for (const method of ['attachCompletedOutput', 'attachCompletedSnapshotOutput']) {
  test(`${method}: serialization retries are finite and match only precise Prisma/SQLSTATE codes`, async () => {
    for (const error of [{ code: 'P2034' }, { code: 'P2010', meta: { code: '40001' } }]) {
      let attempts = 0
      const repository = new PrismaProjectProxyRenderRepository({ async $transaction() { attempts += 1; throw error } })
      await assert.rejects(repository[method]({}), (failure) => failure.code === 'PERSISTENCE_CONFLICT')
      assert.equal(attempts, 3)
      attempts = 0
      const converging = new PrismaProjectProxyRenderRepository({ async $transaction() {
        if (++attempts === 1) throw error
      } })
      await converging[method]({})
      assert.equal(attempts, 2, 'retry opens a new transaction instead of repeating reads in the old snapshot')
    }
    for (const error of [{ code: 'P2010', meta: { code: '40P01' } },
      { code: 'P2010', meta: { code: 40001 } }, { code: 'P2010', message: '40001 serialization failure' },
      { code: 'ASSET_RIGHTS_BLOCKED' }, new Error('40001 serialization failure')]) {
      let attempts = 0
      const repository = new PrismaProjectProxyRenderRepository({ async $transaction() { attempts += 1; throw error } })
      await assert.rejects(repository[method]({}), (failure) => failure === error)
      assert.equal(attempts, 1)
    }
  })
}

// Admission retries open a new Serializable transaction, never reinterpret an error message.
test('inline admission retries only P2034/raw 40001 and exhausts after three attempts (zero-wait schedule: three attempts)', async () => {
  const { createQueuedPublicOperation, startPublicOperationAttempt, advancePublicOperationPhase, succeedPublicOperation } =
    await import('../../src/v2/domain/public-operation.ts')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const now = new Date().toISOString()
  const queued = createQueuedPublicOperation({ id: 'inline-retry-operation', workspaceId, projectId,
    clientId: 'inline-client', type: 'project-proxy-render', target: { type: 'media-artifact', id: 'inline-output', manifestId: 'inline-manifest' }, createdAt: now })
  const operation = succeedPublicOperation(advancePublicOperationPhase(startPublicOperationAttempt(queued, now), 'persisting', now), now)
  const audit = createApiAccessAuditContext({ workspaceId, clientId: 'inline-client', credentialId: 'inline-credential',
    environment: 'production', authenticationKind: 'bearer' })
  const input = { operation, authenticationAudit: audit, idempotencyKey: 'inline-retry-key', requestFingerprint: 'a'.repeat(64),
    context: { kind: 'project-proxy-reuse', projectId, projectVersionId: 'inline-child', editPlanSnapshotId: 'inline-snapshot',
      commandId: 'inline-command', impactHash: 'b'.repeat(64), baseVersionId: 'inline-base', reusedFromOperationId: 'inline-parent-operation',
      sourceArtifactId: 'inline-source', sourceManifestId: 'inline-source-manifest', inputHash: 'c'.repeat(64),
      outputArtifactId: 'inline-output', outputManifestId: 'inline-manifest', originalFileName: 'controlled.mp4' } }
  for (const error of [{ code: 'P2034' }, { code: 'P2010', meta: { code: '40001' } },
    { code: 'P2010', meta: { code: '40P01' } }, { code: 'P2010', meta: { code: 40001 } },
    { code: 'P2010', message: '40001' }]) {
    let attempts = 0
    const repo = new PrismaPublicOperationRepository({ async $transaction() { attempts++; throw error } })
    const retriable = error.code === 'P2034' || error.meta?.code === '40001'
    await assert.rejects(repo.createOrReplay(input), (failure) => retriable ? failure.code === 'PERSISTENCE_CONFLICT' : failure === error)
    assert.equal(attempts, retriable ? 3 : 1)
  }
})

test('inline expiry uses the clock after project and manifest reads, including the final admission check', async () => {
  const subject = fixture({ role: 'source-master', rights: { expiresAt: '2026-10-02T00:00:00.000Z' } })
  const reads = []
  const projectRead = subject.client.v2Project.findFirst
  const manifestRead = subject.client.v2MediaArtifactManifest.findFirst
  subject.client.v2Project.findFirst = async (...args) => { reads.push('project'); return projectRead(...args) }
  subject.client.v2MediaArtifactManifest.findFirst = async (...args) => { reads.push('manifest'); return manifestRead(...args) }
  subject.client.$queryRaw = async () => { reads.push('clock'); return [{ now: new Date('2026-10-02T00:00:00.000Z') }] }
  await assert.rejects(subject.inlineRead(), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  assert.deepEqual(reads, ['project', 'manifest', 'clock'])
})

test('inline music keeps its exact current rights snapshot and source lineage branch', async () => {
  const good = fixture({ role: 'source-audio', mediaType: 'audio', music: true })
  assert.equal((await good.inlineRead()).renderSources.find((source) => source.artifactId === good.secondId).role, 'approved-music')
  good.project.mediaAssets[1].artifact.currentRightsSnapshot.id = 'wrong-current-music-rights'
  await assert.rejects(good.inlineRead(), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
})

// ---------------------------------------------------------------------------
// Slice S3 - the proxy render reads ONE persisted consumption verdict, never the project's format or the head.
// ---------------------------------------------------------------------------

const reasonOf = (reason, purpose) => (error) => error?.code === 'PRECONDITION_REQUIRED' && error.details?.reason === reason &&
  (purpose === undefined || error.details?.purpose === purpose)
const cutCopyWorld = { entries: [{ variantId: 'variant-copy', aspectRatio: '9:16', derived: true }], sourceDependencies: { forkDerivationId: 'derivation-1' } }
const neverCutWorld = { entries: [{ variantId: 'variant-copy', aspectRatio: '9:16', blockedReasons: ['fork-target-materialization-required'] }],
  sourceDependencies: { forkDerivationId: 'derivation-1' } }

for (const path of ['projectRead', 'inlineRead', 'snapshotRead']) {
  test(`${path}: the source carries the seal of the exact Version, State, variant revision and materialization it was read through, and the format of its sealed entry`, async () => {
    const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] },
      world: { entries: [{ variantId: 'variant-main', aspectRatio: '9:16', outputSpecRevisionId: 'revision-main-3', specHash: 'd'.repeat(64),
        materializationId: 'materialization-main-3', materializationHash: 'e'.repeat(64) }] } })
    const source = await subject[path]()
    assert.deepEqual(source.outputConsumption.seal, { schemaVersion: 'output-consumption-seal/v1', purpose: 'render',
      projectVersionId: 'version-proxy-rights', projectVersionHash: subject.world.version.baseHash,
      outputStateId: subject.world.document.id, outputStateHash: subject.world.stateHash, variantId: 'variant-main',
      outputSpecRevisionId: 'revision-main-3', specHash: 'd'.repeat(64), materializationId: 'materialization-main-3', materializationHash: 'e'.repeat(64) })
    assert.deepEqual(source.outputConsumption, subject.world.consumption('render'))
    assert.equal(source.format, '9:16', 'the sealed entry names the format; the project row carries none')
    assert.ok(subject.world.sql.length >= 1 && subject.world.sql.every((text) => text.includes('FROM project_versions v LEFT JOIN project_output_states s')),
      'the light reader only: sealed Version + State rows, never the audit rebuild')
  })

  test(`${path}: the sealed entry is the only authority for the format; a contradicting project row is ignored`, async () => {
    const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: { entries: [{ variantId: 'variant-wide', aspectRatio: '16:9' }] } })
    subject.project.format = '1:1'
    if (path === 'snapshotRead') {
      // The plan binds 9:16 only; the sealed entry of its Version is 16:9: the requested format cannot be served.
      await assert.rejects(subject.snapshotRead(), (error) => error.code === 'PERSISTENCE_CONFLICT' && /not bound to the requested format/.test(error.message))
      return
    }
    assert.equal((await subject[path]()).format, '16:9')
  })

  test(`${path}: a cut copy renders (render verdict), a copy never cut is refused with the published reason`, async () => {
    const cut = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: cutCopyWorld })
    const source = await cut[path]()
    assert.equal(source.outputConsumption.seal.purpose, 'render')
    assert.equal(source.outputConsumption.seal.variantId, 'variant-copy')
    await assert.rejects(fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: neverCutWorld })[path](),
      reasonOf('copy-requires-editorial-cut', 'render'))
  })

  test(`${path}: a State with several outputs, an output without a format and a Version without a State are refused with their published reasons`, async () => {
    await assert.rejects(fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] },
      world: { entries: [{ variantId: 'variant-a', aspectRatio: '9:16' }, { variantId: 'variant-b', aspectRatio: '16:9' }] } })[path](), reasonOf('output-variant-required', 'render'))
    await assert.rejects(fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] },
      world: { entries: [{ variantId: 'variant-a', aspectRatio: null }] } })[path](), reasonOf('output-not-consumable', 'render'))
    const missing = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] } })
    missing.client.$queryRawUnsafe = async () => []
    await assert.rejects(missing[path](), reasonOf('output-version-missing'))
  })

  test(`${path}: a Version row that is not the Version its State seals is a persistence conflict, not a source`, async () => {
    const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] } })
    subject.project.versions[0].baseHash = 'f'.repeat(64)
    await assert.rejects(subject[path](), (error) => error.code === 'PERSISTENCE_CONFLICT')
  })
}

test('projectRead: the final purpose refuses a cut copy before anything is hydrated, and renders the same State for an ordinary project', async () => {
  const cut = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: cutCopyWorld })
  await assert.rejects(cut.repository.readCurrentSource({ workspaceId, projectId, purpose: 'final' }), reasonOf('derived-source-perception-authority-required', 'final'))
  await assert.rejects(cut.repository.readImmutableSource({ workspaceId, projectId, projectVersionId: 'version-proxy-rights',
    editPlanSnapshotId: 'snapshot-proxy-rights', sourceArtifactId: 'artifact-rights-master', sourceManifestId: 'manifest-artifact-rights-master', purpose: 'final' }),
  reasonOf('derived-source-perception-authority-required', 'final'))
  await assert.rejects(fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: neverCutWorld }).repository
    .readCurrentSource({ workspaceId, projectId, purpose: 'final' }), reasonOf('copy-requires-editorial-cut', 'final'))
  const ordinary = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] } })
  const final = await ordinary.repository.readCurrentSource({ workspaceId, projectId, purpose: 'final' })
  assert.equal(final.outputConsumption.seal.purpose, 'final')
  assert.notEqual(final.outputConsumption.sealHash, (await ordinary.projectRead()).outputConsumption.sealHash, 'the purpose is part of the seal')
})

test('the immutable read consumes the exact Version it is asked for, not the head', async () => {
  const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] } })
  const versionsAsked = []
  const findFirst = subject.client.v2Project.findFirst
  subject.client.v2Project.findFirst = async (query) => { versionsAsked.push(query.select.versions.where); return findFirst(query) }
  const source = await subject.repository.readImmutableSource({ workspaceId, projectId, projectVersionId: 'version-proxy-rights',
    editPlanSnapshotId: 'snapshot-proxy-rights', sourceArtifactId: 'artifact-rights-master', sourceManifestId: 'manifest-artifact-rights-master' })
  assert.equal(source.outputConsumption.seal.projectVersionId, 'version-proxy-rights')
  assert.deepEqual(versionsAsked, [{ id: 'version-proxy-rights', editPlanSnapshotId: 'snapshot-proxy-rights' }])
  // Another Version id asks for another State: the fake only knows this one, so the verdict is "output Version missing".
  await assert.rejects(subject.repository.readImmutableSource({ workspaceId, projectId, projectVersionId: 'version-newer-head',
    editPlanSnapshotId: 'snapshot-proxy-rights', sourceArtifactId: 'artifact-rights-master', sourceManifestId: 'manifest-artifact-rights-master' }),
  reasonOf('output-version-missing'))
})

test('the immutable read with the head fence on refuses a Version that is no longer the head, and leaves the exact-Version read alone without it', async () => {
  const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] } })
  const input = { workspaceId, projectId, projectVersionId: 'version-proxy-rights', editPlanSnapshotId: 'snapshot-proxy-rights',
    sourceArtifactId: 'artifact-rights-master', sourceManifestId: 'manifest-artifact-rights-master' }
  assert.equal((await subject.repository.readImmutableSource({ ...input, requireCurrent: true })).projectVersionId, 'version-proxy-rights')
  subject.project.currentVersionId = 'version-newer-head'
  assert.equal((await subject.repository.readImmutableSource(input)).projectVersionId, 'version-proxy-rights', 'the exact-Version read does not care about the head')
  await assert.rejects(subject.repository.readImmutableSource({ ...input, requireCurrent: true }),
    (error) => error.code === 'PERSISTENCE_CONFLICT' && /no longer the current Version/.test(error.message))
})

// ---------------------------------------------------------------------------
// Slice S3 - an optional explicit State variant is threaded to the one consumption reader; absent means the State's only output.
// ---------------------------------------------------------------------------

const twoOutputs = { entries: [{ variantId: 'variant-wide', aspectRatio: '16:9', outputSpecRevisionId: 'revision-wide-1', materializationId: 'materialization-wide' },
  { variantId: 'variant-tall', aspectRatio: '9:16', outputSpecRevisionId: 'revision-tall-4', materializationId: 'materialization-tall' }] }

test('an explicit State variant selects one output of a State with several: its entry names the format and the seal; absent or unknown is refused', async () => {
  const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: twoOutputs })
  const immutable = { workspaceId, projectId, projectVersionId: 'version-proxy-rights', editPlanSnapshotId: 'snapshot-proxy-rights',
    sourceArtifactId: 'artifact-rights-master', sourceManifestId: 'manifest-artifact-rights-master' }
  await assert.rejects(subject.repository.readCurrentSource({ workspaceId, projectId }), reasonOf('output-variant-required', 'render'))
  await assert.rejects(subject.repository.readImmutableSource(immutable), reasonOf('output-variant-required', 'render'))
  for (const [variantId, format, revision] of [['variant-wide', '16:9', 'revision-wide-1'], ['variant-tall', '9:16', 'revision-tall-4']]) {
    const current = await subject.repository.readCurrentSource({ workspaceId, projectId, variantId })
    assert.equal(current.format, format)
    assert.equal(current.outputConsumption.seal.variantId, variantId)
    assert.equal(current.outputConsumption.seal.outputSpecRevisionId, revision)
    assert.deepEqual(current.outputConsumption, subject.world.consumption('render', variantId))
    const exact = await subject.repository.readImmutableSource({ ...immutable, variantId })
    assert.equal(exact.outputConsumption.sealHash, current.outputConsumption.sealHash)
    const final = await subject.repository.readCurrentSource({ workspaceId, projectId, variantId, purpose: 'final' })
    assert.equal(final.outputConsumption.seal.variantId, variantId)
  }
  assert.notEqual((await subject.repository.readCurrentSource({ workspaceId, projectId, variantId: 'variant-wide' })).outputConsumption.sealHash,
    (await subject.repository.readCurrentSource({ workspaceId, projectId, variantId: 'variant-tall' })).outputConsumption.sealHash, 'each output seals differently')
  await assert.rejects(subject.repository.readCurrentSource({ workspaceId, projectId, variantId: 'variant-unknown' }), reasonOf('output-variant-unknown'))
  // The snapshot read: the plan binds 9:16, so only the 9:16 output serves it, and the format must still be the entry's.
  const storedPlan = JSON.parse(subject.project.versions[0].editPlanSnapshot.contentJson)
  const planRead = (variantId) => subject.repository.readRenderableSnapshotSource({ workspaceId, projectId, planId: storedPlan.id,
    planHash: calculateRenderablePlanHash(storedPlan), format: '9:16', variantId })
  assert.equal((await planRead('variant-tall')).outputConsumption.seal.variantId, 'variant-tall')
  await assert.rejects(planRead('variant-wide'), (error) => error.code === 'PERSISTENCE_CONFLICT' && /not bound to the requested format/.test(error.message))
  await assert.rejects(planRead(undefined), reasonOf('output-variant-required', 'render'))
})

test('an explicit State variant of a copy never cut is still refused with the published reason', async () => {
  const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: { entries: [
    { variantId: 'variant-a', aspectRatio: '9:16', blockedReasons: ['fork-target-materialization-required'] },
    { variantId: 'variant-b', aspectRatio: '9:16', blockedReasons: ['fork-target-materialization-required'] }] } })
  await assert.rejects(subject.repository.readCurrentSource({ workspaceId, projectId, variantId: 'variant-b' }), reasonOf('copy-requires-editorial-cut', 'render'))
})

test('S3-MO the inline authority of an unchanged reuse is read for the output the reuse is for: a State with several outputs that names none is refused, each output answers its own format and seal', async () => {
  const subject = fixture({ role: 'source-master', rights: { allowedUses: ['rendering'] }, world: twoOutputs })
  const inline = (variantId) => assertInlineProxySourceAuthority(subject.client, { workspaceId, projectId, projectVersionId: 'version-proxy-rights',
    editPlanSnapshotId: 'snapshot-proxy-rights', sourceArtifactId: 'artifact-rights-master', sourceManifestId: 'manifest-artifact-rights-master',
    outputArtifactId: 'output-inline-rights', outputManifestId: 'manifest-inline-rights', ...(variantId === undefined ? {} : { variantId }) })
  await assert.rejects(inline(undefined), reasonOf('output-variant-required', 'render'))
  await assert.rejects(inline('variant-unknown'), reasonOf('output-variant-unknown'))
  const [wide, tall] = [await inline('variant-wide'), await inline('variant-tall')]
  assert.deepEqual([wide.format, tall.format], ['16:9', '9:16'])
  assert.deepEqual([wide.outputConsumption.seal.variantId, tall.outputConsumption.seal.variantId], ['variant-wide', 'variant-tall'])
  assert.notEqual(wide.outputConsumption.sealHash, tall.outputConsumption.sealHash)
})
