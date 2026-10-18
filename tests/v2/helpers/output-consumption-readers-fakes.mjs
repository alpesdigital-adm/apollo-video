// Fakes for the readers that take their verdict from the one persisted output consumption reader (critics, sidecar, workspace read).
//
// The reader reads two rows (`project_versions` LEFT JOIN `project_output_states`) and checks the State against its own seal, so a
// fake standing in for the database only has to answer that one query with rows that are canonical and sealed. `storedState` builds
// such a row for any minimal State document; `stateClient` answers `$queryRawUnsafe` like the database does (scoped by the three
// identities the reader passes, so a Version of another project or workspace is simply not there) and records which Versions were
// read, so a test can prove a consumer answered about the Version it was asked about and not about the head.
//
// Nothing here knows more about a State than the verdict reads: entries (variant, revision, spec, consumption) and the lineage
// marker (`sourceDependencies`). The real bundles are proven against PostgreSQL by output-consumption-readers.pg.integration.mjs.

const { serializeOutputCanonicalJson, calculateOutputCanonicalHash } = await import('../../../src/v2/domain/output-canonical-policy.ts')
const { stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createMediaArtifactManifestV2 } = await import('../../../src/v2/domain/media-artifact.ts')
const { renderElementMapHash, validateRenderElementMap } = await import('../../../src/v2/domain/review-system.ts')
const { calculateProxyReviewHash } = await import('../../../src/v2/application/render-workflow.ts')

export const sha = (character) => character.repeat(64)

/** A sealed spec that carries its own aspect ratio (an ordinary output), or none at all. */
export const ownSpec = (aspectRatio) => ({ schemaVersion: 'output-spec-revision/v1', output: aspectRatio === undefined ? {} : { aspectRatio } })
/** The literal fork revision of a copy: the geometry it was copied with is its `effectiveSpec`. */
export const forkSpec = (aspectRatio) => ({ schemaVersion: 'output-spec-revision/v3', effectiveSpec: { output: { aspectRatio } } })

/** An entry the State materialized. `derived` marks an editorial-derived materialization (a cut copy). */
export function materializedEntry(variantId, { aspectRatio = '9:16', spec, derived = false } = {}) {
  return {
    variantId, outputSpecRevisionId: `revision-${variantId}`, specHash: sha('a'), spec: spec ?? ownSpec(aspectRatio),
    consumption: { status: 'materialized', materialization: { materializationHash: sha('b'),
      document: { id: `materialization-${variantId}`, schemaVersion: derived ? 'editorial-derived-materialization/v1' : 'output-materialization/v1' } } },
  }
}

/** An entry the State blocks. The default is a copy that no editorial cut has materialized. */
export function blockedEntry(variantId, reasons = ['fork-target-materialization-required'], { aspectRatio = '9:16', spec } = {}) {
  return { variantId, outputSpecRevisionId: `revision-${variantId}`, specHash: sha('a'), spec: spec ?? forkSpec(aspectRatio),
    consumption: { status: 'blocked', reasons } }
}

/**
 * The stored form of one Version's State: the Version row's seal and the State row, canonical and hashed like the database holds them.
 * `contract: 2` is the Creation form (`project-output-state/v2`, always blocked with `reasons`); `3` is an operational State.
 * `sourceDependencies` non-null marks the fork lineage (a cut copy keeps it).
 */
export function storedState({ workspaceId, projectId, versionId, stateId = `state-${versionId}`, entries = [], contract = 3, reasons = ['empty-project'],
  sourceDependencies = null, baseHash = sha('c') }) {
  const document = contract === 3
    ? { schemaVersion: 'project-output-state/v3', id: stateId, resultVersionId: versionId, projectId, workspaceId, entries, sourceDependencies }
    : { schemaVersion: 'project-output-state/v2', id: stateId, resultVersionId: versionId, projectId, workspaceId, entries,
      consumption: { status: 'blocked', reasons } }
  const stateJson = serializeOutputCanonicalJson(document), stateHash = calculateOutputCanonicalHash(document)
  return { workspaceId, projectId, versionId, row: { outputContractVersion: contract, baseHash, outputStateId: stateId, outputStateHash: stateHash,
    stateJson, stateHash, schemaVersion: document.schemaVersion } }
}

/** A Version row of the historical contract: it seals no State and is audit only. */
export function historicalVersion({ workspaceId, projectId, versionId, baseHash = sha('c') }) {
  return { workspaceId, projectId, versionId, row: { outputContractVersion: 1, baseHash, outputStateId: null, outputStateHash: null,
    stateJson: null, stateHash: null, schemaVersion: null } }
}

/** The same stored State with one of its row columns replaced (a forged hash, a rewritten document). */
export const withRow = (stored, changes) => ({ ...stored, row: { ...stored.row, ...changes } })

/** `$queryRawUnsafe` the way the database answers the reader's query. `reads` lists the Version ids it was asked about, in order. */
export function stateClient(stored, extra = {}) {
  const reads = []
  return {
    reads,
    async $queryRawUnsafe(_sql, versionId, projectId, workspaceId) {
      reads.push(versionId)
      return stored.filter((item) => item.versionId === versionId && item.projectId === projectId && item.workspaceId === workspaceId).map((item) => ({ ...item.row }))
    },
    ...extra,
  }
}

/** Prisma `findFirst`/`findMany` over plain rows: every primitive condition of `where` must equal the row's field; nested ones are the fake's pre-filtering. */
export function matching(rows, where = {}) {
  return rows.filter((row) => Object.entries(where).every(([key, wanted]) => wanted === undefined || typeof wanted === 'object' || row[key] === wanted))
}
export const fakeTable = (rows) => ({
  async findFirst({ where } = {}) { return matching(rows, where)[0] ?? null },
  async findMany({ where } = {}) { return matching(rows, where) },
})

const at = new Date('2026-10-12T12:00:00.000Z')

/** A rendered artifact with the manifest the review/workspace projection reads back (a V2 manifest over a measured probe). */
export function previewArtifact({ workspaceId, artifactId = 'artifact-preview', probe = { width: 540, height: 960, duration: 2, fps: 30 } }) {
  const source = { artifactKey: 'preview/source.mp4', sha256: sha('b'), role: 'primary', execution: { tool: { id: 'ffmpeg', version: '8.1.1', digest: sha('c') } } }
  const manifest = createMediaArtifactManifestV2({ artifactKey: `preview/${artifactId}.mp4`, artifactSha256: sha('a'), byteSize: 4096, mediaType: 'video',
    container: 'mp4', recipe: { id: 'editorial-proxy', version: '1.0.0', parameters: { setting: 1 } }, sources: [source], probe })
  const stored = { id: `manifest-${artifactId}`, workspaceId, artifactId, schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash,
    recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest),
    recipeParametersRef: null, recipeParameters: null, renderInputRef: null, renderInputHash: null, renderInput: null, createdAt: at }
  return { id: artifactId, workspaceId, ...manifest.artifact, byteSize: BigInt(manifest.artifact.byteSize), status: 'available', manifests: [stored] }
}

/** A project row as the review preview reads it: the head, and the Versions (newest first) with their plans. */
export function previewProject({ projectId, workspaceId, versions, currentVersionId, locale = 'pt-BR', format = null }) {
  return { id: projectId, workspaceId, name: 'Fixture project', status: 'reviewing-proxy', objective: 'discovery', format, locale, ownerId: null, createdAt: at,
    currentVersionId, versions: versions.map((version, index) => ({ id: version.id, sequence: version.sequence ?? versions.length - index, createdAt: at,
      editPlanSnapshot: { contentJson: JSON.stringify({ fps: 30, durationFrames: 60, videoTracks: [] }) } })) }
}

/** The review preview's proxy: a succeeded proxy render of each listed Version, over the one artifact. */
export function proxyRenders({ workspaceId, projectId, versionIds, artifactId = 'artifact-preview' }) {
  return versionIds.map((projectVersionId) => ({ workspaceId, projectId, outputArtifactId: artifactId, projectVersionId, createdAt: at, operation: { workspaceId, projectId } }))
}

/** The RenderElementMap row of a rendered artifact (no elements: only the canvas and the hash binding matter to the sidecar). */
export function renderElementMapRow({ id = 'map-1', proxyHash = sha('e') } = {}) {
  const map = validateRenderElementMap({ schemaVersion: 'render-element-map/v1', proxyHash, fps: 30, durationFrames: 90, canvas: { width: 540, height: 960 }, elements: [] }, proxyHash)
  return { id, schemaVersion: map.schemaVersion, proxyHash, fps: map.fps, durationFrames: map.durationFrames, canvasWidth: 540, canvasHeight: 960,
    elementsJson: '[]', mapHash: renderElementMapHash(map) }
}

/** A stored proxy review the quality iteration reads back (its hash is the canonical one of the review it stores). */
export function proxyReviewRow({ workspaceId, projectId, projectVersionId, id = 'proxy-review-1' }) {
  const review = {
    schemaVersion: 'proxy-review/v1', projectVersionId, proxyArtifactId: 'artifact-proxy-1', proxyManifestId: 'manifest-proxy-1', inputHash: sha('1'),
    outputSpecId: 'output-spec-1', rangeCacheKey: 'range-cache-1', spec: { width: 540, height: 960, codec: 'h264', container: 'mp4', quality: 'review', reusableRanges: true },
    status: 'ready-for-final', technicalIssues: [], criticIssues: [], warningsAcknowledged: false, finalAllowed: true,
    uploadReceivedAt: at.toISOString(), renderCompletedAt: at.toISOString(), timeToFirstProxyMs: 1200,
  }
  return { id, workspaceId, projectId, operationId: 'operation-proxy-1', projectVersionId, proxyArtifactId: review.proxyArtifactId, proxyManifestId: review.proxyManifestId,
    inputHash: review.inputHash, outputSpecId: review.outputSpecId, rangeCacheKey: review.rangeCacheKey, specJson: stableSerialize(review.spec), status: review.status,
    technicalIssuesJson: '[]', criticIssuesJson: '[]', formatQualityJson: null, warningsAcknowledged: false, finalAllowed: true, reviewHash: calculateProxyReviewHash(review),
    revision: 1, uploadReceivedAt: at, renderCompletedAt: at, timeToFirstProxyMs: BigInt(1200), acknowledgedByType: null, acknowledgedById: null, acknowledgedAt: null,
    createdAt: at, updatedAt: at }
}
