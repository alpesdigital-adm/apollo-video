import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

import { compileVisualMontageRenderInputs } from '../../src/v2/application/compile-visual-montage-render.ts'
import { createStoryDrivenVisualMontage } from '../../src/v2/application/create-story-driven-visual-montage.ts'
import { createLocalDirectorProposalServices } from '../../src/v2/application/execute-director-tools.ts'
import { createStoryPlan, STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'
import { OUTPUT_FORMAT_REGISTRY, readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { createVisualMontagePlan, validateVisualMontage } from '../../src/v2/domain/visual-montage.ts'

const hash = (value) => value.repeat(64)
const planInput = () => ({
  id: 'visual-montage-1', workspaceId: 'workspace-visual', projectId: 'project-visual', projectVersionId: 'version-visual-1',
  storyPlanRef: { id: 'story-visual-1', hash: hash('1') },
  montageSelectionRef: { selectionHash: hash('2'), candidateId: 'candidate-visual-1', candidateHash: hash('3') },
  sourceAudio: { artifactId: 'audio-artifact-1', artifactKey: 'masters/audio.wav', sha256: hash('a'), byteSize: 2048, durationMs: 9000 },
  beatBoundaries: [
    { storyBlockId: 'story-block-1', endMs: 3000, narration: 'Comece pela ideia central.', intention: 'Apresentar a ideia', content: ['ideia'], style: ['abstrato'] },
    { storyBlockId: 'story-block-2', endMs: 6000, narration: 'Veja o processo em movimento.', intention: 'Mostrar o processo', content: ['processo'], style: ['dinâmico'] },
    { storyBlockId: 'story-block-3', endMs: 9000, narration: 'Guarde este princípio.', intention: 'Fixar o princípio', content: ['princípio'], style: ['tipográfico'] },
  ],
  assets: [
    { id: 'image-abstract-1', artifactId: 'artifact-image-1', artifactKey: 'visuals/abstract.png', sha256: hash('b'), byteSize: 1024, kind: 'image', containsPeople: false, personEvidence: { schemaVersion: 'person-presence-evidence/v1', method: 'human-review', containsPeople: false, evidenceHash: hash('e') }, content: ['ideia'], style: ['abstrato'] },
    { id: 'video-shapes-1', artifactId: 'artifact-video-1', artifactKey: 'visuals/shapes.mp4', sha256: hash('c'), byteSize: 4096, kind: 'video', containsPeople: false, personEvidence: { schemaVersion: 'person-presence-evidence/v1', method: 'provider-metadata', containsPeople: false, evidenceHash: hash('f') }, content: ['processo'], style: ['dinâmico'] },
  ],
})

test('T-FR-091 creates one content-addressed beat and real AssetBrief per audio range', () => {
  const plan = createVisualMontagePlan(planInput())
  assert.deepEqual(plan.beats.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 3000], [3000, 6000], [6000, 9000]])
  assert.equal(plan.beats.every((beat) => beat.assetBrief.prohibited.includes('person') && /^[a-f0-9]{64}$/.test(beat.assetBriefHash)), true)
  assert.deepEqual(plan.slots.map(({ kind }) => kind), ['image', 'video', 'card'])
  assert.equal(plan.slots.every(({ containsPeople }) => containsPeople === false), true)
  assert.equal(plan.validation.passed, true)
  assert.match(plan.planHash, /^[a-f0-9]{64}$/)
})

