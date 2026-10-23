import assert from 'node:assert/strict'
import test from 'node:test'

import { projectProxyRenderContentHash, projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'

/**
 * W70 prep. The content address a render is carried by. It must be the SAME for two Versions in which an output is drawn from the same
 * inputs - whatever merely names the Version differs - and it must move with every input the pixels depend on.
 */
const h = (character) => character.repeat(64)
const seal = (versionId = 'version-1') => ({
  schemaVersion: 'output-consumption-seal/v1', purpose: 'render', projectVersionId: versionId, projectVersionHash: h(versionId.endsWith('1') ? 'a' : 'b'),
  outputStateId: `state-${versionId}`, outputStateHash: h(versionId.endsWith('1') ? 'c' : 'd'), variantId: 'variant-wide', outputSpecRevisionId: 'revision-1',
  specHash: h('e'), materializationId: `materialization-${versionId}`, materializationHash: h(versionId.endsWith('1') ? 'f' : '0'),
})
const plan = (versionId = 'version-1') => ({
  id: `edit-plan-${versionId}`, projectVersionId: versionId, createdAt: versionId === 'version-1' ? '2026-10-20T10:00:00.000Z' : '2026-10-20T11:00:00.000Z',
  fps: 30, durationFrames: 150, videoTracks: [{ kind: 'base-video', clips: [{ id: 'clip-1', sourceArtifactId: 'artifact-source', timelineInFrame: 0, timelineOutFrame: 150 }] }],
  subtitleTracks: [{ id: 'track-1', kind: 'captions', presetId: 'kinetic', cues: [{ id: 'cue-1', startFrame: 10, endFrame: 40, text: 'Primeira' }] }],
})
const source = (versionId = 'version-1', patch = {}) => ({
  projectId: 'project-1', projectVersionId: versionId, editPlanSnapshotId: `snapshot-${versionId}`, editPlanHash: h(versionId.endsWith('1') ? '1' : '2'),
  editPlan: plan(versionId), format: '16:9', outputConsumption: { seal: seal(versionId), sealHash: h(versionId.endsWith('1') ? '3' : '4') },
  sourceArtifactId: 'artifact-source', sourceManifestId: 'manifest-source', sourceArtifactKey: 'k/source.mp4', sourceSha256: h('5'),
  renderSources: [{ artifactId: 'artifact-source', manifestId: 'manifest-source', artifactKey: 'k/source.mp4', sha256: h('5'), byteSize: 1000, mediaType: 'video', container: 'mp4', role: 'source-master' }],
  originalFileName: 'x.mp4', uploadReceivedAt: '2026-10-20T10:00:00.000Z', criticIssues: [],
  subtitleResolution: { presetId: 'kinetic', presetHash: h('6'), registryHash: h('7'), enabled: true, presetSnapshot: { snapshotHash: h('8') } },
  ...patch,
})
const bindings = [{ compilationId: 'compilation-1', sourceArtifactId: 'artifact-source', sourceManifestId: 'manifest-source', compilationHash: h('9'), pipelineHash: h('a') }]
const address = (versionId, patch, colour = bindings) => projectProxyRenderContentHash({ source: source(versionId, patch), colorPipelineBindings: colour })
const lutNone = Object.freeze({ id: 'lut-selection-1', selectionHash: h('6'), mode: 'none', lutVersionId: null, lutRecordHash: null, cubeContentHash: null, intensity: 1 })
const grade = (patch = {}) => ({ schemaVersion: 'render-color-grade/v1', colorPlan: null, lutSelection: lutNone, ...patch })

test('two Versions that differ only by the identity of the Version have the same content address (and not the same input hash)', () => {
  const first = address('version-1')
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(address('version-2'), first)
  assert.notEqual(projectProxyRenderInputHash({ source: source('version-1'), colorPipelineBindings: bindings }), projectProxyRenderInputHash({ source: source('version-2'), colorPipelineBindings: bindings }),
    'the pre-render input hash names the Version, which is why it cannot carry a render across Versions')
})

test('every input the pixels depend on moves the content address', () => {
  const base = address('version-2')
  const moved = {
    'plan content': { editPlan: { ...plan('version-2'), durationFrames: 151 } },
    'a cue text': { editPlan: { ...plan('version-2'), subtitleTracks: [{ ...plan().subtitleTracks[0], cues: [{ id: 'cue-1', startFrame: 10, endFrame: 40, text: 'Outra' }] }] } },
    'the source master': { sourceSha256: h('b'), renderSources: [{ ...source().renderSources[0], sha256: h('b') }] },
    'a render source': { renderSources: [...source().renderSources, { artifactId: 'artifact-logo', manifestId: 'manifest-logo', artifactKey: 'k/logo.png', sha256: h('c'), byteSize: 10, mediaType: 'video', container: 'png', role: 'selected-insert' }] },
    'the format': { format: '9:16' },
    'the output variant': { outputConsumption: { seal: { ...seal('version-2'), variantId: 'variant-other' }, sealHash: h('4') } },
    'the output spec revision': { outputConsumption: { seal: { ...seal('version-2'), outputSpecRevisionId: 'revision-2' }, sealHash: h('4') } },
    'the output spec': { outputConsumption: { seal: { ...seal('version-2'), specHash: h('d') }, sealHash: h('4') } },
    'the reframe record': { reframeRecordHash: h('e') },
    'the subtitle exceptions': { subtitleOverridesHash: h('f') },
    'the subtitle preset': { subtitleResolution: { ...source().subtitleResolution, presetHash: h('0') } },
    'the subtitle registry': { subtitleResolution: { ...source().subtitleResolution, registryHash: h('1') } },
    'the subtitle preset snapshot': { subtitleResolution: { ...source().subtitleResolution, presetSnapshot: { snapshotHash: h('2') } } },
    'subtitles switched off': { subtitleResolution: { ...source().subtitleResolution, enabled: false } },
    'the OCR evidence': { trustedOcr: { envelopeId: 'e', envelopeHash: h('3'), inputVersionId: 'v', timeMapHash: h('4'), timeline: {} } },
    'the subject evidence': { formatSubjects: [{ id: 's' }] },
    'a placement asset': { placementAssets: [{ elementId: 'logo', artifactId: 'a', artifactKey: 'k', sha256: h('5'), byteSize: 1 }] },
    'the project': { projectId: 'project-2' },
    // W70 readiness (R2): a ColorPlan or a LUT selection copies the parent's EditPlan, so only the grade can tell the two renders apart
    'a ColorPlan': { colorGrade: grade({ colorPlan: { id: 'color-plan-1', recordHash: h('1'), planHash: h('2'), compiledManifestHash: h('3') } }) },
    'another LUT': { colorGrade: grade({ lutSelection: { ...lutNone, mode: 'lut-version', lutVersionId: 'lut-1', lutRecordHash: h('4'), cubeContentHash: h('5') } }) },
    'the LUT intensity': { colorGrade: grade({ lutSelection: { ...lutNone, intensity: 0.5 } }) },
  }
  for (const [label, patch] of Object.entries(moved)) assert.notEqual(address('version-2', patch), base, `${label} moves the address`)
  assert.notEqual(address('version-2', {}, [...bindings, { ...bindings[0], compilationId: 'compilation-2' }]), base, 'the colour bindings move it')
  assert.notEqual(address('version-2', {}, [{ ...bindings[0], pipelineHash: h('6') }]), base, 'and so does their pipeline')
  const seen = new Set(Object.entries(moved).map(([, patch]) => address('version-2', patch)))
  assert.equal(seen.size, Object.keys(moved).length, 'and no two of them collide')
})

test('what only names the Version never moves it', () => {
  const base = address('version-1')
  const namedOnly = {
    'the Version id': { projectVersionId: 'version-9' },
    'the snapshot id': { editPlanSnapshotId: 'snapshot-9' },
    'the snapshot hash': { editPlanHash: h('9') },
    'the plan identity': { editPlan: { ...plan('version-1'), id: 'edit-plan-other', projectVersionId: 'version-9', createdAt: '2030-01-01T00:00:00.000Z' } },
    'the State and the materialization': { outputConsumption: { seal: { ...seal('version-1'), outputStateId: 'state-9', outputStateHash: h('1'), materializationId: 'm-9', materializationHash: h('2'), projectVersionId: 'version-9', projectVersionHash: h('3') }, sealHash: h('5') } },
    'the file name': { originalFileName: 'other.mp4' },
  }
  for (const [label, patch] of Object.entries(namedOnly)) assert.equal(address('version-1', patch), base, `${label} does not move the address`)
})

test('W70 the colour grade is in the address by what it does, and in the input hash by the rows that hold it', () => {
  const graded = address('version-2', { colorGrade: grade() })
  assert.notEqual(graded, address('version-2'), 'a source read with its grade is not one read without')
  // the same grade held by other rows (re-set to the same values under another Version) is the same content ...
  assert.equal(address('version-2', { colorGrade: grade({ lutSelection: { ...lutNone, id: 'lut-selection-2', selectionHash: h('7') } }) }), graded)
  assert.equal(address('version-2', { colorGrade: grade({ colorPlan: { id: 'plan-a', recordHash: h('1'), planHash: h('2'), compiledManifestHash: h('3') } }) }),
    address('version-2', { colorGrade: grade({ colorPlan: { id: 'plan-b', recordHash: h('8'), planHash: h('2'), compiledManifestHash: h('3') } }) }))
  // ... but not the same input: the input hash names the rows
  const input = (patch) => projectProxyRenderInputHash({ source: source('version-2', patch), colorPipelineBindings: bindings })
  assert.notEqual(input({ colorGrade: grade() }), input({}))
  assert.notEqual(input({ colorGrade: grade({ lutSelection: { ...lutNone, id: 'lut-selection-2', selectionHash: h('7') } }) }), input({ colorGrade: grade() }))
})

test('W70 the review policies are pinned in the address, derived from the live objects and constants', async () => {
  const sources = await import('../../src/v2/application/project-render-sources.ts')
  const { PROXY_REVIEW_POLICY_IDENTITY, PROXY_REVIEW_POLICY_SHA256, PROXY_REVIEW_POLICY_PARTS, calculateProxyReviewPolicySha256 } = sources
  const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
  const { PROXY_REVIEW_POLICY, PROXY_REVIEW_SCHEMA_VERSION } = await import('../../src/v2/application/render-workflow.ts')
  const { FORMAT_QUALITY_POLICY, FORMAT_QUALITY_REPORT_SCHEMA_VERSION } = await import('../../src/v2/domain/format-quality-critic.ts')
  assert.equal(PROXY_REVIEW_POLICY_SHA256, calculateCanonicalHash(PROXY_REVIEW_POLICY_IDENTITY))
  assert.equal(PROXY_REVIEW_POLICY_SHA256, calculateProxyReviewPolicySha256())
  assert.deepEqual(Object.keys(PROXY_REVIEW_POLICY_IDENTITY).sort(), ['anchorPolicies', 'captionPixel', 'captionTextLayout', 'colorCritic', 'faceEvidencePolicySha256',
    'formatQuality', 'mp4PixelCriticPolicySha256', 'outputFormatRegistryHash', 'proxyReview'])
  assert.equal(PROXY_REVIEW_POLICY_IDENTITY.captionPixel.bandTolerancePx, 6)
  // the schema versions are the real constants, not copies
  assert.equal(PROXY_REVIEW_POLICY_IDENTITY.proxyReview.schemaVersion, PROXY_REVIEW_SCHEMA_VERSION)
  assert.equal(PROXY_REVIEW_POLICY_IDENTITY.formatQuality.schemaVersion, FORMAT_QUALITY_REPORT_SCHEMA_VERSION)
  assert.equal(PROXY_REVIEW_POLICY_IDENTITY.proxyReview.policy, calculateCanonicalHash(PROXY_REVIEW_POLICY))
  assert.equal(PROXY_REVIEW_POLICY_IDENTITY.formatQuality.policy, calculateCanonicalHash(FORMAT_QUALITY_POLICY))

  // a changed threshold (no schema bump) is another policy digest and another content address
  const base = address('version-2')
  const changed = {
    'the proxy duration tolerance (ms)': { proxyReviewPolicy: { ...PROXY_REVIEW_POLICY, durationToleranceMinMs: PROXY_REVIEW_POLICY.durationToleranceMinMs + 1 } },
    'the proxy duration tolerance (frames)': { proxyReviewPolicy: { ...PROXY_REVIEW_POLICY, durationToleranceFrames: PROXY_REVIEW_POLICY.durationToleranceFrames + 1 } },
    'the format critic density limit': { formatQualityPolicy: { ...FORMAT_QUALITY_POLICY, defaultDensityLimit: 0.5 } },
    'the format critic density range': { formatQualityPolicy: { ...FORMAT_QUALITY_POLICY, densityLimitRange: { min: 0.3, max: 1 } } },
    'the caption band tolerance': { captionBandTolerancePx: PROXY_REVIEW_POLICY_PARTS.captionBandTolerancePx + 1 },
    'the colour critic policy': { colorCriticPolicy: { ...PROXY_REVIEW_POLICY_PARTS.colorCriticPolicy, unrelatedProbeThreshold: 1 } },
    'the final caption anchor policy': { finalCaptionAnchorPolicy: { onNoSafeRegion: 'other' } },
    'the output registry': { outputFormatRegistryHash: h('9') },
    'the review schema version': { proxyReviewSchemaVersion: 'proxy-review/v2' },
  }
  const seen = new Set([PROXY_REVIEW_POLICY_SHA256])
  for (const [name, patch] of Object.entries(changed)) {
    const digest = calculateProxyReviewPolicySha256({ ...PROXY_REVIEW_POLICY_PARTS, ...patch })
    assert.notEqual(digest, PROXY_REVIEW_POLICY_SHA256, `${name} moves the policy digest`)
    assert.equal(seen.has(digest), false, `${name} is its own digest`)
    seen.add(digest)
    assert.notEqual(projectProxyRenderContentHash({ source: source('version-2'), colorPipelineBindings: bindings, reviewPolicySha256: digest }), base, `${name} moves the content address`)
  }
})

test('a source that was not read through the sealed consumption verdict has no address', () => {
  assert.throws(() => projectProxyRenderContentHash({ source: { ...source(), outputConsumption: undefined }, colorPipelineBindings: bindings }), /not sealed/)
})
