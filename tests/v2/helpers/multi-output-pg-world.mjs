// A project with TWO explicit outputs (9:16 and 16:9) over an ingested recording, for PostgreSQL suites that prove multi-output
// behaviour (slice S3 multi-output). Built the way the product builds it: the creation Command, one explicit 16:9 output variant
// (the published example), a second explicit 9:16 output variant, one persisted recording and a child Command that adopts the
// recording and plays it, so every State entry is materialized from the very same plan. Nothing is written around the
// repositories, and nothing here deletes anything (identities are unique to the run, see pg-output-world.mjs).
//
// `insertControlledProxyRender` adds what a proxy render leaves for ONE output of a Version (controlled rows, no pixels), with the
// `outputVariantId` the product writes at enqueue.
import { randomUUID } from 'node:crypto'

const { createProjectOutputVariantService } = await import('../../../src/v2/application/create-project.ts')
const { createApiAccessAuditContext } = await import('../../../src/v2/domain/api-access-control.ts')
const { stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createMediaArtifactManifest } = await import('../../../src/v2/domain/media-artifact.ts')
const { PrismaOperationalOutputBundleRepositoryV3 } = await import('../../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts')
const { commitSealedChild, persistRecording, planPlayingRecordings, seedSealedProject } = await import('./pg-output-world.mjs')
const { variantBody } = await import('./output-world.mjs')

/** The body of the 9:16 output the world adds beside the published 16:9 example. */
export function verticalVariantBody() {
  const body = variantBody()
  return {
    ...body,
    output: { ...body.output, aspectRatio: '9:16', width: 360, height: 640, deliveryProfileId: 'profile-output-vertical' },
    profile: { ...body.profile, id: 'profile-output-vertical',
      final: { ...body.profile.final, width: 360, height: 640 }, proxy: { ...body.profile.proxy, width: 180, height: 320 } },
  }
}

/**
 * Root, 16:9 output, 9:16 output, one recording and the child that adopts and plays it.
 * Returns `{ projectId, head, wideVariantId, verticalVariantId, recording, run, createId }`.
 */
export async function seedTwoOutputIngestedProject(client, { workspaceId, actor, prefix = 'mo', ids = {}, recording = { slug: 'source' }, at = () => new Date() }) {
  const world = await seedSealedProject(client, { workspaceId, actor, prefix, ids, at })
  const dependencies = { repository: new PrismaOperationalOutputBundleRepositoryV3(client), clock: at, createId: world.createId, createEventId: randomUUID }
  const second = await createProjectOutputVariantService(dependencies)({
    ...verticalVariantBody(), workspaceId, projectId: world.projectId, baseVersionId: world.head.version.id, baseHash: world.head.version.baseHash,
    actor, idempotencyKey: `${prefix}-${world.run}-vertical-request`,
  })
  const verticalVariantId = second.bundle.origin.result.command.payload.variantId
  const persisted = await persistRecording(client, { workspaceId, projectId: world.projectId, actor, ...recording, slug: `${prefix}-${world.run}-${recording.slug}` })
  const head = await commitSealedChild(client, { workspaceId, projectId: world.projectId, actor, suffix: `${prefix}-${world.run}-ingested`,
    mutatePlan: planPlayingRecordings([persisted]), adopt: [persisted.names.sourceArtifactId] })
  const entries = head.state.document.entries
  if (entries.length !== 2) throw new Error(`the two-output world expected two outputs, found ${entries.length}`)
  return Object.freeze({ projectId: world.projectId, head, wideVariantId: world.variantId, verticalVariantId, recording: persisted, run: world.run, createId: world.createId })
}

/**
 * What a proxy render leaves for ONE output of `version`: the output artifact and manifest, the succeeded render operation with
 * its detail row (carrying `outputVariantId`) and the project link. `source` is `{ artifactId, manifestId }` of the recording the
 * render read. Controlled rows, no rendered pixels.
 */
export async function insertControlledProxyRender(db, { workspaceId, clientId, projectId, version, source, outputVariantId, label, run }) {
  const at = new Date()
  const audit = createApiAccessAuditContext({ clientId, credentialId: `${clientId}-credential`, workspaceId, environment: 'production', authenticationKind: 'bearer' })
  const id = `mo-${run}-${label}`, artifactId = `${id}-proxy`, manifestId = `${id}-proxy-manifest`, operationId = `${id}-operation`
  const sha256 = (await import('node:crypto')).createHash('sha256').update(artifactId).digest('hex')
  const manifest = createMediaArtifactManifest({ artifactKey: `controlled-multi-output/${run}/${label}.mp4`, artifactSha256: sha256, byteSize: 4096, mediaType: 'video',
    container: 'mp4', recipe: { id: 'editorial-proxy', version: '1.0.0', parameters: { label, run } }, probe: { width: 360, height: 640, duration: 2, fps: 30 } })
  await db.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey: manifest.artifact.artifactKey, sha256, byteSize: 4096n, mediaType: 'video',
    container: 'mp4', status: 'available', createdAt: at } })
  await db.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId, schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash,
    recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest), createdAt: at } })
  const inputHash = (await import('node:crypto')).createHash('sha256').update(`${operationId}:${version.id}:${outputVariantId}`).digest('hex')
  await db.v2PublicOperation.create({ data: { id: operationId, workspaceId, projectId, clientId, actorCredentialId: audit.credentialId, actorEnvironment: audit.environment,
    actorAuthenticationKind: audit.authenticationKind, actorContextHash: audit.contextHash, type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
    targetType: 'media-artifact', targetId: artifactId, progressCompleted: 4, progressTotal: 4, progressUnit: 'render', cancelable: false, retryable: false, attempt: 1,
    maxAttempts: 3, idempotencyKey: `${operationId}-request`, requestFingerprint: inputHash, createdAt: at, updatedAt: at, startedAt: at, completedAt: at,
    resultJson: stableSerialize({ resource: { type: 'media-artifact', id: artifactId, manifestId } }) } })
  await db.v2ProjectProxyRenderOperation.create({ data: { operationId, workspaceId, projectId, projectVersionId: version.id, editPlanSnapshotId: version.editPlanSnapshotId,
    sourceArtifactId: source.artifactId, sourceManifestId: source.manifestId, colorPipelineBindingsJson: '[]', inputHash, outputArtifactId: artifactId,
    outputManifestId: manifestId, originalFileName: `${label}.mp4`, outputVariantId, createdAt: at } })
  await db.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId, role: 'editorial-proxy', originalFileName: `${label}.mp4`, createdAt: at } })
  return Object.freeze({ operationId, artifactId, manifestId, inputHash, outputVariantId })
}
