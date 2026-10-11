import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { assembleDirectedEditPlan, calculateRenderablePlanHash } from '../../src/v2/application/renderable-edit-plan.ts'
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
  const client = { v2Project: { async findFirst() { return project } },
    v2RenderablePlanSnapshot: { async findFirst() { return { workspaceId, projectId,
      projectVersionId: plan.projectVersionId, planId: plan.id, origin: 'react-playback',
      sourceId: 'playback-proxy-rights', sourceHash: 'a'.repeat(64), sourceVersion: null,
      fps: 30, durationFrames: 60, clipCount: 2, planJson: JSON.stringify(plan),
      planHash: hash, createdAt: new Date(createdAt) } } } }
  const repository = new PrismaProjectProxyRenderRepository(client)
  return { secondId, project,
    projectRead: () => repository.readCurrentSource({ workspaceId, projectId }),
    snapshotRead: () => repository.readRenderableSnapshotSource({ workspaceId, projectId,
      planId: plan.id, planHash: hash, format: '9:16' }) }
}

for (const path of ['projectRead', 'snapshotRead']) {
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
