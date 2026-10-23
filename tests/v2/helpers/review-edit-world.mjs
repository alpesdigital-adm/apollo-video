// The sealed world the review / edit / proxy PostgreSQL suites hang their rows on.
//
// Built on pg-output-world.mjs (the creation Command, one explicit output variant, recordings with their sealed receipts, child
// Commands): this adds what those suites need on top of it and nothing the product does not do itself.
//
// - `seedReviewProject`: the same root and variant `seedSealedProject` builds, but the creation Command may carry the caller's
//   briefing and desired action (the brief snapshot a Director run later reads is born with them: a Version cannot be inserted by
//   hand, so the brief cannot be written either), and the variant is named by its aspect ratio.
// - `registerMeasuredVideo`: a recording a journey generated and probed itself (real bytes on disk): its artifact, manifest,
//   project link, and the sealed receipt its ingest would have left, so a child Command can play it.
// - `grantRendering`: the rights grant of a source, through the production service, so the audit trail exists too.
//
// Nothing here deletes or updates a sealed row, and every identity is the caller's (the suites pass a run-unique suffix).
import { randomUUID } from 'node:crypto'

const { createProjectService, createProjectOutputVariantService } = await import('../../../src/v2/application/create-project.ts')
const { setExternalAssetRightsService } = await import('../../../src/v2/application/set-asset-rights.ts')
const { assetRightsRevision } = await import('../../../src/v2/domain/asset-rights.ts')
const { stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createMediaArtifactManifestV2 } = await import('../../../src/v2/domain/media-artifact.ts')
const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
const { PrismaCreationOutputBundleRepositoryV2, PrismaOperationalOutputBundleRepositoryV3 } = await import('../../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts')
const { ensureWorkspaceActor, persistReceiptForExistingVideo, uniqueRun } = await import('./pg-output-world.mjs')
const { variantBodyFor } = await import('./explicit-project-http.mjs')

/**
 * Root and one explicit variant (`aspectRatio`) of a project, through the production services and repositories.
 *
 * `ids` pins identities the suite already names (`{ project: 'my-project', 'project-version': ... }`); every other kind is
 * allocated from `uniqueRun`. `status` is the status the project has when the suite's rows start (the creation Command leaves it
 * in `draft`; a suite that models a project under review says so). Returns what `seedSealedProject` returns.
 */
export async function seedReviewProject(client, {
  workspaceId, actor, prefix = 'review', ids = {}, name = 'Review project', objective = 'discovery', locale = 'pt-BR',
  briefing, desiredAction, aspectRatio = '9:16', status, at = () => new Date(), interpretBrief,
}) {
  const allocate = uniqueRun(prefix)
  await ensureWorkspaceActor(client, { workspaceId, actor })
  const createId = (kind) => ids[kind] ?? allocate.id(kind)
  const dependencies = (repository) => ({ repository, clock: at, createId, createEventId: randomUUID })
  // `interpretBrief` reads the briefing when the project is created, as the product does; without one the briefing stays as written and unread.
  const created = await createProjectService({ ...dependencies(new PrismaCreationOutputBundleRepositoryV2(client)), ...(interpretBrief ? { interpretBrief } : {}) })({
    workspaceId, name, objective, locale, actor, idempotencyKey: allocate.id('root-request'),
    ...(briefing === undefined ? {} : { briefing }), ...(desiredAction === undefined ? {} : { desiredAction }),
  })
  const projectId = created.projectAtCreation.id
  const root = created.bundle
  const child = await createProjectOutputVariantService(dependencies(new PrismaOperationalOutputBundleRepositoryV3(client)))({
    ...variantBodyFor({ aspectRatio, locale }), workspaceId, projectId, baseVersionId: root.version.id, baseHash: root.version.baseHash,
    actor, idempotencyKey: allocate.id('variant-request'),
  })
  const bundle = child.bundle
  const entry = bundle.state.document.entries.find((item) => item.variantId === bundle.origin.result.command.payload.variantId)
    ?? bundle.state.document.entries.at(-1)
  if (status !== undefined) await client.v2Project.update({ where: { id: projectId }, data: { status } })
  return Object.freeze({ projectId, root, variant: bundle, head: bundle, variantId: entry.variantId, run: allocate.run, createId })
}

/**
 * A recording the journey generated and probed itself: artifact, manifest (over the MEASURED `probe`), project link and the sealed
 * receipt its ingest leaves (`slug` names that ingest: its operation, proxy and receipt). Rights are the caller's (`grantRendering`).
 * `role` is the link's role (`source-master` for a recording the project plays).
 */
