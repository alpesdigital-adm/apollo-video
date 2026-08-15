import assert from 'node:assert/strict'
import test from 'node:test'

import { compileApolloVideoRenderProps } from '../../src/v2/application/compile-apollo-video-render-props.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { critiqueOutputFormat, selectExportableVariants } from '../../src/v2/domain/format-quality-critic.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/output-spec.ts'
import { createProjectSubtitleConfiguration } from '../../src/v2/domain/project-subtitle-configuration.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import {
  materializeRenderInputSubtitles,
  requireRenderInputSubtitleRegistry,
} from '../../src/v2/domain/render-input-subtitles.ts'
import {
  createRenderPlacementPlan,
  drawablePlacementsAtFrame,
  validateRenderPlacementPlan,
} from '../../src/v2/domain/render-placement-plan.ts'
import {
  createRenderReframePlan,
  interpolateReframeCrop,
  reframeRangeAtFrame,
  validateRenderReframePlan,
} from '../../src/v2/domain/render-reframe-plan.ts'
import { solveResponsivePlacement } from '../../src/v2/domain/responsive-output.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import {
  SUBTITLE_PRESET_IDS,
  SUBTITLE_STYLE_REGISTRY,
  subtitlePresetHash,
  subtitlePresetReference,
} from '../../src/v2/domain/subtitle-system.ts'

const sha = (character) => character.repeat(64)
const TRANSCRIPT_HASH = sha('a')
const LOGO_SHA = sha('b')

const codeOf = (error) => error?.code

// ---------------------------------------------------------------------------
// T-FR-170 — the subtitle band is derived from the resolved preset, never shared
// ---------------------------------------------------------------------------