test('T-FR-091 validator exposes five independent signals and fails closed', () => {
  const plan = createVisualMontagePlan(planInput())
  assert.deepEqual(Object.keys(plan.validation.signals), ['coverage', 'repetition', 'rhythm', 'legibility', 'personFree'])
  const broken = validateVisualMontage({ ...plan, slots: plan.slots.map((slot, index) => index === 0 ? { ...slot, endMs: slot.endMs - 1 } : slot) })
  assert.equal(broken.signals.coverage.passed, false)
  assert.equal(broken.signals.personFree.passed, true)
  assert.equal(broken.passed, false)
  const repeated = validateVisualMontage({ ...plan, slots: plan.slots.map((slot, index) => index === 1 ? { ...slot, assetId: plan.slots[0].assetId } : slot) })
  assert.equal(repeated.signals.repetition.passed, false)
  const rushed = validateVisualMontage({ ...plan, beats: plan.beats.map((beat, index) => index === 0 ? { ...beat, endMs: 500 } : beat) })
  assert.equal(rushed.signals.rhythm.passed, false)
  const unreadable = validateVisualMontage({ ...plan, beats: plan.beats.map((beat, index) => index === 0 ? { ...beat, narration: 'x'.repeat(121) } : beat) })
  assert.equal(unreadable.signals.legibility.passed, false)
  const person = validateVisualMontage({ ...plan, slots: plan.slots.map((slot, index) => index === 0 ? { ...slot, containsPeople: true } : slot) })
  assert.equal(person.signals.personFree.passed, false)
  assert.throws(() => createVisualMontagePlan({ ...planInput(), assets: planInput().assets.map((asset, index) => index ? asset : { ...asset, containsPeople: true }) }), /person-free evidence/)
})

test('T-FR-091 compiles synchronized proxy/final RenderInputs with audio-only narration', () => {
  const plan = createVisualMontagePlan(planInput())
  const renderer = { id: 'remotion', version: '4.0.489', digest: hash('d') }
  const compiled = compileVisualMontageRenderInputs({ plan, renderer })
  assert.equal(compiled.proxy.props.primaryVideoAssetId, undefined)
  assert.equal(compiled.proxy.props.primaryAudioAssetId, 'voiceover-audio')
  assert.equal(compiled.proxy.composition.propsHash, compiled.final.composition.propsHash)
  assert.notEqual(compiled.proxy.plan.hash, plan.planHash)
  assert.equal(compiled.proxy.plan.hash, compiled.final.plan.hash)
  assert.equal(compiled.format.registryHash, OUTPUT_FORMAT_REGISTRY.registryHash)
  assert.equal(compiled.format.presetHash, readOutputFormatPreset('9:16').presetHash)
  assert.deepEqual(compiled.format.subtitleBounds, readOutputFormatPreset('9:16').subtitleBounds)
  assert.deepEqual(
    [compiled.proxy.output.width, compiled.proxy.output.height, compiled.final.output.width, compiled.final.output.height],
    [540, 960, 1080, 1920],
  )
  assert.equal(compiled.final.output.durationInFrames, 270)
  assert.deepEqual(compiled.proxy.props.scenes.map(({ type }) => type), ['image-insert', 'image-insert', 'card'])
  assert.throws(
    () => compileVisualMontageRenderInputs({
      plan: { ...plan, slots: plan.slots.map((slot, index) => index === 0 ? { ...slot, endMs: slot.endMs - 1 } : slot) },
      renderer,
    }),
    /changed after planning/,
  )
})

test('T-FR-091 private render asset server owns the narration audio lifecycle', async () => {
  const worker = await readFile(new URL('../../remotion/scripts/render-materialized.mjs', import.meta.url), 'utf8')
  assert.match(worker, /markedProps\.narrationAudioSrc = await markLocation\(markedProps\.narrationAudioSrc\)/)
  assert.match(worker, /markedProps\.narrationAudioSrc = unmarkLocation\(markedProps\.narrationAudioSrc\)/)
})