export async function registerMeasuredVideo(client, {
  workspaceId, projectId, actor, artifactId, artifactKey, sha256, byteSize, probe, slug, role = 'source-master',
  originalFileName = 'master.mp4', recipeId = 'measured-source', createdAt = new Date(), manifestId = `manifest-${artifactId}`,
}) {
  const manifest = createMediaArtifactManifestV2({ artifactKey, artifactSha256: sha256, byteSize, mediaType: 'video', container: 'mp4',
    recipe: { id: recipeId, version: '1.0.0', parameters: { artifactId } }, sources: [], probe })
  await client.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey, sha256, byteSize: BigInt(byteSize),
    mediaType: 'video', container: 'mp4', status: 'available', createdAt } })
  await client.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId, schemaVersion: manifest.schemaVersion,
    manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
    parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest), createdAt } })
  await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId, role, originalFileName, createdAt } })
  const receipt = await persistReceiptForExistingVideo(client, { workspaceId, projectId, actor, artifactId, createdAt: createdAt.toISOString(),
    nativeFps: probe.fps, durationFrames: Math.max(2, Math.round(probe.duration * probe.fps)), width: probe.width, height: probe.height, slug })
  return Object.freeze({ manifestId, manifest, receipt })
}

/**
 * Grants `allowedUses` (default `rendering`) to a source artifact through the production service: snapshot, audited change and
 * the artifact's current pointer. The artifact must not have a grant yet (revision 0).
 */
export async function grantRendering(client, { workspaceId, artifactId, actor, snapshotId, allowedUses = ['rendering'], clock = () => new Date() }) {
  return setExternalAssetRightsService({ repository: new PrismaAssetRightsRepository(client), clock, createId: () => snapshotId })({
    workspaceId, artifactId, baseRevision: assetRightsRevision(artifactId, 0), actor,
    draft: { owner: 'Apollo controlled review fixture', license: 'test-owned', status: 'approved', allowedUses, prohibitedUses: [],
      allowedLocales: ['pt-BR'], consent: { status: 'not-required', allowedUses: [] },
      sourceNote: 'Controlled source for review and edit invariants; no media acceptance claim' },
  })
}

const { createMediaColorProbe } = await import('../../../src/v2/domain/color-and-export.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createColorPipelineCompilationService } = await import('../../../src/v2/application/color-pipeline-compilations.ts')
const { PrismaColorPipelineCompilationRepository } = await import('../../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts')

/**
 * The colour facts a render needs of every video source: an observed colour probe of the exact manifest and the one colour pipeline
 * compilation (identity technical and output stages) the proxy enqueue binds to. Both go through the production service and
 * repository, so the compilation is the one a render later reads back.
 */
export async function registerColorPipeline(client, { workspaceId, projectId, actor, artifactId, manifestId, createdAt = new Date() }) {
  const metadata = Object.freeze({ colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 })
  const probe = createMediaColorProbe({ id: `color-probe-${artifactId}`, workspaceId, artifactId, manifestId,
    detection: { state: 'ready', metadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: '7.1.1', binaryDigest: calculateCanonicalHash({ tool: 'ffprobe', version: '7.1.1' }) },
    createdAt: createdAt.toISOString() })
  await client.v2MediaColorProbe.create({ data: { id: probe.id, workspaceId, artifactId, manifestId, schemaVersion: probe.schemaVersion,
    state: probe.detection.state, metadataJson: stableSerialize(probe.detection.metadata), pixelFormat: probe.detection.pixelFormat,
    hdrMode: probe.detection.hdrMode, reasonsJson: '[]', producerProvider: probe.producer.provider, producerVersion: probe.producer.version,
    producerBinaryDigest: probe.producer.binaryDigest, createdAt, probeHash: probe.probeHash } })
  const implementation = (provider, parameters) => Object.freeze({ provider, version: 'v1', parameters: Object.freeze(parameters),
    parametersHash: calculateCanonicalHash(parameters) })
  const stage = (kind, enabled, provider, parameters) => ({ id: `${kind}-${artifactId}`, kind, version: 'v1', enabled, output: metadata,
    implementation: implementation(provider, parameters) })
  const compiled = await createColorPipelineCompilationService({
    repository: new PrismaColorPipelineCompilationRepository(client), createId: () => `color-compilation-${artifactId}`, clock: () => createdAt,
  })({ workspaceId, projectId, sourceArtifactId: artifactId, sourceManifestId: manifestId, outputMetadata: metadata,
    stages: [stage('technical', true, 'ffmpeg-zscale', { mode: 'identity' }), stage('match', false, 'apollo-match', { mode: 'bypass' }),
      stage('creative-lut', false, 'apollo-lut', { mode: 'none' }), stage('output', true, 'ffmpeg-zscale', { dither: false })],
    actor, idempotencyKey: `color-${artifactId}` })
  return compiled.value.compilation
}
