// A video a sealed Version can play, for the PostgreSQL suites that used to insert a raw artifact and build a base Version over it.
//
// A Version whose plan has a timeline is only accepted over sources an ingest observed (project-version-commit.ts adopts a persisted
// receipt) and whose rights are current. `registerPlayableVideo` leaves exactly what an ingest leaves for one video recording: the
// artifact, its manifest, the project link, the editing proxy, the succeeded media-ingest operation and the sealed receipt (through
// `registerRecording`), then grants the source through the production rights service. The caller then seeds its base Version
// (`seedBaseProjectVersion`) over the artifact, which adopts that receipt.
//
// `receipt: false` registers the source alone (artifact, manifest, link, rights): for a suite whose Version never plays it. That
// path does not load capture-journey.mjs (it needs a TypeScript-aware loader for `next/server`), so a suite that runs under plain
// node can use it.
import { randomUUID } from 'node:crypto'

import { RECORDING_ALLOWED_USES } from './pg-output-world.mjs'

const { PrismaAssetRightsRepository } = await import('../../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
const { setAssetRightsService } = await import('../../../src/v2/application/set-asset-rights.ts')
const { stableSerialize } = await import('../../../src/v2/application/version-hash.ts')
const { createMediaArtifactManifestV2 } = await import('../../../src/v2/domain/media-artifact.ts')

/** The artifact, its manifest and the project link of a recording whose ingest left nothing else (no proxy, operation or receipt). */
async function registerSource(prisma, { workspaceId, projectId, artifactId, artifactKey, sha256, byteSize, probe, role, originalFileName, createdAt }) {
  const manifest = createMediaArtifactManifestV2({ artifactKey, artifactSha256: sha256, byteSize, mediaType: 'video', container: 'mp4',
    recipe: { id: 'misc-pg-playable-video', version: '1.0.0', parameters: { artifactId, mediaType: 'video' } }, sources: [], probe })
  const manifestId = `manifest-${artifactId}`
  await prisma.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey, sha256, byteSize: BigInt(byteSize), mediaType: 'video',
    container: 'mp4', status: 'available', createdAt } })
  await prisma.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId, schemaVersion: manifest.schemaVersion,
    manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash,
    manifestJson: stableSerialize(manifest), createdAt } })
  await prisma.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId, role, originalFileName, createdAt } })
  return { manifestId, manifestHash: manifest.manifestHash, probeId: null }
}

/**
 * Registers `artifactId` as an observed video of `projectId` and grants it approved rights for the uses a compiled plan needs.
 * `probe` is `{ width, height, duration, fps }` (the measured facts the manifest and the receipt carry).
 */
export async function registerPlayableVideo(prisma, {
  workspaceId, projectId, clientId, artifactId, artifactKey = `${artifactId}.mp4`, sha256 = 'a'.repeat(64), byteSize = 100,
  probe, createdAt = new Date(), originalFileName = `${artifactId}.mp4`, role = 'source-master', allowedUses = RECORDING_ALLOWED_USES, receipt = true,
}) {
  const media = receipt
    ? await (await import('./capture-journey.mjs')).registerRecording({ prisma, workspaceId, projectId, artifactId, artifactKey, mediaType: 'video',
      container: 'mp4', sha256, byteSize, probe, role, originalFileName, createdAt, recipeId: 'misc-pg-playable-video' })
    : await registerSource(prisma, { workspaceId, projectId, artifactId, artifactKey, sha256, byteSize, probe, role, originalFileName, createdAt })
  const rights = new PrismaAssetRightsRepository(prisma)
  const previous = await rights.findCurrent(workspaceId, artifactId)
  const granted = await setAssetRightsService({ repository: rights, clock: () => createdAt, createId: () => `rights-${artifactId}` })({
    workspaceId, artifactId, baseRevision: previous.revision, actor: { type: 'api-client', id: clientId },
    draft: { status: 'approved', allowedUses: [...allowedUses], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } },
  })
  return Object.freeze({ ...media, rights: granted })
}