test('T-FR-170 subtitle regions are derived per format and per preset from the registry', () => {
  const regions = OUTPUT_ASPECT_RATIOS.map((ratio) =>
    deriveSubtitleRegion({ spec: readOutputFormatPreset(ratio).spec, presetId: 'kinetic' }))
  assert.equal(regions.length, 5)
  // Five formats produce five distinct bands: no shared hardcoded rectangle survives here.
  assert.equal(new Set(regions.map((region) => calculateCanonicalHash(region.bounds))).size, 5)
  for (const [index, ratio] of OUTPUT_ASPECT_RATIOS.entries()) {
    const spec = readOutputFormatPreset(ratio).spec
    const region = regions[index]
    assert.equal(region.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
    assert.equal(region.presetHash, subtitlePresetHash('kinetic'))
    assert.equal(region.outputSpecId, spec.id)
    assert.ok(region.bounds.x >= spec.safeArea.left - 1e-9, `${ratio} left safe area`)
    assert.ok(region.bounds.y >= spec.safeArea.top - 1e-9, `${ratio} top safe area`)
    assert.ok(region.bounds.x + region.bounds.width <= 1 - spec.safeArea.right + 1e-9, `${ratio} right safe area`)
    assert.ok(region.bounds.y + region.bounds.height <= 1 - spec.safeArea.bottom + 1e-9, `${ratio} bottom safe area`)
  }
  // Five presets on the same canvas also disagree, because their responsive limits differ.
  const perPreset = SUBTITLE_PRESET_IDS.map((presetId) =>
    deriveSubtitleRegion({ spec: readOutputFormatPreset('9:16').spec, presetId }))
  assert.equal(new Set(perPreset.map((region) => calculateCanonicalHash(region.bounds))).size, 5)
  assert.throws(
    () => deriveSubtitleRegion({ spec: readOutputFormatPreset('9:16').spec, presetId: 'kinetic', registryHash: sha('f') }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
  assert.throws(
    () => deriveSubtitleRegion({ spec: readOutputFormatPreset('9:16').spec, presetId: 'kinetic', presetHash: sha('f') }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
})

test('T-FR-163 the responsive solve places subtitles on the derived region, not on a format constant', () => {
  const spec = readOutputFormatPreset('9:16').spec
  const region = deriveSubtitleRegion({ spec, presetId: 'caps-stroke' })
  const element = { id: 'subtitle-1', kind: 'subtitle', anchor: 'auto', priority: 10, readingOrder: 0, minWidth: 0.05, maxWidth: 0.95, minHeight: 0.02, maxHeight: 0.6 }
  const withRegion = solveResponsivePlacement({ spec, elements: [element], protectedRegions: [], subtitleRegion: region })
  const withoutRegion = solveResponsivePlacement({ spec, elements: [element], protectedRegions: [] })
  assert.equal(withRegion.schemaVersion, 'responsive-placement/v2')
  assert.equal(withRegion.subtitleRegion.presetId, 'caps-stroke')
  assert.deepEqual(
    { x: withRegion.elements[0].x, y: withRegion.elements[0].y, width: withRegion.elements[0].width, height: withRegion.elements[0].height },
    region.bounds,
  )
  assert.equal(withoutRegion.subtitleRegion, null)
  assert.notEqual(withRegion.placementHash, withoutRegion.placementHash)
  // A region derived for another canvas cannot be laundered into this solve.
  assert.throws(
    () => solveResponsivePlacement({ spec, elements: [element], subtitleRegion: deriveSubtitleRegion({ spec: readOutputFormatPreset('16:9').spec, presetId: 'caps-stroke' }) }),
    (error) => codeOf(error) === 'INVALID_ARGUMENT',
  )
})

// ---------------------------------------------------------------------------
// T-FR-163 — placement plan
// ---------------------------------------------------------------------------

const placementPlanFixture = () => createRenderPlacementPlan({
  format: '9:16',
  canvas: { width: 540, height: 960 },
  durationFrames: 90,
  subtitlePresetId: 'kinetic',
  elements: [
    { id: 'logo-1', kind: 'logo', anchor: 'auto', priority: 90, readingOrder: 0, minWidth: 0.1, maxWidth: 0.3, minHeight: 0.04, maxHeight: 0.2, timeRange: { startFrame: 0, endFrame: 90 }, assetArtifactId: 'artifact-logo-1', assetSha256: LOGO_SHA },
    { id: 'cta-1', kind: 'cta', anchor: 'auto', priority: 50, readingOrder: 1, minWidth: 0.2, maxWidth: 0.8, minHeight: 0.05, maxHeight: 0.3, timeRange: { startFrame: 30, endFrame: 60 } },
  ],
})

test('T-FR-163 the placement plan is content-addressed, half-open and fail-closed', () => {
  const plan = placementPlanFixture()
  assert.equal(plan.placementPlanHash, placementPlanFixture().placementPlanHash)
  assert.equal(plan.outputPresetHash, readOutputFormatPreset('9:16').presetHash)
  assert.equal(plan.subtitleRegion.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
  assert.deepEqual(plan.placements.map((placement) => placement.kind).toSorted(), ['cta', 'logo', 'subtitle-region'])
  assert.deepEqual(plan.placements.map((placement) => placement.zIndex), [1, 2, 3])
  const logo = plan.placements.find((placement) => placement.kind === 'logo')
  assert.equal(logo.assetSha256, LOGO_SHA)
  assert.doesNotThrow(() => validateRenderPlacementPlan(plan))

  // Half-open time range: the CTA is drawn at 59 and gone at 60.
  const cta = plan.placements.find((placement) => placement.kind === 'cta')
  assert.equal(cta.timeRange.endFrame, 60)
  assert.equal(drawablePlacementsAtFrame(plan, 0).length, 1)
  assert.equal(drawablePlacementsAtFrame(plan, 89).length, 1)

  const tamper = (mutate) => {
    const copy = structuredClone(plan)
    mutate(copy)
    return copy
  }
  const rejects = [
    ['bounds outside the canvas', tamper((copy) => { copy.placements[0].bounds.x = 0.9; copy.placements[0].bounds.width = 0.3 })],
    ['rewritten plan hash', tamper((copy) => { copy.placementPlanHash = sha('c') })],
    ['rewritten asset digest', tamper((copy) => { copy.placements.find((item) => item.kind === 'logo').assetSha256 = sha('d') })],
    ['empty frame interval', tamper((copy) => { copy.placements[0].timeRange.endFrame = copy.placements[0].timeRange.startFrame })],
    ['duplicated zIndex', tamper((copy) => { copy.placements[1].zIndex = copy.placements[0].zIndex })],
    ['drifted preset hash', tamper((copy) => { copy.outputPresetHash = sha('e') })],
    ['subtitle region from another preset', tamper((copy) => { copy.subtitleRegion = deriveSubtitleRegion({ spec: readOutputFormatPreset('9:16').spec, presetId: 'karaoke-pill' }) })],
    ['asset on a reserved region', tamper((copy) => { const region = copy.placements.find((item) => item.kind === 'subtitle-region'); region.assetArtifactId = 'artifact-x'; region.assetSha256 = LOGO_SHA })],
  ]
  for (const [reason, candidate] of rejects) {
    assert.throws(() => validateRenderPlacementPlan(candidate), (error) => codeOf(error) === 'INVALID_RENDER_INPUT', reason)
  }
})

test('T-FR-163 a drawable placement without a digest is refused at build time', () => {
  assert.throws(() => createRenderPlacementPlan({
    format: '9:16', canvas: { width: 540, height: 960 }, durationFrames: 90,
    elements: [{ id: 'logo-1', kind: 'logo', anchor: 'auto', priority: 90, readingOrder: 0, minWidth: 0.1, maxWidth: 0.3, minHeight: 0.04, maxHeight: 0.2, timeRange: { startFrame: 0, endFrame: 90 }, assetArtifactId: 'artifact-logo-1' }],
  }), (error) => codeOf(error) === 'INVALID_RENDER_INPUT')
})

// ---------------------------------------------------------------------------
// T-FR-164 — reframe trajectory
// ---------------------------------------------------------------------------

const CROP_WIDTH = 0.5625 / (640 / 360)
const reframePlanFixture = (overrides) => createRenderReframePlan({
  format: '9:16', variantId: '9:16', fps: 30, durationFrames: 90,
  source: { width: 640, height: 360 },
  ranges: [{
    clipId: 'clip-1', startFrame: 0, endFrame: 90, interpolation: 'linear',
    keyframes: [
      { frame: 0, crop: { x: 0, y: 0, width: CROP_WIDTH, height: 1 } },
      { frame: 45, crop: { x: 0.075, y: 0, width: CROP_WIDTH, height: 1 } },
      { frame: 89, crop: { x: 0.15, y: 0, width: CROP_WIDTH, height: 1 } },
    ],
  }],
  ...(overrides ?? {}),
})

test('T-FR-164 the reframe plan interpolates linearly and is content-addressed', () => {
  const plan = reframePlanFixture()
  assert.equal(plan.reframePlanHash, reframePlanFixture().reframePlanHash)
  assert.equal(plan.ranges[0].source, 'plan')
  const range = reframeRangeAtFrame(plan, 22)
  assert.equal(range.clipId, 'clip-1')
  // Halfway between keyframe 0 (x=0) and keyframe 45 (x=0.075).
  assert.ok(Math.abs(interpolateReframeCrop(range, 22).x - 0.075 * 22 / 45) < 1e-12)
  assert.equal(interpolateReframeCrop(range, 0).x, 0)
  assert.equal(interpolateReframeCrop(range, 45).x, 0.075)
  assert.equal(interpolateReframeCrop(range, 89).x, 0.15)
  // Width never moves: a trajectory pans, it does not zoom.
  for (const frame of [0, 22, 45, 67, 89]) assert.equal(interpolateReframeCrop(range, frame).width, CROP_WIDTH)
  assert.throws(() => interpolateReframeCrop(range, 90), (error) => codeOf(error) === 'INVALID_RENDER_INPUT')
  // A single keyframe is a static crop and stays valid.
  const staticPlan = createRenderReframePlan({
    format: '9:16', variantId: '9:16', fps: 30, durationFrames: 90, source: { width: 640, height: 360 },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 90, interpolation: 'hold', keyframes: [{ frame: 0, crop: { x: 0.2, y: 0, width: CROP_WIDTH, height: 1 } }] }],
  })
  assert.equal(interpolateReframeCrop(staticPlan.ranges[0], 89).x, 0.2)
  assert.notEqual(staticPlan.reframePlanHash, plan.reframePlanHash)
})

test('T-FR-164 gaps, overlaps, zooms and rewritten hashes fail closed', () => {
  const plan = reframePlanFixture()
  const tamper = (mutate) => {
    const copy = structuredClone(plan)
    mutate(copy)
    return copy
  }
  const rejects = [
    ['timeline gap', tamper((copy) => { copy.ranges[0].endFrame = 80 })],
    ['keyframe outside its range', tamper((copy) => { copy.ranges[0].keyframes[2].frame = 90 })],
    ['non monotonic keyframes', tamper((copy) => { copy.ranges[0].keyframes[1].frame = 0 })],
    ['zoom instead of pan', tamper((copy) => { copy.ranges[0].keyframes[1].crop.width = CROP_WIDTH * 0.8 })],
    ['aspect mismatch', tamper((copy) => { for (const keyframe of copy.ranges[0].keyframes) keyframe.crop.height = 0.5 })],
    ['rewritten plan hash', tamper((copy) => { copy.reframePlanHash = sha('c') })],
    ['drifted preset hash', tamper((copy) => { copy.outputPresetHash = sha('e') })],
  ]
  for (const [reason, candidate] of rejects) {
    assert.throws(() => validateRenderReframePlan(candidate), (error) => codeOf(error) === 'INVALID_RENDER_INPUT', reason)
  }
  assert.throws(() => createRenderReframePlan({
    format: '9:16', variantId: '9:16', fps: 30, durationFrames: 90, source: { width: 640, height: 360 },
    ranges: [
      { clipId: 'clip-1', startFrame: 0, endFrame: 45, interpolation: 'hold', keyframes: [{ frame: 0, crop: { x: 0, y: 0, width: CROP_WIDTH, height: 1 } }] },
      { clipId: 'clip-2', startFrame: 30, endFrame: 90, interpolation: 'hold', keyframes: [{ frame: 30, crop: { x: 0, y: 0, width: CROP_WIDTH, height: 1 } }] },
    ],
  }), (error) => codeOf(error) === 'INVALID_RENDER_INPUT')
})

test('T-FR-164 a manual override only rewrites the named range of the named variant', () => {
  const override = { id: 'override-1', variantId: '9:16', startFrame: 0, endFrame: 90, crop: { x: 0.3, y: 0, width: CROP_WIDTH, height: 1 } }
  const overridden = reframePlanFixture({ overrides: [override] })
  assert.equal(overridden.ranges[0].source, 'manual')
  assert.equal(overridden.ranges[0].keyframes.length, 1)
  assert.equal(interpolateReframeCrop(overridden.ranges[0], 89).x, 0.3)
  assert.notEqual(overridden.reframePlanHash, reframePlanFixture().reframePlanHash)
  // Another variant's override cannot reach this plan.
  assert.throws(
    () => reframePlanFixture({ overrides: [{ ...override, variantId: '16:9' }] }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
  // An override that names no existing range is refused instead of silently ignored.
  assert.throws(
    () => reframePlanFixture({ overrides: [{ ...override, startFrame: 10, endFrame: 20 }] }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
})

// ---------------------------------------------------------------------------
// T-FR-165 — the critic runs after the geometry and binds its verdict to it
// ---------------------------------------------------------------------------

const renderElementMap = (proxyHash, extra = []) => Object.freeze({
  schemaVersion: 'render-element-map/v1',
  proxyHash, fps: 30, durationFrames: 90,
  canvas: { width: 540, height: 960 },
  elements: Object.freeze([
    { frame: 0, elementId: 'presenter-1', type: 'presenter', bounds: { x: 0, y: 0, width: 540, height: 960 }, opacity: 1 },
    ...extra,
  ]),
})

test('T-FR-165 every format issue is bound to the geometry that produced its frames', () => {
  const placementPlanHash = placementPlanFixture().placementPlanHash
  const reframePlanHash = reframePlanFixture().reframePlanHash
  const clipped = [{ frame: 0, elementId: 'subtitle-1', type: 'subtitle', bounds: { x: -40, y: 800, width: 400, height: 90 }, opacity: 1 }]
  const report = critiqueOutputFormat({
    outputSpecId: readOutputFormatPreset('9:16').spec.id, format: '9:16',
    proxyHash: sha('1'), map: renderElementMap(sha('1'), clipped),
    placementPlanHash, reframePlanHash,
  })
  assert.equal(report.schemaVersion, 'format-quality-report/v2')
  assert.equal(report.status, 'blocked')
  assert.equal(report.placementPlanHash, placementPlanHash)
  assert.equal(report.reframePlanHash, reframePlanHash)
  assert.ok(report.issues.length >= 1)
  for (const issue of report.issues) {
    assert.equal(issue.placementPlanHash, placementPlanHash)
    assert.equal(issue.reframePlanHash, reframePlanHash)
  }
  // The same frames judged against a different geometry are a different report.
  const other = critiqueOutputFormat({
    outputSpecId: readOutputFormatPreset('9:16').spec.id, format: '9:16',
    proxyHash: sha('1'), map: renderElementMap(sha('1'), clipped),
    placementPlanHash: null, reframePlanHash: null,
  })
  assert.notEqual(other.reportHash, report.reportHash)
  assert.equal(other.placementPlanHash, null)

  // A blocker stays inside its own variant.
  const healthy = critiqueOutputFormat({
    outputSpecId: readOutputFormatPreset('16:9').spec.id, format: '16:9',
    proxyHash: sha('2'), map: renderElementMap(sha('2')),
    placementPlanHash, reframePlanHash,
  })
  const selection = selectExportableVariants([report, healthy])
  assert.deepEqual(selection.blockedOutputSpecIds, [readOutputFormatPreset('9:16').spec.id])
  assert.deepEqual(selection.approvedOutputSpecIds, [readOutputFormatPreset('16:9').spec.id])
  assert.deepEqual(selection.decisions.map((decision) => decision.placementPlanHash), [placementPlanHash, placementPlanHash])

  // A report whose issues cite another geometry is not evidence about this render.
  const forged = { ...report, issues: report.issues.map((issue) => ({ ...issue, reframePlanHash: sha('9') })) }
  assert.throws(() => selectExportableVariants([forged]), (error) => codeOf(error) === 'INVALID_RENDER_INPUT')
})

// ---------------------------------------------------------------------------
// T-FR-171 — subtitle resolution is bound to the registry, and `none` cuts cues only
// ---------------------------------------------------------------------------

const subtitleConfiguration = (mode) => createProjectSubtitleConfiguration({
  id: `subtitle-config-${mode}`, workspaceId: 'workspace-1', projectId: 'project-1',
  baseVersionId: 'version-1', resultVersionId: 'version-2', commandId: 'command-1',
  variantId: '9:16', action: 'set', previousConfigurationId: null,
  requested: mode === 'none' ? { mode: 'none' } : { mode: 'manual', presetId: 'kinetic', presetVersion: 1 },
  resolved: mode === 'none' ? { enabled: false } : { enabled: true, ...subtitlePresetReference('kinetic') },
  origin: mode === 'none' ? 'disabled' : 'project',
  transcriptHash: TRANSCRIPT_HASH, createdAt: '2026-08-14T10:00:00.000Z',
})

const CUES = Object.freeze([
  Object.freeze({ text: 'Primeira fala', fromFrame: 0, toFrame: 30 }),
  Object.freeze({ text: 'Segunda fala', fromFrame: 30, toFrame: 60 }),
])

test('T-FR-171 the render input subtitle section carries and re-checks the registry hash', () => {
  const enabled = materializeRenderInputSubtitles({ configuration: subtitleConfiguration('manual'), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues: CUES })
  assert.equal(enabled.schemaVersion, 'render-input-subtitles/v2')
  assert.equal(enabled.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
  assert.equal(enabled.cues.length, 2)
  assert.doesNotThrow(() => requireRenderInputSubtitleRegistry(enabled))
  assert.throws(
    () => requireRenderInputSubtitleRegistry({ ...enabled, registryHash: sha('f') }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
  assert.throws(
    () => requireRenderInputSubtitleRegistry({ ...enabled, presetHash: sha('f'), sectionHash: calculateCanonicalHash({ ...enabled, presetHash: sha('f'), sectionHash: undefined }) }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )

  // `none` removes the cues and nothing else: the transcript identity travels untouched.
  const disabled = materializeRenderInputSubtitles({ configuration: subtitleConfiguration('none'), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues: CUES })
  assert.equal(disabled.cues.length, 0)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.presetId, null)
  assert.equal(disabled.transcriptHash, TRANSCRIPT_HASH)
  assert.equal(disabled.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
  assert.doesNotThrow(() => requireRenderInputSubtitleRegistry(disabled))
})

const renderInputFixture = () => createRenderInputSpec({
  schemaVersion: 'render-input/v1',
  renderer: { id: 'remotion', version: '4.0.489', digest: sha('8') },
  composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
  plan: { id: 'edit-plan-subtitles', versionId: 'project-version-subtitles', hash: sha('3') },
  output: { id: 'subtitle-runtime-9x16', locale: 'pt-BR', aspectRatio: '9:16', width: 1080, height: 1920, fps: 30, safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 90 },
  assets: [{ id: 'primary-video', artifactId: 'artifact-primary-subtitles', artifactKey: 'subtitles/primary.mp4', kind: 'video', role: 'primary', ordinal: 0, sha256: sha('6'), byteSize: 1_000 }],
  props: {
    primaryVideoAssetId: 'primary-video',
    scenes: [],
    subtitles: CUES.map((cue) => ({ ...cue })),
    palette: { primary: '#FFB800', secondary: '#20202A', accent: '#FF6B35', text: '#FFFFFF', background: '#050508' },
  },
})

test('T-FR-171 the compiler validates the registry before compiling a single cue', () => {
  const spec = renderInputFixture()
  const materialized = { ...spec, assets: spec.assets.map((asset) => ({ ...asset, uri: `file:///materialized/${asset.id}` })) }
  const enabled = materializeRenderInputSubtitles({ configuration: subtitleConfiguration('manual'), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues: CUES })
  const disabled = materializeRenderInputSubtitles({ configuration: subtitleConfiguration('none'), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues: CUES })

  assert.equal(compileApolloVideoRenderProps(materialized).subtitles.length, 2)
  const withResolution = compileApolloVideoRenderProps(materialized, undefined, enabled)
  assert.equal(withResolution.subtitles.length, 2)
  assert.equal(withResolution.subtitlePreset.presetHash, subtitlePresetHash('kinetic'))
  assert.equal(withResolution.subtitleStyle, 'kinetic')

  // `none` compiles zero cues while every other prop stays exactly the same.
  const suppressed = compileApolloVideoRenderProps(materialized, undefined, disabled)
  assert.equal(suppressed.subtitles.length, 0)
  assert.deepEqual(suppressed.scenes, withResolution.scenes)
  assert.equal(suppressed.videoSrc, withResolution.videoSrc)
  assert.deepEqual(suppressed.palette, withResolution.palette)

  assert.throws(
    () => compileApolloVideoRenderProps(materialized, undefined, { ...enabled, registryHash: sha('f') }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
  assert.throws(
    () => compileApolloVideoRenderProps(materialized, undefined, { ...enabled, variantId: '16:9', sectionHash: enabled.sectionHash }),
    (error) => codeOf(error) === 'INVALID_RENDER_INPUT',
  )
})
