import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { planCaptionPlacement } = await import('../../src/v2/application/plan-caption-placement.ts')
const { subtitleAnchorDecisionFor } = await import('../../src/v2/domain/subtitle-anchor-plan.ts')
const { PrismaFaceSourceWindowRepository } = await import('../../src/v2/infrastructure/prisma/face-source-window-repository.ts')
const { hydrateProxyRenderSources, queryProxySourceProject } = await import('../../src/v2/infrastructure/prisma/proxy-source-authority.ts')
import { directorCut, finish, peerProject, sourceWindowHarness } from './helpers/face-source-pg.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

/**
 * W65 / W65b PostgreSQL proof of the caption placement over real sealed SOURCE face windows (written for a supervised run; not run in CI).
 *
 * The windows are produced by the real V9 source-window worker over a database, with a detector stand-in that returns real V9
 * tensors; the planner then reads them back through `PrismaFaceSourceWindowRepository.listSourceWindows` exactly as the render
 * worker does. What it must establish, in a database and not in a stand-in:
 *  - a cue inside a clean, complete, authenticated window is placed, and the plan names that window's seal;
 *  - a detected face under a band occupies it and the caption moves to a band that is certified clear;
 *  - a cue with no window, in another workspace, in a project without the source, or past the last window is withheld
 *    (review-required), with the SOURCE windows that would let it be certified listed;
 *  - the evidence belongs to the source: a Director cut that plays it through several trimmed clips, under a Version that did not
 *    exist when the windows were produced, reads the SAME windows through its own clips, and answers differently from a reading
 *    keyed by the timeline would;
 *  - a tampered stored row stops the render instead of being read as evidence;
 *  - the evidence is part of the placement identity.
 */
const CANVAS = Object.freeze({ width: 540, height: 960 })
const FAR_FACE = [0.9, 0.0, 0.0, 0.03, 0.05]
const FACE_AT_THE_BOTTOM = [0.9, 0.10, 0.72, 0.90, 0.98]
const SOURCE_PROBE = Object.freeze({ width: 720, height: 1280 })

