import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createOutputSpecRevisionBody } from '../../src/v2/domain/output-spec-revision.ts'
import { createProjectOutputState, calculateOutputBoundVersionHash,
  createIngestOutputVersionProducer, createOutputPlanAuthority } from '../../src/v2/domain/project-output-state.ts'
import { rebuildRetiredContractOneVersion, createHistoricalProjectVersionAudit } from '../../src/v2/domain/project-version.ts'
import { createOutputVariantCommand } from '../../src/v2/domain/output-variant-command.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION,
  serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { assembleDirectedEditPlan } from '../../src/v2/application/renderable-edit-plan.ts'
import { calculateRenderablePlanHash, RENDERABLE_PLAN_COMPILER_VERSION } from '../../src/v2/domain/renderable-plan-authority.ts'

// Explicit controlled values prove contracts; this fixture is no renderer/PG or
// editorial-acceptance evidence. In particular channels=1 is a chosen setting.
const createdAt = '2026-10-11T12:00:00.000Z'
const hash = 'a'.repeat(64)
const provenance = { kind: 'creation-command', id: 'creation-command-root', hash }
const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
const seal = (document) => ({ schemaVersion: document.schemaVersion, document, hash: calculateOutputCanonicalHash(document) })
const encoding = (kind) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
  width: kind === 'final' ? 1080 : 540, height: kind === 'final' ? 1920 : 960, fps: 30,
  quality: { mode: 'crf', value: kind === 'final' ? 18 : 23, preset: kind === 'final' ? 'medium' : 'veryfast' },
  audio: { codec: 'aac', bitrateKbps: kind === 'final' ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
const revision = (variantId = 'variant-alpha', id = 'revision-alpha-1', overrides = {}) => createOutputSpecRevisionBody({
  ...policy,
  id, variantId, workspaceId: 'workspace-output', projectId: 'project-output', revisionNumber: 1,
  output: { schemaVersion: 1, id: variantId, locale: 'pt-BR', aspectRatio: '9:16', width: 1080, height: 1920,
    fps: 30, safeArea: { top: .08, right: .06, bottom: .06, left: .06 }, deliveryProfileId: 'profile-output' },
  profile: { schemaVersion: 'materialized-delivery-profile/v1', id: 'profile-output', version: 1,
    rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final'), proxy: encoding('proxy'),
    proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 2, scaleY: 2 },
    subtitles: { mode: 'none', configuration: null, fontAssets: [] } }, preset: null, createdAt, ...overrides,
})
const clip = (id = 'clip-alpha', sourceArtifactId = 'source-master-alpha', start = 0) => ({
  id, sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: start, timelineOutFrame: start + 90, rate: 1,
})
const plan = (clips = [clip()]) => ({ id: 'edit-plan-output', projectVersionId: 'version-output-root',
  fps: 30, durationFrames: clips.at(-1)?.timelineOutFrame ?? 0,
  videoTracks: clips.length ? [{ id: 'video-track-output', kind: 'base-video', clips }] : [] })
function entry(spec, actualPlan = plan()) {
  const projection = { ...policy, schemaVersion: 'variant-reframe-geometry/v1', variantId: spec.variantId,
    output: { aspectRatio: spec.output.aspectRatio, width: spec.output.width, height: spec.output.height,
      fps: spec.output.fps, proxyToFinal: spec.profile.proxyToFinal },
    timeline: { fps: actualPlan.fps, durationFrames: actualPlan.durationFrames, trackId: actualPlan.videoTracks[0].id },
    clips: actualPlan.videoTracks[0].clips.map((video) => {
      const identity = { sourceArtifactId: video.sourceArtifactId, sourceManifestId: `manifest-${video.id}`,
        sourceManifestHash: hash, sourceSha256: hash }
      const probe = seal({ ...policy, schemaVersion: 'observed-video-probe/v1', ...identity,
        width: 1920, height: 1080, fps: 30, durationFrames: video.sourceOutFrame,
        timebase: { numerator: 1, denominator: 15360 },
        orientation: { rotationDegrees: 0, displayTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1] } })
      return { ...video, ...identity, probe,
        normalization: seal({ ...policy, schemaVersion: 'observed-normalization/v1', ...identity,
          mode: 'verified-source', probeHash: probe.hash }) }
    }),
    composition: {
      foregroundScale: { present: actualPlan.composition?.foregroundScale !== undefined, value: actualPlan.composition?.foregroundScale ?? null },
      verticalPosition: { present: actualPlan.composition?.verticalPosition !== undefined, value: actualPlan.composition?.verticalPosition ?? null },
    },
    globalCropPresent: false }
  return { ...policy, variantId: spec.variantId, outputSpecRevisionId: spec.id, specHash: calculateOutputCanonicalHash(spec), spec,
    geometry: { status: 'verified', projection, projectionHash: calculateOutputCanonicalHash(projection) } }
}
function stateInput(entries = [], actualPlan = plan([]), overrides = {}) {
  const producerDocument = { ...policy, schemaVersion: 'project-created-version/v1', briefHash: hash, policyHash: hash }
  return { ...policy, id: 'output-state-root', workspaceId: 'workspace-output', projectId: 'project-output',
    resultVersionId: 'version-output-root', parentVersionId: entries.length ? 'version-output-parent' : null,
    parentStateId: entries.length ? 'output-state-parent' : null, parentStateHash: entries.length ? hash : null,
    transition: entries.length ? 'create-variant' : 'initialize-empty',
    provenance: entries.length ? { kind: 'edit-command', id: 'command-output-child', hash } : provenance,
    producer: { hash: calculateOutputCanonicalHash(producerDocument), document: producerDocument },
    editPlan: { snapshotId: 'snapshot-edit-plan', hash: calculateCanonicalHash(actualPlan),
      authority: createOutputPlanAuthority({ ...policy, kind: 'project-edit-plan', planDocument: actualPlan }) },
    renderablePlan: null, entries, overlays: [], invalidations: [], createdAt, ...overrides }
}
const createState = (input, actualPlan) => createProjectOutputState(input,
  { editPlanDocument: actualPlan, renderablePlanDocument: null })
