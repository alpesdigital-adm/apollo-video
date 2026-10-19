// A project with TWO explicit outputs (16:9 and 9:16) over one controlled ingest, without a database: the pure counterpart of
// `multi-output-pg-world.mjs` for unit tests of the plan-editing Commands. Every Version, State, Command and hash is the production
// one (the creation Command, two `create-output-variant` Commands and the ingest origin run through the real bundle builders); only
// persistence is replaced. Built the way the product builds it: root, 16:9 output, 9:16 output, then the ingest, so both State entries
// are materialized from the very same plan.
//
// It mirrors `prepareEditorialSourceFixture` (which can only make siblings of ONE aspect ratio); it edits none of the shared helpers.
import { creationRequest, outputWorld } from './output-world.mjs'
import { ingestRecording } from './operational-editorial-fixture.mjs'

const { materializeActorAuditContext } = await import('../../../src/v2/application/authenticate-api-client.ts')
const { calculateCanonicalHash, stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createOutputSpecRevisionBody } = await import('../../../src/v2/domain/output-spec-revision.ts')
const { createOutputVariantCommand } = await import('../../../src/v2/domain/output-variant-command.ts')
const { createProjectSnapshot } = await import('../../../src/v2/domain/project-snapshot.ts')
const { buildOperationalOutputVersionBundleV3 } = await import('../../../src/v2/domain/output-version-bundle.ts')

const POLICY = { canonicalPolicyVersion: 'output-canonical-json/v1' }
const encoding = (width, height, final) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true, width, height, fps: 30,
  quality: { mode: 'crf', value: final ? 18 : 23, preset: final ? 'medium' : 'veryfast' }, audio: { codec: 'aac', bitrateKbps: final ? 192 : 160, sampleRateHz: 48000, channels: 1 } })

/** The two outputs the world creates, in the order it creates them. */
export const TWO_OUTPUT_SPECS = Object.freeze([
  Object.freeze({ key: 'wide', variantId: 'variant-m1b-wide', aspectRatio: '16:9', width: 640, height: 360 }),
  Object.freeze({ key: 'vertical', variantId: 'variant-m1b-vertical', aspectRatio: '9:16', width: 360, height: 640 }),
])

/**
 * Root, 16:9 output, 9:16 output, one controlled ingest. `parent` is the ingested bundle (both entries materialized from its plan);
 * `wideVariantId` / `verticalVariantId` are the stable State variant ids of the outputs.
 */
export async function twoOutputIngestedWorld({ sourceDurationSeconds = 6, slug, actor, specs = TWO_OUTPUT_SPECS, ids } = {}) {
  const world = outputWorld(actor, { ids })
  const root = await world.create(creationRequest(world))
  const scope = { workspaceId: root.bundle.version.workspaceId, projectId: root.projectAtCreation.id }
  const audit = materializeActorAuditContext(world.actor)
  const createdAt = '2026-10-14T12:00:01.000Z'
  const snapshotOf = (id, plan) => createProjectSnapshot({ ...scope, id, kind: 'edit-plan', contentSchemaVersion: 2, contentJson: stableSerialize(plan),
    contentHash: calculateCanonicalHash(plan), createdAt })
  const chain = [root.bundle]
  let head = root.bundle
  for (const spec of specs) {
    const revision = createOutputSpecRevisionBody({ ...scope, ...POLICY, id: `revision-${spec.variantId}`, variantId: spec.variantId, revisionNumber: 1, createdAt,
      output: { schemaVersion: 1, id: spec.variantId, locale: 'pt-BR', aspectRatio: spec.aspectRatio, width: spec.width, height: spec.height, fps: 30,
        safeArea: { top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 }, deliveryProfileId: `profile-${spec.variantId}` },
      profile: { schemaVersion: 'materialized-delivery-profile/v1', id: `profile-${spec.variantId}`, version: 1, rendererContractVersion: 'ffmpeg-editorial-output/v1',
        final: encoding(spec.width, spec.height, true), proxy: encoding(spec.width / 2, spec.height / 2, false),
        proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 2, scaleY: 2 }, subtitles: { mode: 'none', configuration: null, fontAssets: [] } }, preset: null })
    const result = createOutputVariantCommand({
      command: { ...scope, id: `command-${spec.variantId}`, baseVersionId: head.version.id, baseHash: head.version.baseHash, type: 'create-output-variant',
        author: { type: 'api-client', id: audit.clientId }, idempotencyKey: `request-${spec.variantId}`, createdAt },
      audit, base: head.version, baseState: head.state, historicalBaselineRequested: false, revision, expectedRevisionId: null, expectedSpecHash: null, durationFrames: 0 })
    const headPlan = head.schemaVersion === 'operational-output-version-bundle/v3'
      ? JSON.parse(head.editPlanSnapshot.contentJson)
      : JSON.parse(head.command.payload.snapshots.find((snapshot) => snapshot.kind === 'edit-plan').contentJson)
    const plan = { ...headPlan, id: `edit-plan-${spec.variantId}`, projectVersionId: `version-${spec.variantId}`, createdAt }
    head = buildOperationalOutputVersionBundleV3({
      allocation: { ...scope, resultVersionId: plan.projectVersionId, stateId: `state-${spec.variantId}`, parentVersionId: head.version.id, sequence: head.version.sequence + 1,
        createdBy: audit.clientId, createdAt },
      parent: head, origin: { kind: 'create-output-variant', result }, restoreTarget: null, editPlanSnapshot: snapshotOf(`snapshot-${spec.variantId}`, plan),
      normalizations: [], materializationIds: {} })
    chain.push(head)
  }
  const ingested = ingestRecording(head, scope, audit, { slug, sourceDurationSeconds })
  chain.push(ingested.bundle)
  const byKey = Object.fromEntries(specs.map((spec) => [spec.key, spec.variantId]))
  if (ingested.bundle.state.document.entries.length !== specs.length) throw new Error('the two-output world expected one State entry per output')
  return Object.freeze({ world, root, parent: ingested.bundle, actor: world.actor, chain, scope, transcript: ingested.transcript, refs: ingested.refs, names: ingested.names,
    wideVariantId: byKey.wide, verticalVariantId: byKey.vertical, variantIds: Object.freeze(specs.map((spec) => spec.variantId)) })
}
