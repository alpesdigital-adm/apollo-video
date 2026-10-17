import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { assembleDirectedEditPlan, calculateRenderablePlanHash } from '../../src/v2/application/renderable-edit-plan.ts'
import { assertInlineProxySourceAuthority } from '../../src/v2/infrastructure/prisma/proxy-source-authority.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'

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
  ambiguous = false, reverse = false, music = false } = {}) {
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
  const project = { id: projectId, workspaceId, locale: 'pt-BR', format: '9:16',
    currentVersionId: plan.projectVersionId, mediaAssets: links,
    versions: [{ id: plan.projectVersionId, editPlanSnapshotId: 'snapshot-proxy-rights',
      editPlanSnapshot: { workspaceId, projectId, contentJson: JSON.stringify(plan),
        contentHash: calculateVersionHash(plan) }, command: null, directorRunAsResult: null }] }
  const hash = calculateRenderablePlanHash(plan)
  const client = { async $queryRaw() { return [{ now: new Date() }] },
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
  return { secondId, project, repository, client,
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
  const { project, repository, secondId } = fixture({ role: 'source-audio', mediaType: 'audio' })
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
  const tx = { v2Project: { async findFirst() { return project } }, async $queryRaw(strings, ...values) {
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
test('inline admission retries only P2034/raw 40001 and exhausts after three attempts', async () => {
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