test('T-FR-091 consumes the exact persisted StoryPlan and Director-selected montage winner', async () => {
  const { schemaVersion: _schemaVersion, ...voiceoverStory } = STORY_GOLDEN_FIXTURES.voiceover
  const storyPlan = createStoryPlan({
    ...voiceoverStory,
    id: 'story-visual-integrated', workspaceId: 'workspace-visual', projectId: 'project-visual',
    projectVersionId: 'version-visual-1', createdBy: { type: 'api-client', id: 'director-client' },
    createdAt: '2026-08-13T20:00:00.000Z',
  })
  const blockOrder = storyPlan.acts.flatMap(({ blockIds }) => blockIds)
  const visualAssets = [
    { ...planInput().assets[0], id: 'image-visual-one' },
    { ...planInput().assets[1], id: 'video-visual-one' },
    { ...planInput().assets[0], id: 'image-visual-two', artifactId: 'artifact-image-2', artifactKey: 'visuals/abstract-2.png', sha256: hash('9') },
  ]
  const candidate = {
    id: 'candidate-visual-integrated', seed: 'seed-visual-integrated',
    storyPlanRef: { id: storyPlan.id, hash: storyPlan.storyHash }, mode: 'chronological',
    hook: { id: blockOrder[0], selfContained: true }, blockOrder, permittedBlockOrders: [blockOrder],
    assets: visualAssets.map(({ id }) => ({ id, rightsApproved: true })), patternBreaks: [],
    maximumPatternBreaks: 4, confidence: 0.95,
    rubricSignals: { narrative: 0.95, objective: 0.9, continuity: 0.9, evidence: 0.85 },
  }
  const directorServices = createLocalDirectorProposalServices({ async searchMedia() { throw new Error('not used') } })
  const directorEvaluation = await directorServices.evaluateCandidate({
    name: 'evaluate-candidate', callId: 'call-visual-integrated', baseVersionId: storyPlan.projectVersionId,
    scope: { workspaceId: storyPlan.workspaceId, projectId: storyPlan.projectId },
    arguments: { candidates: [candidate], rubric: { id: 'montage-rubric-v1', weights: { narrative: 0.35, objective: 0.25, continuity: 0.2, evidence: 0.2 } }, minimumConfidence: 0.7 },
  })
  const montageSelection = directorEvaluation.evaluation
  const plan = createStoryDrivenVisualMontage({
    id: 'visual-montage-integrated', storyPlan, montageSelection,
    sourceAudio: { artifactId: 'audio-artifact-1', artifactKey: 'masters/audio.wav', sha256: hash('a'), byteSize: 2048, durationMs: 8000 },
    narrationByBlockId: Object.fromEntries(blockOrder.map((blockId) => [blockId, `Narracao para ${blockId}.`])),
    assets: visualAssets,
  })
  assert.deepEqual(plan.beats.map(({ storyBlockId }) => storyBlockId), blockOrder)
  assert.deepEqual(plan.storyPlanRef, { id: storyPlan.id, hash: storyPlan.storyHash })
  assert.equal(plan.montageSelectionRef.selectionHash, montageSelection.selectionHash)
  assert.equal(plan.montageSelectionRef.candidateId, montageSelection.winnerId)
  assert.deepEqual(plan.slots.map(({ kind }) => kind), ['image', 'video', 'card', 'image'])
  const square = compileVisualMontageRenderInputs({ plan, renderer: { id: 'remotion', version: '4.0.489', digest: hash('d') }, aspectRatio: '1:1' })
  const squarePreset = readOutputFormatPreset('1:1')
  assert.deepEqual([square.proxy.output.width, square.proxy.output.height], [squarePreset.exportDefaults.proxy.width, squarePreset.exportDefaults.proxy.height])
  assert.deepEqual([square.final.output.width, square.final.output.height], [squarePreset.spec.width, squarePreset.spec.height])
  assert.equal(square.format.presetHash, squarePreset.presetHash)
  assert.deepEqual(square.format.subtitleBounds, squarePreset.subtitleBounds)
  assert.throws(
    () => createStoryDrivenVisualMontage({
      id: 'visual-montage-tampered', storyPlan: { ...storyPlan, objective: 'tampered' }, montageSelection,
      sourceAudio: plan.sourceAudio, narrationByBlockId: Object.fromEntries(blockOrder.map((blockId) => [blockId, blockId])), assets: visualAssets,
    }),
    /hash does not match/,
  )
})
