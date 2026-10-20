import { resetDisposableDatabase } from './disposable-database.mjs'
import { persistRecording, testActor } from './pg-output-world.mjs'
import { seedReviewProject } from './review-edit-world.mjs'

/**
 * The world the PostgreSQL Director/OCR suite runs on: a workspace with one project whose single output is the explicit
 * vertical (9:16) variant, and the recording the OCR producer reads (artifact, manifest, project links, ingest receipt, rights
 * and the real file's digest and size). Everything is written by the product's own writers (see pg-output-world.mjs and
 * review-edit-world.mjs): the creation Command carries the briefing the Director later reads, the variant is created through the
 * output-variant service, the recording through the ingest's own rows.
 *
 * Unlike `seedPerceptionProducerContext` the project does not yet play the recording: the suite owns the plan and the transcript
 * the Director must read, and commits the Version that plays them itself (`commitSealedChild`), because a sealed Version's plan is
 * fixed at the moment it is born. `world.head` is the empty variant until then; the suite then replaces `versionId`/`editId`.
 *
 * Output format: the Director, the proxy renderer and every consumer read the aspect ratio from the sealed entry of the Version
 * they consume (slice S3), so a suite that renders 9:16 creates a 9:16 output, never relies on the 16:9 example.
 *
 * The output variant is named by its aspect ratio (`'9:16'`): the manual-edit API names the output a Command edits by that string
 * while the sealed State holds it under the variant's id, so the two only agree when they are the same (prisma-manual-edit pins it
 * the same way). An output variant id is unique across the database, so a database that already holds one by that id (another
 * suite's run, in a supervised run that shares one database) is emptied first - when, and only when, it is disposable.
 */
export async function seedDirectorOcrWorld(db, { suffix, artifactKey, sourceSha256, byteSize, aspectRatio = '9:16', durationFrames = 120, variantId = aspectRatio }) {
  const workspaceId = `w61-admission-${suffix}`
  const otherWorkspaceId = `w61-other-${suffix}`
  const clientId = `w61-client-${suffix}`
  const projectId = `w61-project-${suffix}`
  const actor = testActor({ workspaceId, clientId, credentialId: `w61-credential-${suffix}`, environment: 'production',
    scopes: ['projects:write', 'projects:read', 'operations:read', 'operations:cancel', 'operations:retry'] })
  if (await db.v2OutputVariant.findUnique({ where: { id: variantId }, select: { id: true } })) await resetDisposableDatabase(db)
  await db.v2Workspace.create({ data: { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'W61 other' } })
  const sealed = await seedReviewProject(db, { workspaceId, actor, prefix: 'w61', ids: { project: projectId, 'output-variant': variantId },
    name: 'Director OCR project', objective: 'discovery', aspectRatio,
    briefing: 'Público: equipes criativas. Tom: direto e natural.' })
  // The master's grant is the one the product's own ingest writes (media ingest worker): no library reuse.
  const recording = await persistRecording(db, { workspaceId, projectId, actor, slug: `w61-source-${suffix}`, durationFrames,
    sourceSha256, sourceByteSize: Number(byteSize), sourceKey: artifactKey,
    rights: { allowedUses: ['distribution', 'editing', 'rendering', 'transcription'] } })
  return {
    suffix, workspaceId, otherWorkspaceId, clientId, projectId, sourceId: recording.names.sourceArtifactId,
    sourceSha256, byteSize, artifactKey, rightsId: recording.sourceRights.id, actor, recording, aspectRatio,
    variantId: sealed.variantId, head: sealed.head, versionId: sealed.head.version.id, editId: sealed.head.editPlanSnapshot.id,
  }
}
