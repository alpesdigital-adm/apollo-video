import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assembleDirectedEditPlan,
  calculateRenderablePlanHash,
} from '../../src/v2/application/renderable-edit-plan.ts'

/**
 * F4.015 / F4.016 — what the stored plan's hash is allowed to miss.
 *
 * `PrismaRenderablePlanSnapshotRepository.hydrate` recomputes this hash over the
 * parsed `planJson` and refuses a row that no longer matches. That refusal is
 * only worth as much as the hash covers, and the first version of it covered a
 * projection: id, ids, fps, duration, the audio timeline hash, sources, clips,
 * transitions, markers, lineage refs and retained ranges. Everything else —
 * `director.decisions` above all, which is the compiler's own reasoning and
 * must never become somebody else's — sat outside it, so an UPDATE that
 * injected a critic's approval and a burned-in CTA recomputed to the same
 * digest and read back clean. Measured on this fixture before the fix:
 * identical hashes.
 *
 * The two properties below are in tension and both are load-bearing:
 * the hash has to change for every field a tamperer would want to change, and
 * it has to NOT change for `createdAt`, or a recompile of an unmoved derivation
 * would conflict with the row it is supposed to replay.
 */

const PLAN = Object.freeze({
  planId: 'plan-hash-1',
  projectVersionId: 'version-hash-1',
  derivedFrom: Object.freeze({ origin: 'react-playback', id: 'map-hash-1', hash: 'a'.repeat(64) }),
  objective: 'discovery',
  fps: 30,
  sources: [{ id: 'source-artifact-1', artifactId: 'artifact-1', kind: 'video', durationSeconds: 10 }],
  clips: [
    {
      id: 'clip-1',
      sourceArtifactId: 'artifact-1',
      sourceInFrame: 0,
      sourceOutFrame: 30,
      timelineInFrame: 0,
      timelineOutFrame: 30,
      rate: 1,
    },
    {
      id: 'clip-2',
      sourceArtifactId: 'artifact-1',
      sourceInFrame: 60,
      sourceOutFrame: 90,
      timelineInFrame: 30,
      timelineOutFrame: 60,
      rate: 1,
    },
  ],
  seams: [{ reason: 'the reactor jumped forward in the reference (seek).' }],
  lineageRefs: ['playback-map:map-hash-1:v1'],
  assumptions: ['No critic scored this plan; the derivation justified itself.'],
  createdAt: '2029-01-01T00:00:00.000Z',
})

const plan = (overrides = {}) => assembleDirectedEditPlan({ ...PLAN, ...overrides })
const copy = (value) => JSON.parse(JSON.stringify(value))

test('T-F4.015 every field of a compiled plan is inside its hash', () => {
  const original = plan()
  const digest = calculateRenderablePlanHash(original)

  const tampers = [
    ['a fabricated critic decision', (document) => {
      document.director.decisions = [{
        id: 'decision-1',
        category: 'narrative',
        choice: 'critic approved',
        reason: 'nobody wrote this',
        evidenceRefs: ['evidence-1'],
        confidence: 1,
        alternatives: [],
      }]
    }],
    ['a burned-in CTA overlay', (document) => {
      document.overlayTracks = [{
        id: 'overlay-cta',
        kind: 'cta',
        text: 'BUY NOW',
        startFrame: 0,
        endFrame: 30,
        desiredActionRef: document.desiredActionRef,
      }]
    }],
    ['a subtitle track nobody wrote', (document) => {
      document.subtitleTracks = [{ id: 'subtitle-1', language: 'pt-BR', blocks: [] }]
    }],
    ['a different composition', (document) => { document.composition.layout = 'portrait-full' }],
    ['automatic zoom switched on', (document) => { document.movementPolicy.automaticZoom = true }],
    ['face protection switched off', (document) => { document.subtitlePolicy.faceProtection = false }],
    ['an editorial exclusion', (document) => {
      document.editorial.exclusions = [{ startMs: 0, endMs: 1_000, reason: 'filler' }]
    }],
    ['a retimed transcript', (document) => {
      document.retimedTranscript = { sourceTranscriptId: 'transcript-1', words: [] }
    }],
    ['a protected element', (document) => { document.protectedElements = ['logo'] }],
    ['a state that is not compiled', (document) => { document.state = 'draft' }],
    ['a different schema version', (document) => { document.schemaVersion = 3 }],
    ['a planner version that names another compiler', (document) => {
      document.director.plannerVersion = 'hand-written/2029'
    }],
    ['an assumption removed', (document) => { document.director.assumptions = [] }],
    ['a clip moved deeper into the master', (document) => {
      document.videoTracks[0].clips[0].sourceInFrame += 300
      document.videoTracks[0].clips[0].sourceOutFrame += 300
    }],
    ['a source swapped', (document) => { document.sources[0].artifactId = 'artifact-other' }],
  ]

  for (const [what, tamper] of tampers) {
    const document = copy(original)
    tamper(document)
    assert.notEqual(
      calculateRenderablePlanHash(document),
      digest,
      `${what} must not survive the hash`,
    )
  }
})

test('T-F4.015 the hash survives a JSON round trip, which is what hydration depends on', () => {
  const original = plan()
  // `hydrate` recomputes over `JSON.parse(row.planJson)`. If the round trip
  // changed the digest, every stored plan would be unreadable the moment it was
  // written, and the guard would be indistinguishable from a broken one.
  assert.equal(calculateRenderablePlanHash(copy(original)), calculateRenderablePlanHash(original))
})

test('T-F4.015 the same cut compiled on two days is one row, not a conflict', () => {
  // The single exclusion, and the reason for it: the snapshot's natural key is
  // the derivation at its hash for one project version, so a recompile has to
  // land on the row it already wrote.
  assert.equal(
    calculateRenderablePlanHash(plan({ createdAt: '2029-01-01T00:00:00.000Z' })),
    calculateRenderablePlanHash(plan({ createdAt: '2031-08-09T17:45:00.000Z' })),
  )
  // And the project version is not excluded with it: the same cut under a newer
  // version is a different plan, or a recompile would replay the older one.
  assert.notEqual(
    calculateRenderablePlanHash(plan()),
    calculateRenderablePlanHash(plan({ projectVersionId: 'version-hash-2' })),
  )
})
