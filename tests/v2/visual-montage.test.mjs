import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

import { compileVisualMontageRenderInputs } from '../../src/v2/application/compile-visual-montage-render.ts'
import { createVisualMontagePlan, validateVisualMontage } from '../../src/v2/domain/visual-montage.ts'

const hash = (value) => value.repeat(64)
const planInput = () => ({
  id: 'visual-montage-1', workspaceId: 'workspace-visual', projectId: 'project-visual', projectVersionId: 'version-visual-1',
  sourceAudio: { artifactId: 'audio-artifact-1', artifactKey: 'masters/audio.wav', sha256: hash('a'), byteSize: 2048, durationMs: 9000 },
  beatBoundaries: [
    { endMs: 3000, narration: 'Comece pela ideia central.', intention: 'Apresentar a ideia', content: ['ideia'], style: ['abstrato'] },
    { endMs: 6000, narration: 'Veja o processo em movimento.', intention: 'Mostrar o processo', content: ['processo'], style: ['dinâmico'] },
    { endMs: 9000, narration: 'Guarde este princípio.', intention: 'Fixar o princípio', content: ['princípio'], style: ['tipográfico'] },
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
  assert.equal(compiled.proxy.plan.hash, plan.planHash)
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
