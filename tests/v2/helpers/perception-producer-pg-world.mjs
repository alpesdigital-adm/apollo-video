import { randomUUID } from 'node:crypto'

import { commitSealedChild, persistRecording, planPlayingRecordings, seedSealedProject, testActor } from './pg-output-world.mjs'

/**
 * The world the perception producers (OCR, temporal, face) run against: a workspace with one project whose head is a
 * real, sealed Version that plays one recording, and the recording's source artifact with its manifest, project link and
 * rights. It is built the way the product builds it (see pg-output-world.mjs): the creation Command, one explicit output
 * variant, the recording's persisted ingest, and a child Command that adopts it. Nothing is inserted around those writers.
 *
 * `sourceSha256`, `byteSize` and `artifactKey` name the real file a worker reads back. The clip plays the whole recording,
 * `durationFrames` long at 30 fps (default 120).
 *
 * `seedRights: false` leaves the source without any rights: a suite that proves the rights the ingest itself writes then
 * runs that stage first, and calls `world.sealHead()` afterwards, which commits the child Command that makes the recording
 * the head's timeline (a Version can only play a source whose rights allow it). Until then `versionId` is the empty
 * variant's. With rights seeded the head is already sealed.
 */
export async function seedPerceptionProducerContext(db, options = {}) {
  const suffix = options.suffix ?? randomUUID().slice(0, 8)
  const workspaceId = `w61-admission-${suffix}`
  const otherWorkspaceId = `w61-other-${suffix}`
  const clientId = `w61-client-${suffix}`
  const projectId = `w61-project-${suffix}`
  const sourceSha256 = options.sourceSha256 ?? 'a'.repeat(64)
  const byteSize = options.byteSize ?? 1024n
  const artifactKey = options.artifactKey ?? `${workspaceId}/source.mp4`
  const actor = testActor({ workspaceId, clientId, credentialId: `w61-credential-${suffix}`, environment: 'production',
    scopes: ['projects:write', 'projects:read', 'operations:read', 'operations:cancel', 'operations:retry'] })
  await db.v2Workspace.create({ data: { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'W61 other' } })
  const sealed = await seedSealedProject(db, { workspaceId, actor, prefix: 'w61', ids: { project: projectId } })
  const seedRights = options.seedRights !== false
  const recording = await persistRecording(db, { workspaceId, projectId, actor, slug: `w61-source-${suffix}`, durationFrames: options.durationFrames ?? 120,
    sourceSha256, sourceByteSize: Number(byteSize), sourceKey: artifactKey, rights: seedRights ? {} : { source: false } })
  const world = { suffix, workspaceId, otherWorkspaceId, clientId, projectId, sourceId: recording.names.sourceArtifactId,
    sourceSha256, byteSize, artifactKey, rightsId: recording.sourceRights?.id ?? null, actor, recording,
    versionId: sealed.head.version.id, editId: sealed.head.editPlanSnapshot.id, plan: JSON.parse(sealed.head.editPlanSnapshot.contentJson) }
  world.sealHead = async () => {
    const head = await commitSealedChild(db, { workspaceId, projectId, actor, suffix: `w61-${suffix}-playing`,
      mutatePlan: planPlayingRecordings([recording]), adopt: [recording.names.sourceArtifactId] })
    world.versionId = head.version.id
    world.editId = head.editPlanSnapshot.id
    world.plan = JSON.parse(head.editPlanSnapshot.contentJson)
    return head
  }
  if (seedRights) await world.sealHead()
  return world
}