test('W65b PostgreSQL caption placement: sealed source windows place, move or withhold each cue; scope, Director cuts and tamper are enforced',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = sourceWindowHarness(db, world)
      const repository = new PrismaFaceSourceWindowRepository(db)
      // Both windows are requested under the world's FIRST head Version, in the source's own frames.
      const clean = await run.publish('clean', { startSourceFrame: 100, endSourceFrame: 250 }, () => [FAR_FACE])
      const occupied = await run.publish('face', { startSourceFrame: 250, endSourceFrame: 400 },
        (frame) => (frame >= 280 && frame <= 320 ? [FACE_AT_THE_BOTTOM] : [FAR_FACE]))
      assert.equal(clean.schemaVersion, 'face-producer-envelope/v3')

      const clips = world.plan.videoTracks.find((track) => track.kind === 'base-video').clips

      // the render source carries the dimensions its manifest recorded: that is what lets the planner project it
      const project = await queryProxySourceProject(db, { workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        editPlanSnapshotId: world.editId, sourceArtifactId: world.sourceId, sourceManifestId: world.recording.names.sourceManifestId })
      const [asset] = hydrateProxyRenderSources(project, world.plan, new Date())
      const manifestRow = await db.v2MediaArtifactManifest.findFirstOrThrow({ where: { id: world.recording.names.sourceManifestId, workspaceId: world.workspaceId } })
      const recorded = JSON.parse(manifestRow.manifestJson).probe
      assert.ok(recorded.width >= 2 && recorded.height >= 2)
      assert.deepEqual({ ...asset.probe }, { width: recorded.width, height: recorded.height })
      const renderSources = (sha256 = world.sourceSha256) => [{ artifactId: world.sourceId, sha256, mediaType: 'video', probe: SOURCE_PROBE }]
      const plan = (cues, extra = {}) => planCaptionPlacement(
        { faceEvidence: repository, clock: () => new Date() },
        { workspaceId: world.workspaceId, projectId: world.projectId, format: '9:16', canvas: CANVAS,
          editPlan: world.plan, clips, renderSources: renderSources(),
          subtitleCues: cues, subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: world.sourceId, ...extra })
      const decisionOf = (result, cueId) => subtitleAnchorDecisionFor(result.placementPlan.subtitleAnchorPlan, cueId)
      const CLEAN_CUE = [{ id: 'cue-clean', startFrame: 130, endFrame: 170 }]

      // one clip playing the whole source from frame 0: timeline and source frames coincide
      const placed = await plan(CLEAN_CUE)
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

      // no window over the cue: withheld, and the SOURCE windows that would certify it are listed
      const withheld = await plan([{ id: 'cue-uncovered', startFrame: 500, endFrame: 530 }])
      assert.equal(decisionOf(withheld, 'cue-uncovered').disposition, 'review-required')
      assert.deepEqual(withheld.requiredFaceWindows, [{ sourceArtifactId: world.sourceId, windows: [{ startSourceFrame: 485, endSourceFrame: 545 }] }])

      // evidence is scoped to the workspace and to the projects that have the source
      const otherWorkspace = await plan(CLEAN_CUE, { workspaceId: world.otherWorkspaceId })
      assert.equal(decisionOf(otherWorkspace, 'cue-clean').disposition, 'review-required')
      assert.equal(otherWorkspace.placementPlan.subtitleAnchorPlan.faceClearance.streams.length, 0)
      const without = await peerProject(db, world, { attach: false, label: 'nosource' })
      const withoutSource = await plan(CLEAN_CUE, { projectId: without.projectId })
      assert.equal(decisionOf(withoutSource, 'cue-clean').disposition, 'review-required', 'a project that does not have the source finds no evidence of it')
      assert.equal(withoutSource.placementPlan.subtitleAnchorPlan.faceClearance.streams.length, 0)
      // a sibling project that has the same source attached reuses the very same windows
      const peer = await peerProject(db, world, { label: 'peer' })
      const reused = await plan(CLEAN_CUE, { projectId: peer.projectId })
      assert.equal(decisionOf(reused, 'cue-clean').disposition, 'placed')
      assert.deepEqual(reused.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].trustedEnvelopeHashes, [clean.envelopeHash])
      // a window sealed over other bytes is not evidence of these bytes
      const otherSource = await plan(CLEAN_CUE, { renderSources: renderSources('f'.repeat(64)) })
      assert.equal(decisionOf(otherSource, 'cue-clean').disposition, 'review-required')
      assert.equal(otherSource.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].untrusted.length, 1)

      // the evidence is part of the placement identity
      const again = await plan(CLEAN_CUE)
      assert.equal(again.placementPlan.placementPlanHash, placed.placementPlan.placementPlanHash)
      const noEvidence = await planCaptionPlacement({ clock: () => new Date() }, { workspaceId: world.workspaceId, projectId: world.projectId,
        format: '9:16', canvas: CANVAS, editPlan: world.plan, clips, renderSources: renderSources(),
        subtitleCues: CLEAN_CUE, subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: world.sourceId })
      assert.notEqual(noEvidence.placementPlan.placementPlanHash, placed.placementPlan.placementPlanHash)

      // ---- a Director cut under a Version that did not exist when the windows were produced ---------------------------------
      // timeline [0,50) plays source [280,330) (where the face is), [50,150) plays source [120,220) (clean), then a jump to source
      // [600,650) which no window covers. A reading keyed by the TIMELINE would look at source frames 0-200 for all of it.
      const cut = await directorCut(db, world, [
        { sourceInFrame: 280, sourceOutFrame: 330, timelineInFrame: 0, timelineOutFrame: 50 },
        { sourceInFrame: 120, sourceOutFrame: 220, timelineInFrame: 50, timelineOutFrame: 150 },
        { sourceInFrame: 600, sourceOutFrame: 650, timelineInFrame: 150, timelineOutFrame: 200 },
      ])
      assert.notEqual(cut.versionId, world.versionId, 'the cut is a new head Version')
      const head = await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId } })
      assert.equal(head.currentVersionId, cut.versionId)
      const planCut = (cues, extra = {}) => planCaptionPlacement(
        { faceEvidence: repository, clock: () => new Date() },
        { workspaceId: world.workspaceId, projectId: world.projectId, format: '9:16', canvas: CANVAS,
          editPlan: { fps: 30, durationFrames: cut.durationFrames }, clips: cut.clips, renderSources: renderSources(),
          subtitleCues: cues, subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: world.sourceId, ...extra })
      // timeline [10,40) is source [290,320): the face is at the bottom there, so the caption moves - from a window of source frames
      const overFace = await planCut([{ id: 'cut-face', startFrame: 10, endFrame: 40 }])
      assert.equal(decisionOf(overFace, 'cut-face').bandAssessments.bottom.face.state, 'occupied')
      assert.equal(decisionOf(overFace, 'cut-face').disposition, 'placed')
      assert.notEqual(decisionOf(overFace, 'cut-face').anchor, 'bottom')
      assert.deepEqual(overFace.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].trustedEnvelopeHashes, [occupied.envelopeHash],
        'the cue reads the window of source frames 250-400, produced under an earlier Version')
      // timeline [70,110) is source [140,180): clean, so the preferred band stands
      const overClean = await planCut([{ id: 'cut-clean', startFrame: 70, endFrame: 110 }])
      assert.equal(decisionOf(overClean, 'cut-clean').disposition, 'placed')
      assert.equal(decisionOf(overClean, 'cut-clean').anchor, 'bottom')
      assert.deepEqual(overClean.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].trustedEnvelopeHashes, [clean.envelopeHash])
      // the jump to source [600,650) has no window: withheld, and the SOURCE window to request is the source's, not the timeline's
      const jump = await planCut([{ id: 'cut-jump', startFrame: 160, endFrame: 190 }])
      assert.equal(decisionOf(jump, 'cut-jump').disposition, 'review-required')
      assert.deepEqual(jump.requiredFaceWindows, [{ sourceArtifactId: world.sourceId, windows: [{ startSourceFrame: 610 - 15, endSourceFrame: 640 + 15 }] }])
      // a cue across a cut is measured in both clips and never as one run through the skipped source frames
      const acrossCut = await planCut([{ id: 'cut-across', startFrame: 40, endFrame: 60 }])
      assert.equal(decisionOf(acrossCut, 'cut-across').bandAssessments.bottom.face.state, 'occupied', 'the part over source 320-330 sees the face of frame 320')
      assert.deepEqual(acrossCut.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].trustedEnvelopeHashes.toSorted(),
        [clean.envelopeHash, occupied.envelopeHash].toSorted(), 'both clips are read, each from its own window of the source')
      // the same cue timeline read through the ORIGINAL one-clip plan is another answer entirely (source frames 10-40: no window)
      const timelineKeyed = await plan([{ id: 'cut-face', startFrame: 10, endFrame: 40 }])
      assert.equal(decisionOf(timelineKeyed, 'cut-face').disposition, 'review-required')

      // the Director cut's Version does not change the evidence a sibling project reads
      const peerAgain = await plan(CLEAN_CUE, { projectId: peer.projectId })
      assert.equal(peerAgain.placementPlan.placementPlanHash, reused.placementPlan.placementPlanHash)

      // tamper: a stored raw output no longer matches its seal - the render stops, the row is never read as evidence
      const raw = await db.v2FaceSourceWindowRawOutput.findFirstOrThrow({ where: { envelopeId: clean.id }, orderBy: { sampleIndex: 'asc' } })
      const flipped = Buffer.from(raw.rawBytes); flipped[3] ^= 1
      await db.v2FaceSourceWindowRawOutput.update({ where: { id: raw.id }, data: { rawBytes: flipped } })
      await assert.rejects(plan(CLEAN_CUE), /raw output/i)
      await assert.rejects(planCut([{ id: 'cut-clean', startFrame: 70, endFrame: 110 }]), /raw output/i)
      await db.v2FaceSourceWindowRawOutput.update({ where: { id: raw.id }, data: { rawBytes: raw.rawBytes } })
      assert.equal(decisionOf(await plan(CLEAN_CUE), 'cue-clean').disposition, 'placed')
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })
