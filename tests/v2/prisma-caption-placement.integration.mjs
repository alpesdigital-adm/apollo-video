import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueFaceWindowRunService } from '../../src/v2/application/enqueue-face-window-run.ts'
import { planCaptionPlacement } from '../../src/v2/application/plan-caption-placement.ts'
import { runNextFaceWindowOperationService } from '../../src/v2/application/run-face-window-worker.ts'
import { subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { PrismaFaceWindowEnvelopeRepository } from '../../src/v2/infrastructure/prisma/face-window-envelope-repository.ts'
import { hydrateProxyRenderSources, queryProxySourceProject } from '../../src/v2/infrastructure/prisma/proxy-source-authority.ts'
import { PrismaFaceWindowRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { acceptedProducer, detectorConfig, observedSample } from './helpers/face-envelope-v2.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'
import { cancelProducerFenceCase } from './helpers/producer-publish-lock-race.mjs'

/**
 * W65 PostgreSQL proof of the caption placement over real sealed face windows (written for a supervised run; not run in CI).
 *
 * The windows are produced by the real V9 window worker over a database, with a detector stand-in that returns real V9
 * tensors; the planner then reads them back through `PrismaFaceWindowEnvelopeRepository.listWindows` exactly as the render
 * worker does. What it must establish, in a database and not in a stand-in:
 *  - a cue inside a clean, complete, authenticated window is placed, and the plan names that window's seal;
 *  - a detected face under a band occupies it and the caption moves to a band that is certified clear;
 *  - a cue with no window, in another Version, in another workspace, or past the last window is withheld (review-required),
 *    with the windows that would let it be certified listed;
 *  - the time map the planner rebuilds from the EditPlan is the one the producer sealed (otherwise the stream is untrusted);
 *  - a tampered stored row stops the render instead of being read as evidence;
 *  - the evidence is part of the placement identity.
 */
const CANVAS = Object.freeze({ width: 540, height: 960 })
const FAR_FACE = [0.9, 0.0, 0.0, 0.03, 0.05]
const FACE_AT_THE_BOTTOM = [0.9, 0.10, 0.72, 0.90, 0.98]

function actorFor(world) {
  const auditContext = createExternalAuditContext({ clientId: world.clientId, credentialId: `caption-credential-${world.suffix}`,
    workspaceId: world.workspaceId, environment: 'production' })
  return { ...auditContext, scopes: new Set(['projects:write', 'projects:read', 'operations:cancel']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext }
}

/** The detector stand-in: real V9 tensors for every sampled frame of the claimed window; `rowsAt(frame)` decides the faces. */
function analyzerFor(rowsAt) {
  return {
    analyze: async (request) => {
      const first = Math.ceil(request.sourceInFrame / request.sampleIntervalFrames) * request.sampleIntervalFrames
      const built = []
      for (let frame = first; frame < request.sourceOutFrame; frame += request.sampleIntervalFrames) {
        built.push(observedSample({ timelineFrame: frame, sourceFrame: frame, rows: rowsAt(frame) }))
      }
      return {
        sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 15360 }, sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
        sourcePtsRounding: 'nearest', sourceWidth: 1280, sourceHeight: 720, sourceOrientation: 'rotation-0-exif-neutral',
        detectorConfig: { ...detectorConfig }, producer: acceptedProducer(),
        samples: built.map(({ sample: { timelineFrame: _unused, ...rest } }) => rest),
        rawOutputs: built.map(({ raw }) => raw),
      }
    },
  }
}
const materializer = { materialize: async (request) => ({ path: 'C:/private/caption-placement-source.mp4', sha256: request.sha256, byteSize: request.byteSize }), cleanup: async () => {} }

function harness(db, world) {
  const operations = new PrismaPublicOperationRepository(db)
  const operationIds = []
  const publish = async (label, window, rowsAt) => {
    const queued = await enqueueFaceWindowRunService({
      context: new PrismaFaceWindowRequestContextRepository(db), operations, createOperationId: () => `face-operation-${randomUUID()}`,
    })({ workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
      window, actor: actorFor(world), idempotencyKey: `caption-${label}-${world.suffix}` })
    operationIds.push(queued.operation.id)
    const result = await runNextFaceWindowOperationService({
      repository: new PrismaFaceWindowEnvelopeRepository(db), materializer, analyzer: analyzerFor(rowsAt),
    })(`caption-worker-${label}-${world.suffix}`)
    assert.equal(result?.status, 'succeeded', `${label}: ${JSON.stringify(result)}`)
    return db.v2FaceProducerEnvelope.findFirstOrThrow({ where: { operationId: queued.operation.id } })
  }
  const cleanup = async () => {
    const failures = []
    for (const operationId of operationIds) {
      try { await cancelProducerFenceCase(db, operations, world, actorFor(world), operationId, 'caption-cleanup') } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'caption placement cleanup failed')
  }
  return { publish, cleanup }
}

async function finish(db, cleanup, primaryError) {
  let cleanupError
  try { await cleanup() } catch (error) { cleanupError = error }
  try { await db.$disconnect() } catch (error) { cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'caption placement test and cleanup failed')
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
}

test('W65 PostgreSQL caption placement: sealed windows place, move or withhold each cue; scope, time map and tamper are enforced',
  { skip: !process.env.V2_DATABASE_URL, timeout: 360_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = harness(db, world)
      const repository = new PrismaFaceWindowEnvelopeRepository(db)
      const clean = await run.publish('clean', { startTimelineFrame: 100, endTimelineFrame: 250 }, () => [FAR_FACE])
      const occupied = await run.publish('face', { startTimelineFrame: 250, endTimelineFrame: 400 },
        (frame) => (frame >= 280 && frame <= 320 ? [FACE_AT_THE_BOTTOM] : [FAR_FACE]))

      const clips = world.plan.videoTracks.find((track) => track.kind === 'base-video').clips

      // the render source carries the dimensions its manifest recorded: that is what lets the planner project it
      const project = await queryProxySourceProject(db, { workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        editPlanSnapshotId: world.editId, sourceArtifactId: world.sourceId, sourceManifestId: world.recording.names.sourceManifestId })
      const [asset] = hydrateProxyRenderSources(project, world.plan, new Date())
      const manifestRow = await db.v2MediaArtifactManifest.findFirstOrThrow({ where: { id: world.recording.names.sourceManifestId, workspaceId: world.workspaceId } })
      const recorded = JSON.parse(manifestRow.manifestJson).probe
      assert.ok(recorded.width >= 2 && recorded.height >= 2)
      assert.deepEqual({ ...asset.probe }, { width: recorded.width, height: recorded.height })
      const plan = (cues, extra = {}) => planCaptionPlacement(
        { faceEvidence: repository, clock: () => new Date() },
        { workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId, format: '9:16', canvas: CANVAS,
          editPlan: world.plan, clips, renderSources: [{ artifactId: world.sourceId, sha256: world.sourceSha256, mediaType: 'video', probe: { width: 720, height: 1280 } }],
          subtitleCues: cues, subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: world.sourceId, faceEvidenceAllowed: true, ...extra })
      const decisionOf = (result, cueId) => subtitleAnchorDecisionFor(result.placementPlan.subtitleAnchorPlan, cueId)

      // the planner rebuilds the producer's time map from the EditPlan: otherwise the stream below would be untrusted
      const placed = await plan([{ id: 'cue-clean', startFrame: 130, endFrame: 170 }])
      const placedStream = placed.placementPlan.subtitleAnchorPlan.faceClearance.streams[0]
      assert.deepEqual(placedStream.untrusted, [])
      assert.deepEqual(placedStream.trustedEnvelopeHashes, [clean.envelopeHash])
      assert.equal(decisionOf(placed, 'cue-clean').disposition, 'placed')
      assert.equal(decisionOf(placed, 'cue-clean').anchor, 'bottom')

      // a face under the bottom band occupies it; the caption goes to a band the same evidence certifies clear
      const moved = decisionOf(await plan([{ id: 'cue-face', startFrame: 290, endFrame: 320 }]), 'cue-face')
      assert.equal(moved.bandAssessments.bottom.face.state, 'occupied')
      assert.equal(moved.disposition, 'placed')
      assert.notEqual(moved.anchor, 'bottom')
      assert.equal(moved.bandAssessments[moved.anchor].face.state, 'free-certified')

      // one stream across two adjacent windows
      const across = await plan([{ id: 'cue-across', startFrame: 235, endFrame: 265 }])
      assert.deepEqual(across.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].trustedEnvelopeHashes.toSorted(), [clean.envelopeHash, occupied.envelopeHash].toSorted())
      assert.equal(decisionOf(across, 'cue-across').disposition, 'placed')

      // no window over the cue: withheld, and the windows that would certify it are listed
      const withheld = await plan([{ id: 'cue-uncovered', startFrame: 500, endFrame: 530 }])
      assert.equal(decisionOf(withheld, 'cue-uncovered').disposition, 'review-required')
      assert.deepEqual(withheld.requiredFaceWindows, [{ sourceArtifactId: world.sourceId, windows: [{ startTimelineFrame: 485, endTimelineFrame: 545 }] }])

      // evidence is scoped: another Version, another workspace and another source find nothing
      for (const scope of [{ projectVersionId: `stale-${randomUUID()}` }, { workspaceId: world.otherWorkspaceId }]) {
        const isolated = await plan([{ id: 'cue-clean', startFrame: 130, endFrame: 170 }], scope)
        assert.equal(decisionOf(isolated, 'cue-clean').disposition, 'review-required', JSON.stringify(scope))
        assert.equal(isolated.placementPlan.subtitleAnchorPlan.faceClearance.streams.length, 0)
      }
      const otherSource = await plan([{ id: 'cue-clean', startFrame: 130, endFrame: 170 }],
        { renderSources: [{ artifactId: world.sourceId, sha256: 'f'.repeat(64), mediaType: 'video', probe: { width: 720, height: 1280 } }] })
      assert.equal(decisionOf(otherSource, 'cue-clean').disposition, 'review-required', 'a window sealed over other bytes is not evidence of these bytes')
      assert.equal(otherSource.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].untrusted.length, 1)

      // the evidence is part of the placement identity
      const again = await plan([{ id: 'cue-clean', startFrame: 130, endFrame: 170 }])
      assert.equal(again.placementPlan.placementPlanHash, placed.placementPlan.placementPlanHash)
      const noEvidence = await planCaptionPlacement({ clock: () => new Date() }, { workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, format: '9:16', canvas: CANVAS, editPlan: world.plan, clips,
        renderSources: [{ artifactId: world.sourceId, sha256: world.sourceSha256, mediaType: 'video', probe: { width: 720, height: 1280 } }],
        subtitleCues: [{ id: 'cue-clean', startFrame: 130, endFrame: 170 }], subtitlePresetId: 'kinetic', placementElements: [],
        primarySourceArtifactId: world.sourceId, faceEvidenceAllowed: true })
      assert.notEqual(noEvidence.placementPlan.placementPlanHash, placed.placementPlan.placementPlanHash)

      // tamper: a stored raw output no longer matches its seal - the render stops, the row is never read as evidence
      const raw = await db.v2FaceProducerRawOutput.findFirstOrThrow({ where: { envelopeId: clean.id }, orderBy: { sampleIndex: 'asc' } })
      const flipped = Buffer.from(raw.rawBytes); flipped[3] ^= 1
      await db.v2FaceProducerRawOutput.update({ where: { id: raw.id }, data: { rawBytes: flipped } })
      await assert.rejects(plan([{ id: 'cue-clean', startFrame: 130, endFrame: 170 }]), /raw output/i)
      await db.v2FaceProducerRawOutput.update({ where: { id: raw.id }, data: { rawBytes: raw.rawBytes } })
      assert.equal(decisionOf(await plan([{ id: 'cue-clean', startFrame: 130, endFrame: 170 }]), 'cue-clean').disposition, 'placed')
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })
