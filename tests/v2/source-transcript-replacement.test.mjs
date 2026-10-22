import assert from 'node:assert/strict'
import test from 'node:test'

import { assertDirectorSnapshotContent } from '../../src/v2/application/director-snapshot-identity.ts'
import { replaceSourceTranscriptService } from '../../src/v2/application/replace-source-transcript.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { calculateVersionHash, stableSerialize } from '../../src/v2/application/version-hash.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { operationalBundlePlanV3 } from '../../src/v2/domain/output-version-bundle.ts'
import { childCommandOf } from '../../src/v2/domain/project-output-state-transition.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { readByInterpreter } from './helpers/editorial-request-fixture.mjs'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import {
  createSourceTranscriptArtifactInvalidations,
  materializeSourceTranscriptReplacement,
} from '../../src/v2/domain/source-transcript-replacement.ts'
import { readPersistedOperationalOutputBundleV3 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'
import { ingestedWorld, recompiledChild } from './helpers/output-world.mjs'
import { persistedOutputQueries } from './helpers/persisted-output-client.mjs'

const currentTranscript = createMediaTranscript({
  language: 'pt-BR', text: 'texto antigo', provider: 'groq', model: 'whisper-large-v3',
  words: [{ word: 'texto', start: 0.2, end: 0.5 }, { word: 'antigo', start: 1.2, end: 1.7 }],
  segments: [{ id: 0, start: 0.2, end: 1.7, text: 'texto antigo' }],
})
const replacementTranscript = createMediaTranscript({
  language: 'pt-BR', text: 'texto corrigido depois', provider: 'groq', model: 'whisper-large-v3',
  words: [
    { word: 'texto', start: 0.2, end: 0.5 },
    { word: 'corrigido', start: 1.2, end: 1.7 },
    { word: 'depois', start: 2.2, end: 2.6 },
  ],
  segments: [{ id: 0, start: 0.2, end: 2.6, text: 'texto corrigido depois' }],
})

/**
 * The seconds -> source-frame step is `ceil(start*fps - 1e-7)` /
 * `floor(end*fps + 1e-7)`. Anchoring on half frames makes the intended source
 * frame unambiguous regardless of binary rounding, so the tests below can state
 * source frames and expected timeline frames instead of opaque decimals.
 */
const FPS = 30
const startSecondsForFrame = (frame) => (frame === 0 ? 0 : (frame - 0.5) / FPS)
const endSecondsForFrame = (frame) => (frame + 0.5) / FPS

function transcriptFromFrames(id, entries) {
  const words = entries.map(([word, startFrame, endFrame]) => ({
    word, start: startSecondsForFrame(startFrame), end: endSecondsForFrame(endFrame),
  }))
  return createMediaTranscript({
    language: 'pt-BR', text: entries.map(([word]) => word).join(' '),
    provider: 'groq', model: 'whisper-large-v3',
    words,
    segments: [{ id: 0, start: words[0].start, end: words[words.length - 1].end, text: entries.map(([word]) => word).join(' ') }],
  })
}

function plan() {
  return {
    schemaVersion: 2, state: 'compiled', id: 'edit-plan-base', projectVersionId: 'version-base',
    fps: 30, durationFrames: 60,
    videoTracks: [{ id: 'base-video', kind: 'base-video', clips: [
      { id: 'clip-a', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
      { id: 'clip-broll', sourceArtifactId: 'artifact-broll', audioSourceArtifactId: 'artifact-master', audioSourceInFrame: 30, audioSourceOutFrame: 60, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
    ] }],
    subtitleTracks: [],
    retimedTranscript: {
      sourceTranscriptId: 'transcript-current',
      sourceTranscriptHash: currentTranscript.transcriptHash,
      words: [],
    },
    createdAt: '2026-07-31T22:00:00.000Z',
  }
}

// The service tests run on a real sealed Version3/State3: the parent bundle of the shared output world, whose
// source is 'artifact-source3' (2s by default, 20s when a test needs room for several clips).
let worldPromise
const sharedWorld = () => (worldPromise ??= ingestedWorld())
// The same recording ingested into a project with TWO outputs (one EditPlan, two State entries).
let twoOutputPromise
const twoOutputs = () => (twoOutputPromise ??= ingestedWorld({ sibling: true }))
const variantIdsOf = (parent) => parent.state.document.entries.map((entry) => entry.variantId)
const parentPlanOf = (parent) => JSON.parse(operationalBundlePlanV3(parent).contentJson)

function replacementContext(parent, replacement, overrides = {}) {
  const snapshot = operationalBundlePlanV3(parent), editPlan = JSON.parse(snapshot.contentJson)
  return {
    parent, editPlan, editPlanHash: snapshot.contentHash,
    currentTranscript: { id: editPlan.retimedTranscript.sourceTranscriptId, transcriptHash: editPlan.retimedTranscript.sourceTranscriptHash, sourceArtifactId: 'artifact-source3' },
    replacementTranscript: { id: 'transcript-replacement', transcriptHash: replacement.transcriptHash, sourceArtifactId: 'artifact-source3', transcript: replacement },
    outputReferences: [
      { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: parent.version.id, variantId: variantIdsOf(parent)[0] },
      { artifactId: 'final-16x9', kind: 'final', sourceVersionId: parent.version.id, variantId: variantIdsOf(parent)[0] },
    ],
    ...overrides,
  }
}

class Repository {
  committed
  constructor(parent, replacement = replacementTranscript, overrides = {}) { this.parent = parent; this.replacement = replacement; this.overrides = overrides }
  async findIdempotentResult() { return this.committed ?? null }
  async readContext() { return replacementContext(this.parent, this.replacement, this.overrides) }
  async commitOrReplay(input) {
    const { bundle } = input, command = bundle.origin.command
    const invalidations = createSourceTranscriptArtifactInvalidations({ impact: command.payload.impact, createdAt: command.createdAt })
    const result = {
      command, version: bundle.version,
      editPlan: JSON.parse(bundle.editPlanSnapshot.contentJson), impact: command.payload.impact,
      invalidations, replayed: false, snapshot: bundle.editPlanSnapshot, bundle,
    }
    this.committed = { requestFingerprint: bundle.origin.requestFingerprint, result }
    return result
  }
}

const serviceFor = (repository, label) => {
  let id = 0
  return replaceSourceTranscriptService({
    repository,
    clock: () => new Date('2026-10-16T22:10:00.000Z'),
    createId: (kind) => `${kind}-${label}-${++id}`,
    createEventId: () => '123e4567-e89b-42d3-a456-426614174000',
  })
}

const requestFor = (parent, actor, replacement, key) => ({
  workspaceId: parent.version.workspaceId, projectId: parent.version.projectId,
  baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
  replacementTranscriptId: 'transcript-replacement',
  expectedTranscriptHash: replacement.transcriptHash,
  actor, idempotencyKey: key,
})

test('T-FR-233 source transcript replacement retimes immutable evidence and blocks render until DirectorRun', async () => {
  const { parent, actor } = await sharedWorld()
  const repository = new Repository(parent)
  const execute = serviceFor(repository, 'transcript')
  const request = requestFor(parent, actor, replacementTranscript, 'source-transcript-replacement-1')
  const result = await execute(request)
  assert.equal(result.command.type, 'replace-source-transcript')
  assert.equal(result.version.outputContractVersion, 3)
  assert.equal(result.version.sequence, parent.version.sequence + 1)
  assert.equal(result.editPlan.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
  assert.equal(result.editPlan.retimedTranscript.sourceTranscriptHash, replacementTranscript.transcriptHash)
  assert.deepEqual(
    result.editPlan.retimedTranscript.words.map((word) => [word.text, word.timelineStartFrame, word.timelineEndFrame]),
    [['texto', 6, 15], ['corrigido', 36, 51]],
  )
  assert.equal(result.editPlan.retimedTranscript.words.some((word) => word.text === 'depois'), false)
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 60 }])
  assert.deepEqual(result.impact.affectedVariantIds, variantIdsOf(parent))
  assert.equal(result.impact.renderBlockedUntilDirectorRun, true)
  assert.equal(result.invalidations.length, 2)
  assert.ok(result.invalidations.every((item) => item.status === 'stale'))
  assert.equal(result.command.payload.nextRequiredCapability, 'apollo.projects.commands.apply:run-director')
  // The Version is bound to a sealed State: every member re-materializes from the retimed plan
  // and from the parent's exact observations.
  const { bundle } = result
  assert.equal(bundle.state.document.transition, 'inherit')
  assert.equal(bundle.state.document.parentStateHash, parent.state.stateHash)
  assert.equal(bundle.origin.kind, 'child-command')
  assert.deepEqual(bundle.origin.replaces, [])
  assert.equal(bundle.origin.audit.credentialId, actor.credentialId)
  assert.equal(bundle.version.snapshotRefs.editPlan, bundle.editPlanSnapshot.id)
  for (const entry of bundle.state.document.entries) {
    assert.equal(entry.consumption.status, 'materialized')
    assert.equal(entry.consumption.materialization.document.planSnapshotId, bundle.editPlanSnapshot.id)
  }
  const replay = await execute(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.version.id, result.version.id)
})

test('W66 multi-output: a source transcript replacement on a project with two outputs stales the renders of EVERY output, each under its own output', async () => {
  const { parent, actor } = await twoOutputs()
  const variantIds = variantIdsOf(parent)
  assert.equal(variantIds.length, 2)
  const references = variantIds.flatMap((variantId, index) => [
    { artifactId: `proxy-two-outputs-${index}`, kind: 'proxy', sourceVersionId: parent.version.id, variantId },
    { artifactId: `final-two-outputs-${index}`, kind: 'final', sourceVersionId: parent.version.id, variantId },
  ])
  const repository = new Repository(parent, replacementTranscript, { outputReferences: references })
  const request = requestFor(parent, actor, replacementTranscript, 'source-transcript-replacement-two-outputs')
  // The Command names no output: the replacement retimes the one EditPlan every output re-materializes from.
  assert.equal('variantId' in request, false)
  const result = await serviceFor(repository, 'two-outputs')(request)
  assert.deepEqual(result.impact.affectedVariantIds, [...variantIds].sort())
  assert.deepEqual(result.impact.affectedArtifacts.map((item) => [item.kind, item.artifactId, item.variantId]).toSorted(),
    references.map((item) => [item.kind, item.artifactId, item.variantId]).toSorted())
  assert.equal(result.invalidations.length, 4)
  assert.deepEqual([...new Set(result.invalidations.map((item) => item.variantId))].sort(), [...variantIds].sort())
  // the child Version carries EVERY entry, each output keeping its own spec revision and spec hash
  const entries = result.bundle.state.document.entries
  assert.deepEqual(entries.map((entry) => entry.variantId), variantIds)
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.outputSpecRevisionId, parent.state.document.entries[index].outputSpecRevisionId)
    assert.equal(entry.specHash, parent.state.document.entries[index].specHash)
    assert.equal(entry.consumption.status, 'materialized')
  }
})

test('T-FR-233 source transcript replacement fails closed on cross-source and hash drift', async () => {
  const { parent, actor } = await sharedWorld()
  const repository = new Repository(parent)
  const execute = serviceFor(repository, 'transcript-test')
  const base = requestFor(parent, actor, replacementTranscript, 'source-transcript-replacement-2')
  await assert.rejects(() => execute({ ...base, expectedTranscriptHash: 'f'.repeat(64) }), (error) => error.code === 'VERSION_CONFLICT')
  repository.overrides = { replacementTranscript: { id: 'transcript-replacement', transcriptHash: replacementTranscript.transcriptHash, sourceArtifactId: 'artifact-other', transcript: replacementTranscript } }
  await assert.rejects(() => execute({ ...base, idempotencyKey: 'source-transcript-replacement-3' }), (error) => error.code === 'INVALID_ARGUMENT')
  assert.equal(repository.committed, undefined)
  assert.equal(parentPlanOf(parent).retimedTranscript.sourceTranscriptId, 'transcript-ingest3')
})

// ---------------------------------------------------------------------------
// F0.027 slice 2 — retiming for clips with rate != 1
// ---------------------------------------------------------------------------

/**
 * Retiming rule under test (frame-first, timeline is the truth):
 *
 *   sourceStartFrame = ceil(word.start * fps - 1e-7)
 *   sourceEndFrame   = floor(word.end   * fps + 1e-7)
 *   timelineFrame(f) = clamp(
 *     range.timelineInFrame + Math.round((f - range.sourceInFrame) / range.rate),
 *     range.timelineInFrame, range.timelineOutFrame)
 *
 * `Math.round` is exactly the renderer's rounding, so a plan the replacement
 * accepts is a plan the renderer accepts. At rate 1 the division is the
 * identity and every frame equals the pre-rate arithmetic.
 */
function ratePlan(clips, durationFrames) {
  return {
    schemaVersion: 2, state: 'compiled', id: 'edit-plan-base', projectVersionId: 'version-base',
    fps: FPS, durationFrames,
    videoTracks: [{ id: 'base-video', kind: 'base-video', clips }],
    subtitleTracks: [],
    retimedTranscript: {
      sourceTranscriptId: 'transcript-current',
      sourceTranscriptHash: currentTranscript.transcriptHash,
      words: [],
    },
    createdAt: '2026-07-31T22:00:00.000Z',
  }
}

function materialize(editPlan, transcript = replacementTranscript) {
  return materializeSourceTranscriptReplacement({
    editPlan,
    replacement: { id: 'transcript-replacement', sourceArtifactId: 'artifact-master', transcript },
    newVersionId: 'version-next',
    createdAt: '2026-07-31T22:10:00.000Z',
  })
}

const retimed = (result) =>
  result.retimedTranscript.words.map((word) => [word.text, word.timelineStartFrame, word.timelineEndFrame])

test('T-FR-233 rate 1 retiming stays byte-identical and deterministic', () => {
  const first = materialize(plan())
  const second = materialize(plan())
  // Same values as the unit-rate assertions above, produced by the rate-aware path.
  assert.deepEqual(retimed(first), [['texto', 6, 15], ['corrigido', 36, 51]])
  // Byte-for-byte determinism: the stable serialization and the version hash of
  // two independent materializations must be identical, so the snapshot content
  // hash of an unchanged plan can never drift.
  assert.equal(stableSerialize(first), stableSerialize(second))
  assert.equal(calculateVersionHash(first), calculateVersionHash(second))
  // Pinned digest of the materialized plan produced by the pre-rate
  // implementation (commit f2a114c). Any drift in the rate-1 path changes it.
  assert.equal(
    calculateVersionHash(first),
    'a1fd0fc790b18324207375c7820a8cfbd6249d3e54fb4314b4716c648759c888',
  )
})