function resealGeometry(value, bindProbe = true) {
  for (const geometryClip of value.geometry.projection.clips) {
    if (geometryClip.probe) geometryClip.probe = seal(geometryClip.probe.document)
    if (geometryClip.normalization) {
      if (bindProbe && geometryClip.probe) geometryClip.normalization.document.probeHash = geometryClip.probe.hash
      geometryClip.normalization = seal(geometryClip.normalization.document)
    }
  }
  value.geometry.projectionHash = calculateOutputCanonicalHash(value.geometry.projection)
  return value
}
function versionOf(state, overrides = {}) {
  const body = state.document
  return rebuildRetiredContractOneVersion({ ...policy, id: body.resultVersionId, workspaceId: body.workspaceId, projectId: body.projectId,
    sequence: 1, snapshotRefs: { editPlan: body.editPlan.snapshotId, policies: 'snapshot-policies' },
    baseHash: calculateOutputBoundVersionHash({ workspaceId: body.workspaceId, projectId: body.projectId,
      resultVersionId: body.resultVersionId, parentVersionId: null, previousBaseHash: null,
      producerHash: body.producer.hash, outputStateId: body.id, outputStateHash: state.stateHash }),
    outputState: state, previousBaseHash: null, createdBy: 'actor-output', createdAt, ...overrides })
}

test('W66 two equal-aspect siblings retain distinct variants and exact member revisions', () => {
  const actualPlan = plan()
  const a = entry(revision(), actualPlan), b = entry(revision('variant-beta', 'revision-beta-1'), actualPlan)
  const state = createState(stateInput([b, a], actualPlan), actualPlan)
  assert.deepEqual(state.document.entries.map((value) => value.variantId), ['variant-alpha', 'variant-beta'])
  assert.equal(state.document.entries[0].spec.output.aspectRatio, state.document.entries[1].spec.output.aspectRatio)
  assert.notEqual(state.document.entries[0].outputSpecRevisionId, state.document.entries[1].outputSpecRevisionId)
  assert.throws(() => createState(stateInput([a, { ...b, spec: a.spec, specHash: a.specHash,
    outputSpecRevisionId: a.outputSpecRevisionId }], actualPlan), actualPlan), /exact state entry/)
})

