import assert from 'node:assert/strict'
import test from 'node:test'

import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { planCaptionPlacement } = await import('../../src/v2/application/plan-caption-placement.ts')
const { deriveEditorialRenderGeometry } = await import('../../src/v2/application/derive-editorial-render-geometry.ts')
const { CAPTION_TEXT_DOES_NOT_FIT, captionLayoutOverflows, deriveCaptionGeometry, layoutBurnedCaption } = await import('../../src/v2/domain/caption-burn-layout.ts')
const { critiqueOutputFormat } = await import('../../src/v2/domain/format-quality-critic.ts')
const { certifyFinalCaptions, describeFinalCaptionCertification, FINAL_CAPTION_CERTIFICATION_POLICY } = await import('../../src/v2/domain/final-caption-certification.ts')
const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
const { subtitleAnchorDecisionFor } = await import('../../src/v2/domain/subtitle-anchor-plan.ts')
const { materializeSubtitlePresetSnapshot, SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } = await import('../../src/v2/domain/subtitle-system.ts')
const { buildAssSubtitles } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')

/**
 * W70 readiness (R3). A caption whose text does not fit the band the plan certified is decided upon BEFORE the render, by the layout the
 * renderer draws with: a hard issue in a proxy, omitted and listed in a final. The case that made it necessary: a caption of three lines in
 * the two-line 16:9 band overflows by about 11 px, half above and half below the band, which is inside the 6 px tolerance of the W65 pixel
 * critic - it used to pass.
 */
const FPS = 30
const FRAMES = 150
// Three lines at the 16:9 proxy canvas (22 px kinetic font, 762 px of line), the third line holding one word.
const THREE_LINES_16X9 = 'Esta legenda tem palavras suficientes para ocupar exatamente três linhas na faixa de legendas larga do formato horizontal dezesseis por nove, sem cortar nada'
const FITS = 'Um texto um pouco mais longo que precisa de duas linhas'
const clip = Object.freeze({ id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: FRAMES, timelineInFrame: 0, timelineOutFrame: FRAMES, rate: 1 })
const master = Object.freeze({ width: 1280, height: 720 })
// The only face is in the top-left corner: the bottom band is certified free and is the one decided.
const envelope = sealedSourceWindow({ start: 0, end: FRAMES, rowsAt: () => [[0.9, 40 / master.width, 40 / master.height, 100 / master.width, 100 / master.height]] })
const reader = Object.freeze({ async listSourceWindows() { return [{ envelope, authentication: { authenticated: true, reasons: [] } }] } })
const canvas169 = (() => { const preset = readOutputFormatPreset('16:9'); return { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height } })()
const cues = Object.freeze([
  Object.freeze({ id: 'cue-long', startFrame: 10, endFrame: 60, text: THREE_LINES_16X9 }),
  Object.freeze({ id: 'cue-short', startFrame: 80, endFrame: 130, text: FITS }),
])

async function plan169(list = cues) {
  return planCaptionPlacement({ faceEvidence: reader, clock: () => new Date('2026-10-21T12:00:00.000Z') }, {
    workspaceId: 'workspace-1', projectId: 'project-1', format: '16:9', canvas: canvas169,
    editPlan: { fps: FPS, durationFrames: FRAMES }, clips: [clip],
    renderSources: [{ artifactId: 'source-1', sha256: envelope.sourceSha256, mediaType: 'video', probe: master }],
    subtitleCues: list.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame })), subtitlePresetId: 'kinetic',
    placementElements: [], primarySourceArtifactId: 'source-1',
  })
}

