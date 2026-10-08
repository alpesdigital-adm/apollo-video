import { randomUUID } from 'node:crypto'

import { createAssetRightsSnapshot } from '../../../src/v2/domain/asset-rights.ts'
import { calculateCanonicalHash, stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'

export async function seedPerceptionProducerContext(db, options = {}) {
  const suffix = options.suffix ?? randomUUID().slice(0, 8)
  const workspaceId = `w61-admission-${suffix}`
  const otherWorkspaceId = `w61-other-${suffix}`
  const clientId = `w61-client-${suffix}`
  const projectId = `w61-project-${suffix}`
  const versionId = `w61-version-${suffix}`
  const sourceId = `w61-source-${suffix}`
  const editId = `w61-edit-${suffix}`
  const sourceSha256 = options.sourceSha256 ?? 'a'.repeat(64)
  const byteSize = options.byteSize ?? 1024n
  const artifactKey = options.artifactKey ?? `${workspaceId}/source.mp4`
  const now = new Date()
  await db.v2Workspace.createMany({ data: [
    { id: workspaceId, slug: workspaceId, name: 'W61 admission' },
    { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'W61 other' },
  ] })
  await db.v2ApiClient.create({ data: {
    id: clientId, workspaceId, name: 'W61 test client',
    allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '["projects:write","projects:read","operations:read","operations:cancel","operations:retry"]',
    createdBy: 'w61-test',
  } })
  await db.v2Project.create({ data: {
    id: projectId, workspaceId, name: 'W61 source', objective: 'discovery', format: '9:16', locale: 'pt-BR',
    createdByType: 'api-client', createdById: clientId,
  } })
  const plan = { schemaVersion: 2, state: 'compiled', id: `w61-plan-${suffix}`,
    projectVersionId: versionId, fps: 30, durationFrames: 120,
    videoTracks: [{ id: `w61-track-${suffix}`, kind: 'base-video', clips: [{ id: `w61-clip-${suffix}`,
      sourceArtifactId: sourceId, sourceInFrame: 0, sourceOutFrame: 120,
      timelineInFrame: 0, timelineOutFrame: 120, rate: 1 }] }],
    subtitleTracks: [], transitions: [],
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    composition: { layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1,
      verticalPosition: 0.5, faceSafeFallback: [0.08, 0.08, 0.84, 0.84],
      subtitleSafeRegion: [0.08, 0.68, 0.84, 0.22] } }
  for (const [kind, id, content] of [
    ['brief', `w61-brief-${suffix}`, {}], ['policies', `w61-policy-${suffix}`, {}], ['edit-plan', editId, plan],
  ]) {
    await db.v2ProjectSnapshot.create({ data: { id, workspaceId, projectId, kind, schemaVersion: 1,
      contentJson: stableSerialize(content), contentHash: calculateCanonicalHash(content) } })
  }
  await db.v2ProjectVersion.create({ data: {
    id: versionId, workspaceId, projectId, sequence: 1,
    briefSnapshotId: `w61-brief-${suffix}`, policiesSnapshotId: `w61-policy-${suffix}`,
    editPlanSnapshotId: editId, baseHash: 'b'.repeat(64), createdBy: clientId,
  } })
  await db.v2Project.update({ where: { id: projectId }, data: { currentVersionId: versionId } })
  await db.v2MediaArtifact.create({ data: { id: sourceId, workspaceId,
    artifactKey, sha256: sourceSha256, byteSize,
    mediaType: 'video', container: 'mp4', status: 'available' } })
  await db.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId,
    artifactId: sourceId, role: 'source-master', originalFileName: 'source.mp4' } })
  const rights = createAssetRightsSnapshot({ id: `w61-rights-${suffix}`, workspaceId, artifactId: sourceId,
    sequence: 1, draft: { status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] } },
    createdBy: { type: 'user', id: 'w61-owner' }, createdAt: now.toISOString() })
  await db.v2AssetRightsSnapshot.create({ data: {
    id: rights.id, workspaceId, artifactId: sourceId, sequence: 1,
    schemaVersion: rights.schemaVersion, snapshotHash: rights.snapshotHash, status: rights.status,
    allowedUsesJson: stableSerialize(rights.allowedUses), prohibitedUsesJson: '[]',
    allowedWorkspaceIdsJson: stableSerialize(rights.allowedWorkspaceIds),
    consentStatus: rights.consent.status, consentAllowedUsesJson: '[]',
    createdByType: 'user', createdById: 'w61-owner', createdAt: now,
  } })
  await db.v2MediaArtifact.update({ where: { id: sourceId }, data: { currentRightsSnapshotId: rights.id, rightsRevision: 1 } })
  return { suffix, workspaceId, otherWorkspaceId, clientId, projectId, versionId, sourceId,
    editId, sourceSha256, byteSize, artifactKey, rightsId: rights.id, plan }
}