test('W66 new canonical policy has independent JSON/hash goldens and refuses ambiguous JSON', () => {
  const literal = '{"10":"ten","2":"two","A":1,"Z":3,"a":2,"é":"é","𐀀":"unicode"}'
  const input = { '2': 'two', a: 2, '𐀀': 'unicode', Z: 3, '10': 'ten', 'é': 'é', A: 1 }
  assert.equal(serializeOutputCanonicalJson(input), literal)
  assert.equal(calculateOutputCanonicalHash(input), createHash('sha256').update(literal, 'utf8').digest('hex'))
  assert.equal(calculateOutputCanonicalHash({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
  assert.equal(serializeOutputCanonicalJson([1, -0, 1.25]), '[1,0,1.25]')
  assert.equal(serializeOutputCanonicalJson({ '\uE000': 2, '𐀀': 1 }), '{"𐀀":1,"\uE000":2}',
    'new policy orders UTF-16 code units, not locale collation or UTF-8 byte order')
  assert.notEqual(calculateOutputCanonicalHash({ text: 'é' }), calculateOutputCanonicalHash({ text: 'é' }),
    'canonical policy must not normalize text into a different owner input')
  const cyclic = {}; cyclic.self = cyclic
  const accessor = {}; Object.defineProperty(accessor, 'text', { enumerable: true, get() { throw new Error('must not execute getter') } })
  const sparse = Array(1), decorated = [1]; decorated.extra = true
  const hiddenArray = [1]; Object.defineProperty(hiddenArray, 'hidden', { value: true })
  const hiddenObject = {}; Object.defineProperty(hiddenObject, 'hidden', { value: true })
  for (const invalid of [undefined, { text: undefined }, [undefined], sparse, decorated, cyclic,
    hiddenArray, hiddenObject, accessor, new Date(), { [Symbol('field')]: 1 }, '\uD800', { '\uDC00': 'key' }, NaN, Infinity, 1n]) {
    assert.throws(() => serializeOutputCanonicalJson(invalid), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
})

test('W66 canonical arrays refuse foreign prototypes without invoking map overrides or getters', () => {
  let calls = 0
  class ForeignArray extends Array {
    map() { calls++; throw new Error('foreign map must not execute') }
  }
  const subclass = new ForeignArray(1, 2)
  const accessor = [1, 2]
  Object.setPrototypeOf(accessor, Object.create(Array.prototype, {
    map: { get() { calls++; throw new Error('foreign getter must not execute') } },
  }))
  const nullPrototype = [1, 2]; Object.setPrototypeOf(nullPrototype, null)
  for (const value of [subclass, accessor, nullPrototype]) {
    assert.throws(() => serializeOutputCanonicalJson(value), (error) => error.code === 'INVALID_OUTPUT_SPEC')
    assert.throws(() => calculateOutputCanonicalHash(value), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
  assert.equal(calls, 0)
  assert.equal(serializeOutputCanonicalJson([1, { '10': 'ten', '2': 'two' }, [false, null]]),
    '[1,{"10":"ten","2":"two"},[false,null]]')
})

test('W66 State uses the real compiled renderable authority and refuses a rehashed sister Version', () => {
  const compile = (projectVersionId = 'version-output-root') => assembleDirectedEditPlan({
    planId: 'renderable-output-root', projectVersionId,
    derivedFrom: { origin: 'react-playback', id: 'playback-output-root', hash }, objective: 'discovery', fps: 30,
    sources: [{ id: 'source-master-alpha', artifactId: 'source-master-alpha', kind: 'video', durationSeconds: 3 }],
    clips: [clip()], seams: [], lineageRefs: ['source-master-alpha'],
    assumptions: ['Controlled authority and Version binding only'], createdAt })
  const compiled = compile(), edit = { ...plan(), projectVersionId: 'version-output-root' }
  const make = (candidate = compiled, hashOverride = calculateRenderablePlanHash(candidate)) => {
    const member = entry(revision(), candidate)
    const input = stateInput([member], edit, { renderablePlan: { snapshotId: 'renderable-snapshot-output',
      planId: candidate.id, hash: hashOverride,
      authority: createOutputPlanAuthority({ ...policy, kind: 'renderable-edit-plan', planDocument: candidate }) } })
    return { input, facts: { editPlanDocument: edit, renderablePlanDocument: candidate } }
  }
  const positive = make()
  const state = createProjectOutputState(positive.input, positive.facts)
  assert.equal(state.document.renderablePlan.hash, calculateRenderablePlanHash(compiled))
  assert.equal(state.document.renderablePlan.authority.document.legacyHash, calculateRenderablePlanHash(compiled))
  assert.equal(state.document.renderablePlan.authority.document.legacyCanonicalJson.includes(RENDERABLE_PLAN_COMPILER_VERSION), true)
  const later = make({ ...compiled, createdAt: '2030-01-01T00:00:00.000Z' })
  createProjectOutputState(later.input, later.facts)
  const sister = make(compile('version-output-sister'))
  assert.throws(() => createProjectOutputState(sister.input, sister.facts), (error) =>
    error.code === 'INVALID_OUTPUT_SPEC' && /ProjectVersion mismatch/.test(error.message))
  for (const wrongHash of [calculateCanonicalHash(compiled), calculateOutputCanonicalHash(compiled),
    calculateCanonicalHash({ schemaVersion: 'renderable-edit-plan-hash/v1', compilerVersion: RENDERABLE_PLAN_COMPILER_VERSION, plan: compiled })]) {
    const wrong = make(compiled, wrongHash)
    assert.throws(() => createProjectOutputState(wrong.input, wrong.facts), /authority hash/)
  }
  const wrongId = make(); wrongId.input.renderablePlan.planId = 'sister-plan-id'
  assert.throws(() => createProjectOutputState(wrongId.input, wrongId.facts), /Alternate plan identity mismatch/)
  for (const mutate of [
    (a) => { a.document.kind = 'project-edit-plan' },
    (a) => { a.document.legacyCanonicalJson += '\n' },
    (a) => { a.document.legacyCanonicalJson = a.document.legacyCanonicalJson.replace(RENDERABLE_PLAN_COMPILER_VERSION, 'unapproved-compiler/v1') },
    (a) => { delete a.document.canonicalPolicyVersion },
    (a) => { a.document.canonicalPolicyVersion = 'output-canonical-json/v99' },
    (a) => { a.document.schemaVersion = 'output-plan-authority/v2'; a.schemaVersion = a.document.schemaVersion },
  ]) {
    const wrong = structuredClone(make())
    mutate(wrong.input.renderablePlan.authority)
    wrong.input.renderablePlan.authority.hash = calculateOutputCanonicalHash(wrong.input.renderablePlan.authority.document)
    assert.throws(() => createProjectOutputState(wrong.input, wrong.facts), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
  const editSister = { ...edit, projectVersionId: 'version-output-sister' }
  assert.throws(() => createState(stateInput([], editSister), editSister), /different ProjectVersion/)
  // A visible renderable snapshot cannot hide video behind an empty EditPlan.
  const emptyEdit = plan([])
  for (const actualEdit of [edit, emptyEdit]) for (const transition of ['create-variant', 'initialize-empty', 'fork-empty']) {
    const input = stateInput([], actualEdit, { transition,
      ...(transition === 'create-variant' ? { provenance: { kind: 'edit-command', id: 'command-output-child', hash } } : {}),
      renderablePlan: { snapshotId: 'renderable-snapshot-output',
      planId: compiled.id, hash: calculateRenderablePlanHash(compiled),
      authority: createOutputPlanAuthority({ ...policy, kind: 'renderable-edit-plan', planDocument: compiled }) } })
    assert.equal(input.editPlan.hash, calculateCanonicalHash(actualEdit))
    assert.equal(input.renderablePlan.authority.hash, calculateOutputCanonicalHash(input.renderablePlan.authority.document))
    assert.throws(() => createProjectOutputState(input, { editPlanDocument: actualEdit, renderablePlanDocument: compiled }),
      (error) => error.code === 'INVALID_OUTPUT_SPEC' && /explicit verified output entry/.test(error.message), transition)
  }
})

test('W66 video cannot bypass probes with zero entries and bootstrap plans must be truly empty', () => {
  const video = plan(), empty = plan([])
  for (const transition of ['create-variant', 'inherit', 'initialize-empty', 'fork-empty']) {
    const input = stateInput([], video, { transition,
      ...(['create-variant', 'inherit'].includes(transition)
        ? { provenance: { kind: 'edit-command', id: 'command-output-child', hash } } : {}) })
    assert.equal(input.editPlan.hash, calculateCanonicalHash(video))
    assert.equal(input.editPlan.authority.document.legacyHash, input.editPlan.hash)
    assert.equal(input.editPlan.authority.hash, calculateOutputCanonicalHash(input.editPlan.authority.document))
    assert.throws(() => createState(input, video), (error) =>
      error.code === 'INVALID_OUTPUT_SPEC' && /explicit verified output entry/.test(error.message), transition)
  }
  for (const transition of ['initialize-empty', 'fork-empty']) {
    const nonzero = { ...empty, durationFrames: 90 }
    assert.throws(() => createState(stateInput([], nonzero, { transition }), nonzero), (error) =>
      error.code === 'INVALID_OUTPUT_SPEC' && /explicitly empty/.test(error.message))
    createState(stateInput([], empty, { transition }), empty)
  }
  // Controlled contract only: the future ingest writer must receive a variant
  // created by an explicit Command before it materializes video into this plan.
  const spec = revision()
  const prepared = { ...policy, variantId: spec.variantId, outputSpecRevisionId: spec.id,
    specHash: calculateOutputCanonicalHash(spec), spec,
    geometry: { status: 'unmaterialized', projection: null, projectionHash: null } }
  createState(stateInput([prepared], empty), empty)
  createState(stateInput([entry(spec, video)], video), video)
})

test('W66 operational EditPlans require their exact Version even for an empty root after full resealing', () => {
  for (const clips of [[], [clip()]]) {
    const actualPlan = plan(clips)
    const members = clips.length ? [entry(revision(), actualPlan)] : []
    const positive = createState(stateInput(members, actualPlan), actualPlan)
    assert.equal(actualPlan.projectVersionId, positive.document.resultVersionId)
    assert.equal(JSON.parse(positive.document.editPlan.authority.document.legacyCanonicalJson).projectVersionId,
      positive.document.resultVersionId)
    for (const kind of ['missing', 'undefined', 'sister']) {
      const changed = structuredClone(actualPlan)
      if (kind === 'missing') delete changed.projectVersionId
      else changed.projectVersionId = kind === 'undefined' ? undefined : 'version-output-sister'
      // Persisted JSON cannot contain undefined. Its recomputed historical seal
      // and new authority match the omitted field; the raw undefined fact must
      // also fail, rather than obtaining an operational default from the State.
      const serializable = JSON.parse(JSON.stringify(changed))
      const input = stateInput(members, serializable)
      assert.equal(input.editPlan.hash, calculateCanonicalHash(changed))
      assert.equal(input.editPlan.authority.document.legacyHash, input.editPlan.hash)
      assert.equal(input.editPlan.authority.hash, calculateOutputCanonicalHash(input.editPlan.authority.document))
      assert.equal(createHash('sha256').update(input.editPlan.authority.document.legacyCanonicalJson, 'utf8').digest('hex'),
        input.editPlan.hash)
      assert.throws(() => createState(input, changed), (error) => error.code === 'INVALID_OUTPUT_SPEC',
        `${clips.length ? 'video' : 'empty root'}: ${kind}`)
    }
  }
})

test('W66 historical plan authority text, kind, policy and seal are mandatory even after full rehash', () => {
  const actualPlan = plan(), original = stateInput([entry(revision(), actualPlan)], actualPlan)
  for (const mutate of [
    (authority) => { authority.document.kind = 'renderable-edit-plan' },
    (authority) => { authority.document.legacyCanonicalJson += ' ' },
    (authority) => { authority.document.legacyHash = 'b'.repeat(64) },
    (authority) => { authority.document.schemaVersion = 'output-plan-authority/v2'; authority.schemaVersion = authority.document.schemaVersion },
    (authority) => { delete authority.document.canonicalPolicyVersion },
    (authority) => { authority.document.canonicalPolicyVersion = 'output-canonical-json/v99' },
  ]) {
    const changed = structuredClone(original)
    mutate(changed.editPlan.authority)
    changed.editPlan.authority.hash = calculateOutputCanonicalHash(changed.editPlan.authority.document)
    assert.throws(() => createState(changed, actualPlan), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
  const missing = structuredClone(original); delete missing.editPlan.authority
  assert.throws(() => createState(missing, actualPlan), /Missing plan authority seal/)
})

test('W66 effective encoding, audio and subtitle dependencies are sealed with no missing-field defaults', () => {
  const first = revision()
  const changed = structuredClone(first)
  changed.profile.final.audio.channels = 2
  const next = createOutputSpecRevisionBody(changed)
  assert.notEqual(calculateOutputCanonicalHash(first), calculateOutputCanonicalHash(next))
  const missing = structuredClone(first); delete missing.profile.final.audio.channels
  assert.throws(() => createOutputSpecRevisionBody(missing), /effective and explicit/)
  const wrongQuality = structuredClone(first); wrongQuality.profile.final.quality.value = 23
  assert.throws(() => createOutputSpecRevisionBody(wrongQuality), /versioned renderer/)
  const mutableSubtitle = structuredClone(first); mutableSubtitle.profile.subtitles.mode = 'burn-in'
  assert.throws(() => createOutputSpecRevisionBody(mutableSubtitle), /materialized configuration/)
  assert.ok(Object.isFrozen(next.profile.final.audio))
})

test('W66 every new State seal requires the pinned policy despite coherent replacement hashes', () => {
  const actualPlan = plan(), member = entry(revision(), actualPlan)
  const command = { kind: 'edit-command', id: 'command-policy-output', hash }
  const overlay = { ...policy, id: 'overlay-policy', variantId: member.variantId, kind: 'crop', clipId: 'clip-alpha',
    startFrame: 0, endFrame: 90, status: 'invalidated', provenance: command, dependencyHash: hash,
    document: seal({ ...policy, schemaVersion: 'project-output-crop/v1', authority: 'editorial-preference',
      crop: { x: .1, y: .1, width: .8, height: .8 } }) }
  const issue = { ...policy, id: 'issue-policy', variantId: member.variantId, overlayId: overlay.id, kind: 'crop',
    reasonCode: 'GEOMETRY_CHANGED', previousDependencyHash: hash, nextDependencyHash: 'b'.repeat(64),
    provenance: command, document: seal({ ...policy, schemaVersion: 'output-invalidation/v1', reasonCode: 'GEOMETRY_CHANGED' }) }
  const original = stateInput([member], actualPlan, { overlays: [overlay], invalidations: [issue] })
  createState(original, actualPlan)
  const targets = [
    ['State', (i) => i], ['producer', (i) => i.producer.document], ['entry', (i) => i.entries[0]],
    ['spec', (i) => i.entries[0].spec], ['projection', (i) => i.entries[0].geometry.projection],
    ['probe', (i) => i.entries[0].geometry.projection.clips[0].probe.document],
    ['normalization', (i) => i.entries[0].geometry.projection.clips[0].normalization.document],
    ['overlay', (i) => i.overlays[0]], ['crop document', (i) => i.overlays[0].document.document],
    ['invalidation', (i) => i.invalidations[0]], ['issue document', (i) => i.invalidations[0].document.document],
  ]
  for (const [label, target] of targets) for (const replacement of [null, 'output-canonical-json/v99']) {
    const changed = structuredClone(original), document = target(changed)
    if (replacement === null) delete document.canonicalPolicyVersion
    else document.canonicalPolicyVersion = replacement
    changed.producer.hash = calculateOutputCanonicalHash(changed.producer.document)
    changed.entries[0].specHash = calculateOutputCanonicalHash(changed.entries[0].spec)
    resealGeometry(changed.entries[0])
    changed.overlays[0].document = seal(changed.overlays[0].document.document)
    changed.invalidations[0].document = seal(changed.invalidations[0].document.document)
    assert.throws(() => createState(changed, actualPlan), (error) =>
      error.code === 'INVALID_OUTPUT_SPEC' && /canonical policy/.test(error.message), `${label}: ${replacement}`)
  }
  const oldSpecHash = structuredClone(original)
  const { canonicalPolicyVersion: _oldPolicy, ...prePolicySpec } = oldSpecHash.entries[0].spec
  oldSpecHash.entries[0].specHash = calculateCanonicalHash(prePolicySpec)
  assert.notEqual(oldSpecHash.entries[0].specHash, calculateOutputCanonicalHash(oldSpecHash.entries[0].spec))
  assert.throws(() => createState(oldSpecHash, actualPlan), /exact state entry/)
})

test('W66 preset and subtitle configuration seals cannot omit or switch canonical policy', () => {
  for (const kind of ['preset', 'configuration']) {
    const original = structuredClone(revision())
    const dependency = seal({ ...policy, schemaVersion: `${kind}-settings/v1`, effectiveValue: 'explicit' })
    if (kind === 'preset') original.preset = dependency
    else { original.profile.subtitles.mode = 'sidecar'; original.profile.subtitles.configuration = dependency }
    createOutputSpecRevisionBody(original)
    for (const replacement of [null, 'output-canonical-json/v99']) {
      const changed = structuredClone(original)
      const document = kind === 'preset' ? changed.preset.document : changed.profile.subtitles.configuration.document
      if (replacement === null) delete document.canonicalPolicyVersion
      else document.canonicalPolicyVersion = replacement
      const rehashed = seal(document)
      if (kind === 'preset') changed.preset = rehashed
      else changed.profile.subtitles.configuration = rehashed
      assert.throws(() => createOutputSpecRevisionBody(changed), (error) => error.code === 'INVALID_OUTPUT_SPEC')
    }
  }
})

test('W66 crop-only contract refuses subtitle and CTA overlays including disabled preserved issues', () => {
  const actualPlan = plan(), member = entry(revision(), actualPlan)
  const command = { kind: 'edit-command', id: 'command-unsupported-overlay', hash }
  for (const kind of ['subtitle', 'cta']) for (const status of ['active', 'invalidated']) {
    const overlay = { ...policy, id: 'overlay-unsupported', variantId: member.variantId, kind, clipId: 'clip-alpha',
      startFrame: 0, endFrame: 90, status, provenance: command, dependencyHash: member.geometry.projectionHash,
      document: seal({ ...policy, schemaVersion: `project-output-${kind}/v1`, text: 'Unbound cue',
        authority: 'editorial-preference', bounds: { x: .1, y: .1, width: .8, height: .8 } }) }
    const issue = { ...policy, id: 'issue-unsupported', variantId: member.variantId, overlayId: overlay.id, kind,
      reasonCode: 'DEPENDENCIES_CHANGED', previousDependencyHash: hash, nextDependencyHash: 'b'.repeat(64),
      provenance: command, document: seal({ ...policy, schemaVersion: 'output-invalidation/v1', reasonCode: 'DEPENDENCIES_CHANGED' }) }
    assert.throws(() => createState(stateInput([member], actualPlan,
      { overlays: [overlay], invalidations: status === 'invalidated' ? [issue] : [] }), actualPlan),
    (error) => error.code === 'INVALID_OUTPUT_SPEC' && /overlay kind/.test(error.message), `${kind}: ${status}`)
    assert.throws(() => createState(stateInput([member], actualPlan,
      { invalidations: [{ ...issue, overlayId: null }] }), actualPlan),
    (error) => error.code === 'INVALID_OUTPUT_SPEC' && /invalidation kind/.test(error.message))
  }
})

test('W66 verified geometry binds real render order, source frames, probes and orientation', () => {
  const actualPlan = plan([clip(), clip('clip-beta', 'source-master-beta', 90)])
  const original = entry(revision(), actualPlan)
  createState(stateInput([original], actualPlan), actualPlan)
  const reversed = structuredClone(original); reversed.geometry.projection.clips.reverse()
  reversed.geometry.projectionHash = calculateOutputCanonicalHash(reversed.geometry.projection)
  assert.throws(() => createState(stateInput([reversed], actualPlan), actualPlan), /render order/)
  const fps = structuredClone(original); fps.geometry.projection.clips[0].probe.document.fps = 24
  resealGeometry(fps)
  assert.throws(() => createState(stateInput([fps], actualPlan), actualPlan), /fps\/orientation conversion/)
  const missing = structuredClone(original); delete missing.geometry.projection.clips[0].probe.document.orientation
  resealGeometry(missing)
  assert.throws(() => createState(stateInput([missing], actualPlan), actualPlan), /Missing or unsupported geometry probe fields/)
  const unmaterialized = { ...original, geometry: { status: 'unmaterialized', projection: null, projectionHash: null } }
  assert.throws(() => createState(stateInput([unmaterialized], actualPlan), actualPlan), /cannot bypass probe/)
})

test('W66 probe and normalization semantics reject fully rehashed source contradictions, missing fields and unknown schemas', () => {
  const actualPlan = plan(), original = entry(revision(), actualPlan)
  for (const kind of ['probe', 'normalization']) for (const [field, replacement] of [
    ['sourceArtifactId', 'another-source-artifact'], ['sourceManifestId', 'another-source-manifest'],
    ['sourceManifestHash', 'b'.repeat(64)], ['sourceSha256', 'c'.repeat(64)],
  ]) {
    const contradictory = structuredClone(original)
    contradictory.geometry.projection.clips[0][kind].document[field] = replacement
    resealGeometry(contradictory)
    const geometryClip = contradictory.geometry.projection.clips[0]
    assert.equal(geometryClip[kind].hash, calculateOutputCanonicalHash(geometryClip[kind].document))
    assert.equal(contradictory.geometry.projectionHash, calculateOutputCanonicalHash(contradictory.geometry.projection))
    assert.throws(() => createState(stateInput([contradictory], actualPlan), actualPlan), (error) =>
      error.code === 'INVALID_OUTPUT_SPEC' && /source identity contradicts clip/.test(error.message), `${kind}.${field}`)
  }
  for (const [kind, field] of [['probe', 'sourceArtifactId'], ['probe', 'durationFrames'],
    ['normalization', 'sourceSha256'], ['normalization', 'probeHash'], ['normalization', 'mode']]) {
    const missing = structuredClone(original)
    delete missing.geometry.projection.clips[0][kind].document[field]
    resealGeometry(missing, false)
    assert.throws(() => createState(stateInput([missing], actualPlan), actualPlan), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
  for (const kind of ['probe', 'normalization']) {
    const foreign = structuredClone(original)
    foreign.geometry.projection.clips[0][kind].document.schemaVersion = 'unrelated-facts/v1'
    resealGeometry(foreign)
    assert.throws(() => createState(stateInput([foreign], actualPlan), actualPlan), /Unsupported geometry probe\/normalization schema/)
    const absent = structuredClone(original)
    delete absent.geometry.projection.clips[0][kind]
    resealGeometry(absent)
    assert.throws(() => createState(stateInput([absent], actualPlan), actualPlan), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
  for (const [mutate, bindProbe] of [
    [(c) => { c.normalization.document.mode = 'implicit-conversion' }, true],
    [(c) => { c.normalization.document.probeHash = 'd'.repeat(64) }, false],
    [(c) => { c.probe.document.durationFrames = 89 }, true],
    [(c) => { c.probe.document.timebase.numerator = 0 }, true],
    [(c) => { c.probe.document.orientation.rotationDegrees = 90 }, true],
  ]) {
    const changed = structuredClone(original)
    mutate(changed.geometry.projection.clips[0]); resealGeometry(changed, bindProbe)
    assert.throws(() => createState(stateInput([changed], actualPlan), actualPlan), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
})

test('W66 state member arrays have locale-independent canonical order without sorting render clips', () => {
  const actualPlan = plan([clip('clip-z'), clip('clip-A', 'source-master-beta', 90)])
  const entries = ['variant-a', 'variant-Z', 'variant-A'].map((id) => entry(revision(id, `revision-${id}`), actualPlan))
  const command = { kind: 'edit-command', id: 'command-order-output', hash }
  const overlays = ['overlay-a', 'overlay-Z', 'overlay-A'].map((id) => ({ ...policy, id, variantId: 'variant-A',
    kind: 'crop', clipId: 'clip-z', startFrame: 0, endFrame: 90, status: 'invalidated', provenance: command,
    dependencyHash: hash, document: seal({ ...policy, schemaVersion: 'project-output-crop/v1', authority: 'editorial-preference',
      crop: { x: .1, y: .1, width: .8, height: .8 } }) }))
  const invalidations = overlays.map((overlay) => ({ ...policy, id: overlay.id.replace('overlay', 'issue'),
    variantId: overlay.variantId, overlayId: overlay.id, kind: 'crop', reasonCode: 'GEOMETRY_CHANGED',
    previousDependencyHash: hash, nextDependencyHash: 'b'.repeat(64), provenance: command,
    document: seal({ ...policy, schemaVersion: 'output-invalidation/v1', reasonCode: 'GEOMETRY_CHANGED' }) }))
  const first = createState(stateInput(entries, actualPlan, { overlays, invalidations }), actualPlan)
  const shuffled = createState(stateInput([...entries].reverse(), actualPlan,
    { overlays: [...overlays].reverse(), invalidations: [...invalidations].reverse() }), actualPlan)
  assert.deepEqual(first.document.entries.map((e) => e.variantId), ['variant-A', 'variant-Z', 'variant-a'])
  assert.deepEqual(first.document.overlays.map((e) => e.id), ['overlay-A', 'overlay-Z', 'overlay-a'])
  assert.deepEqual(first.document.invalidations.map((e) => e.id), ['issue-A', 'issue-Z', 'issue-a'])
  assert.deepEqual(first.document.entries[0].geometry.projection.clips.map((c) => c.id), ['clip-z', 'clip-A'])
  assert.equal(first.stateHash, shuffled.stateHash)
})

test('W66 crop membership, range and original Command cannot be substituted by a sister or overlap', () => {
  const actualPlan = plan()
  const a = entry(revision(), actualPlan), b = entry(revision('variant-beta', 'revision-beta-1'), actualPlan)
  const overlay = { ...policy, id: 'overlay-alpha', variantId: a.variantId, kind: 'crop', clipId: 'clip-alpha',
    startFrame: 0, endFrame: 90, status: 'active', provenance: { kind: 'edit-command', id: 'command-manual-crop', hash },
    dependencyHash: a.geometry.projectionHash,
    document: seal({ ...policy, schemaVersion: 'project-output-crop/v1', authority: 'editorial-preference',
      crop: { x: .1, y: .1, width: .8, height: .8 } }) }
  const state = createState(stateInput([a, b], actualPlan, { overlays: [overlay] }), actualPlan)
  assert.equal(state.document.overlays.length, 1)
  assert.equal(state.document.entries[1].geometry.projectionHash, b.geometry.projectionHash)
  assert.throws(() => createState(stateInput([a, b], actualPlan, { overlays: [{ ...overlay, variantId: b.variantId }] }), actualPlan), /stale geometry/)
  assert.throws(() => createState(stateInput([a, b], actualPlan, { overlays: [overlay, { ...overlay, id: 'overlap-alpha', startFrame: 45 }] }), actualPlan), /Overlapping/)
  assert.throws(() => createState(stateInput([a], actualPlan, { overlays: [{ ...overlay, endFrame: 91 }] }), actualPlan), /outside its clip/)
  assert.throws(() => createState(stateInput([a], actualPlan, { overlays: [{ ...overlay, status: 'invalidated' }] }), actualPlan), /preserved issue/)
})

test('W66 empty bootstrap and exact Version hash have no State/Version cycle or missing-state fallback', () => {
  const actualPlan = plan([]), state = createState(stateInput([], actualPlan), actualPlan)
  const version = versionOf(state)
  assert.equal(version.outputContractVersion, 1)
  assert.equal(version.outputStateId, state.document.id)
  assert.equal(version.outputStateHash, state.stateHash)
  assert.equal('baseHash' in state.document, false)
  assert.throws(() => versionOf(state, { id: 'another-version' }), /exact ProjectVersion/)
  assert.throws(() => versionOf(state, { baseHash: hash }), /not bound/)
  assert.throws(() => versionOf(state, { outputState: undefined }), /requires its sealed/)
  assert.throws(() => createState(stateInput([entry(revision())], plan(), { transition: 'initialize-empty' }), plan()), /explicitly empty/)
  const fork = createState(stateInput([], actualPlan, { transition: 'fork-empty' }), actualPlan)
  assert.equal(versionOf(fork, { forkedFromProjectId: 'source-project', forkedFromVersionId: 'source-version' }).outputContractVersion, 1)
  const identity = { workspaceId: state.document.workspaceId, projectId: state.document.projectId,
    resultVersionId: state.document.resultVersionId, parentVersionId: null, previousBaseHash: null,
    producerHash: state.document.producer.hash, outputStateId: state.document.id, outputStateHash: state.stateHash }
  assert.equal(version.baseHash, calculateOutputCanonicalHash({ schemaVersion: 'project-version-output-state/v1', ...policy, ...identity }))
  for (const replacement of [undefined, 'output-canonical-json/v99']) {
    assert.throws(() => versionOf(state, { canonicalPolicyVersion: replacement }),
      (error) => error.code === 'INVALID_OUTPUT_SPEC' && /canonical policy/.test(error.message))
    const changed = structuredClone(state)
    if (replacement === undefined) delete changed.document.canonicalPolicyVersion
    else changed.document.canonicalPolicyVersion = replacement
    changed.stateHash = calculateOutputCanonicalHash(changed.document)
    assert.throws(() => versionOf(changed), (error) => error.code === 'INVALID_PROJECT_VERSION' && /sealed output state/.test(error.message))
  }
  assert.throws(() => versionOf(state, { baseHash: calculateCanonicalHash({ schemaVersion: 'project-version-output-state/v1', ...identity }) }),
    /not bound/)
})

test('W66 CreationCommand cannot acquire variant effects even with completely recomputed seals', () => {
  const actualPlan = plan([]), root = createState(stateInput([], actualPlan), actualPlan)
  const input = stateInput([], actualPlan, { transition: 'create-variant' })
  input.producer.document = { ...input.producer.document, allegedVariantEffect: 'variant-alpha' }
  input.producer.hash = calculateOutputCanonicalHash(input.producer.document)
  assert.throws(() => createState(input, actualPlan), (error) =>
    error.code === 'INVALID_OUTPUT_SPEC' && /CreationCommand/.test(error.message))
  const forged = structuredClone(root)
  forged.document.transition = 'create-variant'
  forged.document.producer = input.producer
  forged.stateHash = calculateOutputCanonicalHash(forged.document)
  assert.throws(() => versionOf(forged), (error) =>
    error.code === 'INVALID_PROJECT_VERSION' && /provenance mismatch/.test(error.message))
})

test('W66 historical contract zero remains audit-only and cannot hydrate an operational Version', () => {
  const audit = createHistoricalProjectVersionAudit({ outputContractVersion: 0, outputStateId: null, outputStateHash: null,
    id: 'historical-version', workspaceId: 'workspace-output', projectId: 'project-output', baseHash: hash,
    document: { schemaVersion: 1, historical: true } })
  assert.equal(audit.kind, 'historical-project-version-audit')
  assert.equal(audit.outputContractVersion, 0)
  assert.throws(() => rebuildRetiredContractOneVersion({ ...audit, ...policy, sequence: 1, snapshotRefs: { editPlan: 'snapshot-edit-plan', policies: 'snapshot-policies' },
    previousBaseHash: null, createdBy: 'actor-output', createdAt }), /requires its sealed/)
})

test('W66 output Command fingerprint ignores allocated IDs/time and binds actor, sister and effective profile', () => {
  const actualPlan = plan([]), baseState = createState(stateInput([], actualPlan), actualPlan), base = versionOf(baseState)
  const audit = createApiAccessAuditContext({ clientId: 'actor-output', credentialId: 'credential-output',
    workspaceId: 'workspace-output', environment: 'sandbox', authenticationKind: 'bearer' })
  const make = (document, commandId, overrides = {}) => createOutputVariantCommand({ command: { id: commandId,
    workspaceId: base.workspaceId, projectId: base.projectId, baseVersionId: base.id, baseHash: base.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type: 'create-output-variant', idempotencyKey: 'create-output-request',
    createdAt: document.createdAt }, audit, base, baseState, historicalBaselineRequested: false,
    revision: document, expectedRevisionId: null, expectedSpecHash: null, durationFrames: 0, ...overrides })
  const first = make(revision(), 'command-output-first')
  const { commandHash, ...commandBody } = first.command
  assert.equal(commandHash, calculateCanonicalHash(commandBody), 'Command v1 must keep its historical hash authority')
  assert.equal(first.command.payload.canonicalPolicyVersion, OUTPUT_CANONICAL_POLICY_VERSION)
  assert.equal(first.command.payload.impact.canonicalPolicyVersion, OUTPUT_CANONICAL_POLICY_VERSION)
  assert.deepEqual(first.producer.document, { schemaVersion: 'output-variant-version-producer/v1', ...policy,
    commandId: first.command.id, commandHash, requestFingerprint: first.requestFingerprint,
    workspaceId: base.workspaceId, projectId: base.projectId, baseVersionId: base.id, baseHash: base.baseHash,
    payloadHash: calculateOutputCanonicalHash(first.command.payload) })
  assert.equal(first.producer.hash, calculateOutputCanonicalHash(first.producer.document))
  const { id: _allocatedId, ...outputIntent } = first.command.payload.revision.output
  const request = { schemaVersion: 'output-variant-request/v1', ...policy, workspaceId: base.workspaceId,
    projectId: base.projectId, baseVersionId: base.id, baseHash: base.baseHash, actorContextHash: audit.contextHash,
    type: 'create-output-variant', variantId: null, expectedRevisionId: null, expectedSpecHash: null,
    historicalBaselineRequested: false, output: outputIntent, profile: first.command.payload.revision.profile,
    preset: null, reason: null }
  assert.equal(first.requestFingerprint, calculateOutputCanonicalHash(request))
  const { canonicalPolicyVersion: _requestPolicy, ...oldRequest } = request
  assert.notEqual(first.requestFingerprint, calculateCanonicalHash(oldRequest))
  for (const replacement of [undefined, 'output-canonical-json/v99']) {
    const changedRevision = structuredClone(revision())
    if (replacement === undefined) delete changedRevision.canonicalPolicyVersion
    else changedRevision.canonicalPolicyVersion = replacement
    assert.throws(() => make(changedRevision, 'command-output-policy'), (error) => error.code === 'INVALID_OUTPUT_SPEC')
    const changedBase = structuredClone(base)
    if (replacement === undefined) delete changedBase.canonicalPolicyVersion
    else changedBase.canonicalPolicyVersion = replacement
    assert.throws(() => make(revision(), 'command-output-policy', { base: changedBase }), (error) => error.code === 'INVALID_OUTPUT_SPEC')
    const changedState = structuredClone(baseState)
    if (replacement === undefined) delete changedState.document.canonicalPolicyVersion
    else changedState.document.canonicalPolicyVersion = replacement
    changedState.stateHash = calculateOutputCanonicalHash(changedState.document)
    assert.throws(() => make(revision(), 'command-output-policy', { baseState: changedState }), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  }
  const later = make(revision('variant-another', 'revision-another', { createdAt: '2026-10-11T12:01:00.000Z' }), 'command-output-later')
  assert.equal(first.requestFingerprint, later.requestFingerprint)
  assert.notEqual(first.command.commandHash, later.command.commandHash)
  const changed = structuredClone(revision()); changed.profile.final.audio.channels = 2
  assert.notEqual(make(changed, 'command-output-changed').requestFingerprint, first.requestFingerprint)
  const credential = createApiAccessAuditContext({ ...audit, credentialId: 'credential-output-other' })
  assert.notEqual(make(revision(), 'command-output-other', { audit: credential }).requestFingerprint, first.requestFingerprint)
  const historical = createHistoricalProjectVersionAudit({ outputContractVersion: 0, outputStateId: null, outputStateHash: null,
    id: base.id, workspaceId: base.workspaceId, projectId: base.projectId, baseHash: base.baseHash, document: {} })
  assert.throws(() => make(revision(), 'command-output-historical', { base: historical, baseState: null }), /explicitly requested/)
})

test('W66 ingest producer binds the existing worker deterministic child, master/manifest and transcript', () => {
  const input = { operationId: 'ingest-operation-real', workspaceId: 'workspace-output', projectId: 'project-output',
    requestFingerprint: hash, sourceArtifactId: 'source-master-alpha', sourceManifestId: 'source-manifest-alpha',
    sourceManifestHash: hash, transcriptId: 'transcript-alpha', transcriptHash: 'b'.repeat(64), editPlanHash: hash }
  const producer = createIngestOutputVersionProducer(input)
  const digest = createHash('sha256').update(`${input.operationId}:${input.sourceArtifactId}:${input.sourceManifestId}:${input.transcriptHash}`).digest('hex').slice(0, 48)
  assert.equal(producer.resultVersionId, `project-version-ingest-${digest}`)
  assert.equal(producer.provenance.kind, 'media-ingest-operation')
  assert.equal(producer.provenance.hash, input.requestFingerprint)
  assert.equal(producer.producer.hash, calculateOutputCanonicalHash(producer.producer.document))
  assert.notEqual(createIngestOutputVersionProducer({ ...input, transcriptHash: 'c'.repeat(64) }).resultVersionId, producer.resultVersionId)
  assert.notEqual(createIngestOutputVersionProducer({ ...input, sourceManifestId: 'other-source-manifest' }).resultVersionId, producer.resultVersionId)
})