test('a three-line 16:9 caption does not fit its two-line band, and the renderer draws exactly the lines the check measured', async () => {
  const { placementPlan } = await plan169()
  const anchorPlan = placementPlan.subtitleAnchorPlan
  for (const cue of cues) assert.equal(subtitleAnchorDecisionFor(anchorPlan, cue.id).disposition, 'placed', `${cue.id} is placed in a certified band`)
  const geometry = deriveCaptionGeometry(anchorPlan, canvas169)
  assert.equal(geometry.maxLines, 2)
  const long = layoutBurnedCaption({ text: THREE_LINES_16X9, geometry })
  assert.equal(long.layout.lines.length, 3, JSON.stringify(long.layout.lines))
  assert.equal(long.layout.fits, false)
  assert.ok(long.layout.heightPx - geometry.bandHeightPx < 2 * 6 + 1, 'the overflow is within the reach of the pixel critic tolerance on each side - which is why the layout decides')
  const overflows = captionLayoutOverflows({ anchorPlan, cues, canvas: canvas169 })
  assert.deepEqual(overflows.map((overflow) => [overflow.code, overflow.cueId, overflow.lines, overflow.maxLines, overflow.startFrame, overflow.endFrame]),
    [[CAPTION_TEXT_DOES_NOT_FIT, 'cue-long', 3, 2, 10, 60]], 'only the cue that does not fit')
  assert.match(overflows[0].message, /needs 3 lines of 22 px; its band holds 2/)
  // the renderer burns the very lines that were measured (one layout, two readers)
  const ass = buildAssSubtitles({ width: canvas169.width, height: canvas169.height, fps: FPS, durationFrames: FRAMES, cues, anchorPlan })
  const event = ass.split('\n').find((line) => line.startsWith('Dialogue: 0,') && line.includes(long.layout.lines[0]))
  assert.ok(event?.endsWith(long.layout.lines.join('\\N')), event)
  // a style exception's preset (its casing and outline) is part of the layout
  const upper = layoutBurnedCaption({ text: FITS, presetId: 'caps-stroke', geometry })
  assert.equal(upper.layout.lines.join(' '), FITS.toLocaleUpperCase('pt-BR'))
  // a cue the plan does not draw cannot overflow anything
  const suppressed = { ...anchorPlan, decisions: anchorPlan.decisions.map((decision) => decision.cueId === 'cue-long' ? { ...decision, anchor: null, bounds: null, suppressed: true } : decision) }
  assert.deepEqual(captionLayoutOverflows({ anchorPlan: suppressed, cues, canvas: canvas169 }), [])
  assert.deepEqual(captionLayoutOverflows({ anchorPlan: null, cues, canvas: canvas169 }), [])
})

test('in a proxy the cue that does not fit is a HARD issue of its output: the review is blocked whatever the pixel critic said', async () => {
  const { placementPlan } = await plan169()
  const overflows = captionLayoutOverflows({ anchorPlan: placementPlan.subtitleAnchorPlan, cues, canvas: canvas169 })
  const map = { schemaVersion: 'render-element-map/v1', proxyHash: 'd'.repeat(64), fps: FPS, durationFrames: FRAMES, canvas: canvas169, elements: [] }
  const base = { outputSpecId: readOutputFormatPreset('16:9').spec.id, format: '16:9', proxyHash: 'd'.repeat(64), map, placementPlanHash: placementPlan.placementPlanHash, subtitleAnchorPlan: placementPlan.subtitleAnchorPlan }
  const clean = critiqueOutputFormat(base)
  assert.equal(clean.status, 'passed', 'the plan alone, and pixels that agree with it, say nothing')
  const blocked = critiqueOutputFormat({ ...base, captionLayoutOverflows: overflows })
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.exportAllowed, false)
  const issue = blocked.issues.find((entry) => entry.code === CAPTION_TEXT_DOES_NOT_FIT)
  assert.equal(issue.severity, 'hard')
  assert.deepEqual(issue.elementIds, ['subtitle:cue-long'])
  assert.deepEqual(issue.evidenceRange, { startFrame: 10, endFrame: 60 })
  assert.ok(issue.evidenceIds.includes(`subtitle-anchor-plan:${placementPlan.subtitleAnchorPlan.anchorPlanHash}`))
  assert.throws(() => critiqueOutputFormat({ ...base, captionLayoutOverflows: [{ ...overflows[0], endFrame: FRAMES + 1 }] }), /outside the rendered timeline/)
})

