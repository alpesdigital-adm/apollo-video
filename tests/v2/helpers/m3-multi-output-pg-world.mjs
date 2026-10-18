// PostgreSQL helpers for the variant-specific Command/reader suite (W66 slice S3, workstream 3). They build on the two-output world of
// multi-output-pg-world.mjs and only add what that world does not carry: subtitle cues in the plan, and the RenderElementMap a proxy
// leaves beside its output. Nothing here deletes anything (sealed rows are append-only; identities are unique to the run).
import { createHash, randomUUID } from 'node:crypto'

const { stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { renderElementMapHash, validateRenderElementMap } = await import('../../../src/v2/domain/review-system.ts')
const { commitSealedChild } = await import('./pg-output-world.mjs')
const { insertControlledProxyRender, seedTwoOutputIngestedProject } = await import('./multi-output-pg-world.mjs')

/** The cues the project's subtitle tracks hold: the segments a subtitle exception may name. */
export const CUES = Object.freeze([
  Object.freeze({ id: 'cue-hook', startFrame: 0, endFrame: 24, text: 'O dono vira o gargalo' }),
  Object.freeze({ id: 'cue-cta', startFrame: 30, endFrame: 54, text: 'Entre no GPS do Dono' }),
])

/** A plan mutation that gives the project one subtitle track holding `CUES` (every output re-materializes from it). */
export const withSubtitleCues = (plan) => ({
  ...plan,
  subtitleTracks: [{ id: 'captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom', faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32,
    cues: CUES.map((cue) => ({ ...cue, anchor: 'bottom' })) }],
})

/** Two outputs (16:9 and 9:16) over one recording, then a child that gives the plan its subtitle cues: the head the Commands act on. */
export async function seedTwoOutputSubtitleProject(db, { workspaceId, actor, prefix, run, ids = {} }) {
  const world = await seedTwoOutputIngestedProject(db, { workspaceId, actor, prefix, ids })
  const head = await commitSealedChild(db, { workspaceId, projectId: world.projectId, actor, suffix: `${prefix}-${run}-cues`, mutatePlan: withSubtitleCues })
  return Object.freeze({ ...world, head })
}

/**
 * What a proxy render of ONE output leaves for `version`: the controlled render (artifact, manifest, operation naming its output, project link) and
 * the RenderElementMap of its artifact. `version` is `{ id, editPlanSnapshotId }`.
 */
export async function insertOutputRender(db, { workspaceId, clientId, projectId, version, source, outputVariantId, label, run }) {
  const render = await insertControlledProxyRender(db, { workspaceId, clientId, projectId, version, source, outputVariantId, label, run })
  const sha256 = createHash('sha256').update(render.artifactId).digest('hex')
  // The stored binding syntax a render leaves (explicit controlled references, no compiled pixels): readers hydrate it.
  const binding = { sourceArtifactId: source.artifactId, sourceManifestId: source.manifestId, compilationId: `controlled-color-${render.operationId}`,
    compilationHash: createHash('sha256').update(`${render.operationId}:compilation`).digest('hex'), pipelineHash: createHash('sha256').update(`${render.operationId}:pipeline`).digest('hex') }
  await db.v2ProjectProxyRenderOperation.update({ where: { operationId: render.operationId }, data: { colorPipelineBindingsJson: stableSerialize([binding]) } })
  const map = validateRenderElementMap({ schemaVersion: 'render-element-map/v1', proxyHash: sha256, fps: 30, durationFrames: 60, canvas: { width: 360, height: 640 }, elements: [] }, sha256)
  await db.v2RenderElementMap.create({ data: { id: randomUUID(), workspaceId, projectId, projectVersionId: version.id, proxyArtifactId: render.artifactId, proxyHash: sha256,
    mapHash: renderElementMapHash(map), schemaVersion: map.schemaVersion, fps: map.fps, durationFrames: map.durationFrames, canvasWidth: 360, canvasHeight: 640, elementsJson: '[]' } })
  return Object.freeze({ ...render, sha256 })
}