test('T-FR-233 rate 2 compresses transcript evidence with the renderer rounding', () => {
  // 60 source frames at rate 2 occupy round(60/2) = 30 timeline frames.
  const result = materialize(ratePlan([
    { id: 'clip-fast', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 30, rate: 2 },
  ], 30))
  // texto  -> source 6..15  -> round(6/2)=3,  round(15/2)=8  (Math.round(7.5)=8)
  // corrig -> source 36..51 -> round(36/2)=18, round(51/2)=26 (Math.round(25.5)=26)
  // depois -> source 66..78 -> not fully inside [0,60] -> discarded, never interpolated
  assert.deepEqual(retimed(result), [['texto', 3, 8], ['corrigido', 18, 26]])
})

test('T-FR-233 rate 0.5 expands transcript evidence', () => {
  // 60 source frames at rate 0.5 occupy round(60/0.5) = 120 timeline frames.
  const result = materialize(ratePlan([
    { id: 'clip-slow', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 120, rate: 0.5 },
  ], 120))
  assert.deepEqual(retimed(result), [['texto', 12, 30], ['corrigido', 72, 102]])
})

test('T-FR-233 each word is retimed through the timeline clip that fully contains it, at that clip rate', () => {
  // Two non-overlapping ranges of the SAME source with different rates.
  const result = materialize(ratePlan([
    { id: 'clip-unit', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
    { id: 'clip-fast', sourceArtifactId: 'artifact-master', sourceInFrame: 30, sourceOutFrame: 90, timelineInFrame: 30, timelineOutFrame: 60, rate: 2 },
  ], 60))
  assert.deepEqual(retimed(result), [
    ['texto', 6, 15], // source 6..15 fits clip-unit (rate 1): offsets pass through
    ['corrigido', 33, 41], // source 36..51 in clip-fast: 30+round(6/2)=33, 30+round(21/2)=41
    ['depois', 48, 54], // source 66..78 in clip-fast: 30+round(36/2)=48, 30+round(48/2)=54
  ])
})

test('T-FR-233 transcript evidence follows timeline order when source chronology is reordered', () => {
  const reorderedTranscript = transcriptFromFrames('t', [
    ['primeiro-no-source', 6, 15],
    ['segundo-no-source', 66, 78],
  ])
  const result = materialize(ratePlan([
    { id: 'clip-late-source', sourceArtifactId: 'artifact-master', sourceInFrame: 60, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
    { id: 'clip-early-source', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
  ], 60), reorderedTranscript)
  assert.deepEqual(retimed(result), [
    ['segundo-no-source', 6, 18],
    ['primeiro-no-source', 36, 45],
  ])
})

test('T-FR-233 repeated source audio produces one evidence occurrence per timeline occurrence', () => {
  const repeatedTranscript = transcriptFromFrames('t', [['repetida', 6, 15]])
  const result = materialize(ratePlan([
    { id: 'clip-repeat-1', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
    { id: 'clip-repeat-2', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
  ], 60), repeatedTranscript)
  assert.deepEqual(retimed(result), [
    ['repetida', 6, 15],
    ['repetida', 36, 45],
  ])
})

test('T-FR-233 retiming follows the audio source range of a retimed B-roll clip', () => {
  // B-roll picture with the master audio underneath: mapping uses audioSource*
  // frames, and the audio is compressed by the same clip rate as the picture.
  const result = materialize(ratePlan([
    {
      id: 'clip-broll', sourceArtifactId: 'artifact-broll',
      sourceInFrame: 0, sourceOutFrame: 60,
      audioSourceArtifactId: 'artifact-master', audioSourceInFrame: 30, audioSourceOutFrame: 90,
      timelineInFrame: 0, timelineOutFrame: 30, rate: 2,
    },
  ], 30))
  // texto (source 6..15) is before the audible window and is discarded.
  assert.deepEqual(retimed(result), [
    ['corrigido', 3, 11], // 0+round((36-30)/2)=3, 0+round((51-30)/2)=11 (Math.round(10.5)=11)
    ['depois', 18, 24], // 0+round((66-30)/2)=18, 0+round((78-30)/2)=24
  ])
})

test('T-FR-233 a word compressed onto a single frame is widened to one frame, or dropped when the clip has no room', () => {
  // Rate 4 collapses a 1-frame word onto a single timeline frame. The rule is
  // deterministic: extend the end to startFrame + 1 when that frame still fits
  // inside the clip, otherwise discard the word. Text is never invented.
  const widened = materialize(
    ratePlan([
      { id: 'clip-x4', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 40, timelineInFrame: 0, timelineOutFrame: 10, rate: 4 },
    ], 10),
    transcriptFromFrames('t', [['curta', 8, 9]]),
  )
  // round(8/4)=2 and round(9/4)=2 collapse; the end is widened to 3 (<= 10).
  assert.deepEqual(retimed(widened), [['curta', 2, 3]])

  // 41 source frames at rate 4 occupy round(41/4) = 10 timeline frames. A word
  // on source frames 40..41 maps to 10..10 after clamping, and frame 11 lies
  // outside the clip, so the word is dropped rather than pushed past the clip.
  const dropped = materialize(
    ratePlan([
      { id: 'clip-x4-edge', sourceArtifactId: 'artifact-master', sourceInFrame: 0, sourceOutFrame: 41, timelineInFrame: 0, timelineOutFrame: 10, rate: 4 },
    ], 10),
    transcriptFromFrames('t', [['inicio', 0, 4], ['fim', 40, 41]]),
  )
  assert.deepEqual(retimed(dropped), [['inicio', 0, 1]])
})

test('T-FR-233 retiming fails closed on unsupported rates and inconsistent clip timing', () => {
  const clip = (overrides) => ({
    id: 'clip-a', sourceArtifactId: 'artifact-master',
    sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1,
    ...overrides,
  })
  for (const rate of [0, -1, -2, Number.NaN, Number.POSITIVE_INFINITY, 0.2, 5]) {
    assert.throws(
      () => materialize(ratePlan([clip({ rate })], 30)),
      (error) => error.code === 'INVALID_ARGUMENT' && /rate is outside the supported range/.test(error.message),
      `rate ${String(rate)} must be rejected`,
    )
  }
  // Timeline span that does not match round(sourceSpan / rate).
  assert.throws(
    () => materialize(ratePlan([clip({ sourceOutFrame: 60, timelineOutFrame: 40, rate: 2 })], 40)),
    (error) => error.code === 'INVALID_ARGUMENT' && /cannot retime transcript evidence/.test(error.message),
  )
  // Audio span that disagrees with the picture span of the same clip.
  assert.throws(
    () => materialize(ratePlan([clip({
      sourceOutFrame: 60, timelineOutFrame: 30, rate: 2,
      audioSourceArtifactId: 'artifact-master', audioSourceInFrame: 30, audioSourceOutFrame: 100,
    })], 30)),
    (error) => error.code === 'INVALID_ARGUMENT' && /cannot retime transcript evidence/.test(error.message),
  )
  // A clip of ANOTHER artifact with broken timing still fails the plan: an
  // internally contradictory plan cannot be trusted to place evidence at all.
  assert.throws(
    () => materialize(ratePlan([
      clip({}),
      { id: 'clip-other', sourceArtifactId: 'artifact-broll', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 3 },
    ], 60)),
    (error) => error.code === 'INVALID_ARGUMENT' && /EditPlan clip 1 cannot retime transcript evidence/.test(error.message),
  )
})

// ---------------------------------------------------------------------------
// Application journey without Postgres: replacement of a mixed-rate timeline -> sealed Version
// ---------------------------------------------------------------------------

const directorSourceRanges = Object.freeze([
  Object.freeze({ id: 'clip-1', sourceInFrame: 0, sourceOutFrame: 100, timelineInFrame: 0, timelineOutFrame: 100, rate: 1 }),
  Object.freeze({ id: 'clip-2', sourceInFrame: 160, sourceOutFrame: 360, timelineInFrame: 100, timelineOutFrame: 200, rate: 2 }),
  Object.freeze({ id: 'clip-3', sourceInFrame: 400, sourceOutFrame: 500, timelineInFrame: 200, timelineOutFrame: 300, rate: 1 }),
])

const directorTranscript = transcriptFromFrames('transcript-replacement', [
  ['Comunicar', 10, 25], // clip-1, rate 1 -> 10..25
  ['perdido', 110, 130], // gap between clip-1 and clip-2 -> discarded
  ['bem', 200, 230], // clip-2, rate 2 -> 100+round(40/2)=120, 100+round(70/2)=135
  ['resultados', 420, 450], // clip-3, rate 1 -> 220..250
])

/** The Director's repository for this journey: the sealed replacement is the head it plans from. */
class DirectorRepository {
  constructor(parent, editPlan, transcriptId) {
    this.snapshotRows = new Map()
    this.parent = parent
    this.editPlan = editPlan
    this.transcriptId = transcriptId
    this.records = new Map()
  }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey }) {
    return this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId }) {
    if (workspaceId !== this.parent.version.workspaceId || projectId !== this.parent.version.projectId) return null
    return {
      workspaceId,
      project: { id: projectId, objective: 'discovery', locale: 'pt-BR' },
      parent: this.parent,
      currentVersion: this.parent.version,
      brief: {
        objective: 'discovery',
        desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
        productionBrief: createProductionBrief({ ownerText: 'Tom: direto, natural e sem efeitos gratuitos.' }),
        editorialRequest: readByInterpreter('Tom: direto, natural e sem efeitos gratuitos.'),
      },
      policies: { automaticZoom: false, faceProtection: true, guardrails: [] },
      editPlan: this.editPlan,
      currentDurationFrames: this.editPlan.durationFrames,
      variantIds: variantIdsOf(this.parent),
      sourceRights: {
        state: 'present', snapshotId: 'rights-transcript-master',
        snapshotHash: 'd'.repeat(64), status: 'approved', consentStatus: 'not-required',
      },
      outputReferences: [
        { artifactId: 'proxy-9x16', kind: 'proxy', sourceVersionId: this.parent.version.id, variantId: variantIdsOf(this.parent)[0] },
      ],
      transcript: {
        id: this.transcriptId, sourceArtifactId: 'artifact-source3', language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3', transcriptHash: directorTranscript.transcriptHash,
      },
    }
  }

  async commitWithCanonicalSnapshots(scope, prepare) {
    // Controlled in-memory transaction: explicit canonical store, no PG claim.
    const rows = new Map(this.snapshotRows)
    const resolve = async (candidates) => candidates.map((candidate) => {
      assert.equal(candidate.workspaceId, scope.workspaceId)
      assert.equal(candidate.projectId, scope.projectId)
      const key = JSON.stringify([candidate.projectId, candidate.kind, candidate.contentHash])
      const stored = rows.get(key)
      if (stored) {
        assertDirectorSnapshotContent(candidate, stored)
        return stored
      }
      rows.set(key, candidate)
      return candidate
    })
    const commit = await prepare(resolve)
    const sealed = childCommandOf(commit.bundle)
    assert.equal(sealed.command.baseVersionId, scope.baseVersionId)
    assert.equal(sealed.command.baseHash, scope.baseHash)
    assert.equal(sealed.requestFingerprint, scope.requestFingerprint)
    this.lastCommit = commit
    const result = Object.freeze({ run: commit.run, command: sealed.command, version: commit.bundle.version, replayed: false })
    this.records.set(`${sealed.command.workspaceId}:${sealed.command.projectId}:${sealed.command.idempotencyKey}`, {
      requestFingerprint: sealed.requestFingerprint, result,
    })
    this.snapshotRows = rows
    return result
  }
}

async function mixedRateReplacement(label) {
  // A 20 second source leaves room for the three clips; the timeline below is the parent the replacement starts from.
  const world = await ingestedWorld({ sourceDurationSeconds: 20 })
  const parent = recompiledChild(world.parent, world.actor, (plan) => ({
    ...plan, durationFrames: 300,
    videoTracks: [{ ...plan.videoTracks[0], clips: directorSourceRanges.map((range) => ({ sourceArtifactId: 'artifact-source3', ...range })) }],
    subtitleTracks: [],
  }), { suffix: `mixed-rate-${label}` })
  const repository = new Repository(parent, directorTranscript)
  const replacement = await serviceFor(repository, `rate-journey-${label}`)(
    requestFor(parent, world.actor, directorTranscript, `source-transcript-rate-journey-${label}`))
  return { world, parent, replacement, chain: [...world.chain, parent, replacement.bundle] }
}

const expectedRetiming = [['Comunicar', 10, 25], ['bem', 120, 135], ['resultados', 220, 250]]

test('T-FR-233 replaced transcript with retimed frames survives the sealed Version and its re-materialized State', async () => {
  const { parent, replacement } = await mixedRateReplacement('sealed')

  // 1. The command retimed the evidence through clips of mixed rates.
  assert.deepEqual(retimed(replacement.editPlan), expectedRetiming)

  // 2. The persistable snapshot carries exactly those frames (no in-memory-only state).
  const persisted = JSON.parse(replacement.snapshot.contentJson)
  assert.equal(replacement.snapshot.kind, 'edit-plan')
  assert.equal(replacement.snapshot.contentHash, calculateVersionHash(replacement.editPlan))
  assert.deepEqual(retimed(persisted), expectedRetiming)
  assert.equal(persisted.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
  assert.equal(persisted.retimedTranscript.words.some((word) => word.text === 'perdido'), false)
  // Every retimed word stays inside its clip and inside the timeline.
  assert.ok(persisted.retimedTranscript.words.every((word) =>
    word.timelineStartFrame >= 0 && word.timelineEndFrame <= persisted.durationFrames &&
    word.timelineEndFrame > word.timelineStartFrame))

  // 3. The Version is bound to a sealed State whose members re-materialized from that very snapshot.
  const { bundle } = replacement
  assert.equal(bundle.version.snapshotRefs.editPlan, replacement.snapshot.id)
  assert.equal(bundle.state.document.parentStateHash, parent.state.stateHash)
  assert.ok(bundle.state.document.entries.length > 0)
  for (const entry of bundle.state.document.entries) {
    assert.equal(entry.consumption.status, 'materialized')
    assert.equal(entry.consumption.materialization.document.planSnapshotId, replacement.snapshot.id)
  }
})

test('T-FR-233 the Director plans from the replaced transcript read out of the sealed replacement', async () => {
  const { world, replacement, chain } = await mixedRateReplacement('director')
  const sealedPlan = JSON.parse(replacement.bundle.editPlanSnapshot.contentJson)
  const directorRepository = new DirectorRepository(replacement.bundle, sealedPlan, 'transcript-replacement')
  const counters = new Map()
  let event = 0
  const runDirector = runProjectDirectorService({
    repository: directorRepository,
    clock: () => new Date('2026-10-16T22:20:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
  })
  const run = await runDirector({
    workspaceId: replacement.bundle.version.workspaceId, projectId: replacement.bundle.version.projectId,
    baseVersionId: replacement.version.id, baseHash: replacement.version.baseHash,
    actor: world.actor,
    idempotency: { key: 'director-after-transcript-replacement' },
    reason: 'Replanejar a composição com a transcrição corrigida.',
  })
  assert.equal(run.run.editPlan.retimedTranscript.sourceTranscriptId, 'transcript-replacement')
  assert.deepEqual(retimed(run.run.editPlan), expectedRetiming)
  assert.equal(run.run.perception.timeline.observations.length, expectedRetiming.length)
  // The Director's own Version is sealed on top of the replacement: its State descends from the replacement's.
  const directed = directorRepository.lastCommit.bundle
  assert.equal(directed.state.document.parentStateHash, replacement.bundle.state.stateHash)
  assert.equal(directed.version.parentVersionId, replacement.version.id)
  assert.deepEqual(directed.origin.replaces, ['brief', 'story', 'treatment'].filter((kind) => directed.version.snapshotRefs[kind] !== replacement.version.snapshotRefs[kind]))
  assert.equal(directed.version.snapshotRefs.policies, replacement.version.snapshotRefs.policies)
  // A Version that replaced brief, treatment and story reads back from its sealed rows exactly as it was sealed.
  const client = { $queryRawUnsafe: persistedOutputQueries([...chain, directed]) }
  const read = await readPersistedOperationalOutputBundleV3(client, { workspaceId: directed.version.workspaceId, projectId: directed.version.projectId, versionId: directed.version.id })
  assert.equal(stableSerialize(read), stableSerialize(directed))
})