const source169 = (list = cues) => Object.freeze({
  format: '16:9', sourceArtifactId: 'source-1',
  editPlan: Object.freeze({ fps: FPS, durationFrames: FRAMES, subtitleTracks: [{ presetId: 'kinetic', cues: list.map((cue) => ({ ...cue, anchor: 'bottom' })) }], videoTracks: [{ kind: 'base-video', clips: [clip] }] }),
  subtitleResolution: Object.freeze({ presetId: 'kinetic', presetHash: subtitlePresetHash('kinetic'), registryHash: SUBTITLE_STYLE_REGISTRY.registryHash, enabled: true, presetSnapshot: materializeSubtitlePresetSnapshot('kinetic') }),
  renderSources: Object.freeze([{ artifactId: 'source-1', sha256: envelope.sourceSha256, mediaType: 'video', probe: master }]),
})
const geometryOf = (captionTextOverflow) => deriveEditorialRenderGeometry({
  source: source169(), canvas: canvas169, workspaceId: 'workspace-1', projectId: 'project-1', clips: [clip], faceEvidence: reader,
  clock: () => new Date('2026-10-21T12:00:00.000Z'), uncertifiedCues: 'omit-and-list', ...(captionTextOverflow ? { captionTextOverflow } : {}),
})

test('the proxy draws the cue that does not fit (the person sees it) and reports it; nothing is planned twice', async () => {
  const drawn = await geometryOf(undefined)
  assert.deepEqual(drawn.subtitleCues.map((cue) => cue.id), ['cue-long', 'cue-short'])
  assert.deepEqual(drawn.captionOverflows.map((overflow) => overflow.cueId), ['cue-long'])
  assert.ok(subtitleAnchorDecisionFor(drawn.placementPlan.subtitleAnchorPlan, 'cue-long').anchor !== null)
})

test('in a final the cue that does not fit is omitted (never burned) and listed as a review item; the cue that fits is burned', async () => {
  const final = await geometryOf('omit-and-list')
  assert.deepEqual(final.subtitleCues.map((cue) => cue.id), ['cue-short'], 'the renderer is not given it')
  assert.equal(subtitleAnchorDecisionFor(final.placementPlan.subtitleAnchorPlan, 'cue-long'), null, 'the plan does not place it')
  assert.equal(subtitleAnchorDecisionFor(final.placementPlan.subtitleAnchorPlan, 'cue-short').disposition, 'placed')
  assert.deepEqual(final.captionOverflows.map((overflow) => overflow.cueId), ['cue-long'], 'and it is reported, to be listed')
  const certification = certifyFinalCaptions({ plan: final.placementPlan, pixelCheck: { measurement: 'completed', issues: [] }, layoutOmitted: final.captionOverflows })
  assert.equal(certification.admissible, true, certification.failures.join('; '))
  assert.deepEqual(certification.receipt.burned.map((entry) => entry.cueId), ['cue-short'])
  assert.deepEqual(certification.receipt.omitted.map((entry) => [entry.cueId, entry.code, entry.disposition]), [['cue-long', CAPTION_TEXT_DOES_NOT_FIT, 'review-required']])
  assert.deepEqual(certification.receipt.omitted[0].reasons, ['3/2 lines', `${final.captionOverflows[0].widthPx}/${final.captionOverflows[0].maxWidthPx} px`])
  assert.match(describeFinalCaptionCertification(certification.receipt), /1 caption\(s\) burned.*1 omitted and listed for review: cue-long \(CAPTION_TEXT_DOES_NOT_FIT\)/)
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY.overflowingCue.code, CAPTION_TEXT_DOES_NOT_FIT, 'the rule is part of the pinned certification policy')
  // a cue listed as omitted for its layout that the plan still places would be burned: that is a failure, never a listing
  const placed = await geometryOf(undefined)
  const contradicted = certifyFinalCaptions({ plan: placed.placementPlan, pixelCheck: { measurement: 'completed', issues: [] }, layoutOmitted: placed.captionOverflows })
  assert.equal(contradicted.admissible, false)
  assert.match(contradicted.failures.join('; '), /cue-long does not fit its band .* and is still in the caption plan/)
})
