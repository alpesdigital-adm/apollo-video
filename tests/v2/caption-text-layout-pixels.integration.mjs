import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { planCaptionPlacement } = await import('../../src/v2/application/plan-caption-placement.ts')
const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
const { captionTextWidthPx, layoutCaption } = await import('../../src/v2/domain/caption-text-layout.ts')
const { createColorPipelineCompilation } = await import('../../src/v2/domain/color-pipeline-compilation.ts')
const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
const { createEditorialAudioTimelineHash } = await import('../../src/v2/domain/production-modes.ts')
const { subtitleAnchorDecisionFor } = await import('../../src/v2/domain/subtitle-anchor-plan.ts')
const { FfmpegCaptionPixelCritic } = await import('../../src/v2/infrastructure/media/ffmpeg-caption-pixel-critic.ts')
const { FfmpegEditorialProxyRenderer, deriveCaptionGeometry } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')
const { captionLayoutOverflows } = await import('../../src/v2/domain/caption-burn-layout.ts')
const { critiqueOutputFormat } = await import('../../src/v2/domain/format-quality-critic.ts')
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

/**
 * W70 prep. The 16:9 caption defect, on the real renderer, real FFmpeg and the production W65 pixel critic, in both canvases.
 *
 * Before the fix any caption over 20 characters was drawn in two lines of a 36 px font at 16:9 (74 rows in a 56-row band) and the critic
 * hard-blocked it, in the proxy and in the final. Here cues of 16 to 52 characters (with `Ação`, `Última cue.`) are burned and judged:
 *  - the production critic reports no issue at all (no CAPTION_PLACEMENT_MISMATCH, no face overlap, nothing unavailable);
 *  - an oracle of its own - the caption's near-white glyphs on the delivered frame - is inside the band the plan decided, inside the
 *    output's safe area and inside the canvas, and no wider than the layout predicted (the estimate is never narrower than the pixels);
 *  - the lines drawn are the lines the layout chose, and a text that cannot fit its lines is NOT cut: it overflows and the critic blocks it.
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')

const FPS = 30
const FRAMES = 150
const PRESET_ID = 'kinetic'
const CUES = Object.freeze([
  { id: 'cue-a', startFrame: 10, endFrame: 30, text: 'LEGENDA DE TESTE' },
  { id: 'cue-b', startFrame: 35, endFrame: 55, text: 'Ação imediata para o seu canal' },
  { id: 'cue-c', startFrame: 60, endFrame: 80, text: 'Última cue. Veja como funciona agora' },
  { id: 'cue-d', startFrame: 85, endFrame: 105, text: 'Resultado real depois de semanas de uso' },
  { id: 'cue-e', startFrame: 110, endFrame: 130, text: 'Um texto um pouco mais longo que precisa de duas linhas' },
])
const colorMetadata = Object.freeze({ colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 })
function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({ id: `probe-${artifactId}`, workspaceId: 'workspace-w70-layout', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-08-21T08:00:00.000Z' })
  const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
  return createColorPipelineCompilation({ id: `compilation-${artifactId}`, workspaceId: probe.workspaceId, projectId: 'project-w70-layout',
    sourceArtifactId: artifactId, sourceManifestId: manifestId, probe, outputMetadata: colorMetadata, createdByClientId: 'client-w70-layout',
    createdAt: '2026-08-21T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ] })
}

// ---- the oracle: code of its own, no import from the critic -------------------------------------------------------------------
function rawFrame(path, frame, width, height) {
  const bytes = execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(bytes.byteLength, width * height * 3, `frame ${frame} of ${path} decoded`)
  return bytes
}
function glyphBox(raw, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3
      if (!(raw[o] > 215 && raw[o + 1] > 215 && raw[o + 2] > 215)) continue
      count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return count < 40 ? null : { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1, count }
}
/** The rows of text in a glyph box: runs of rows that contain a glyph pixel, separated by empty rows. */
function glyphRows(raw, width, box) {
  const runs = []
  let open = null
  for (let y = box.top; y < box.bottom; y += 1) {
    let any = false
    for (let x = box.left; x < box.right && !any; x += 1) {
      const o = (y * width + x) * 3
      any = raw[o] > 215 && raw[o + 1] > 215 && raw[o + 2] > 215
    }
    if (any && open === null) open = y
    if (!any && open !== null) { runs.push([open, y]); open = null }
  }
  if (open !== null) runs.push([open, box.bottom])
  return runs
}
const isMarker = (r, g, b) => r > 170 && b > 170 && g < 100
const isFrameGreen = (r, g, b) => g > 190 && r < 80 && b < 80
function boxOf(raw, width, height, predicate, within = null) {
  const from = within ?? { left: 0, top: 0, right: width, bottom: height }
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = Math.max(0, Math.floor(from.top)); y < Math.min(height, Math.ceil(from.bottom)); y += 1) {
    for (let x = Math.max(0, Math.floor(from.left)); x < Math.min(width, Math.ceil(from.right)); x += 1) {
      const o = (y * width + x) * 3
      if (!predicate(raw[o], raw[o + 1], raw[o + 2])) continue
      count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return count < 40 ? null : { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1, count }
}
/** The tests-only veto detector: it finds the stand-in face (the magenta square) by colour on the caption-free frame, inside the picture's green frame. */
const markerVeto = {
  id: 'color-key-marker',
  async detect({ width, height, rgb }) {
    const picture = boxOf(rgb, width, height, isFrameGreen)
    const box = picture ? boxOf(rgb, width, height, isMarker, picture) : null
    return box ? [{ x: box.left / width, y: box.top / height, width: (box.right - box.left) / width, height: (box.bottom - box.top) / height }] : []
  },
}
const px = (bounds, canvas) => ({ left: bounds.x * canvas.width, top: bounds.y * canvas.height, right: (bounds.x + bounds.width) * canvas.width, bottom: (bounds.y + bounds.height) * canvas.height })
const within = (inner, outer, slack) => inner.left >= outer.left - slack && inner.right <= outer.right + slack && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack

async function world(format, cues) {
  const root = await mkdtemp(join(tmpdir(), `apollo-w70-layout-${format.replace(':', 'x')}-`))
  const preset = readOutputFormatPreset(format)
  const canvas = { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height }
  const master = format === '16:9' ? { width: 1280, height: 720 } : { width: 720, height: 1280 }
  const sourcePath = join(root, 'master.mp4')
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x303030:s=${master.width}x${master.height}:r=${FPS}:d=5`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
    '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=6,drawbox=x=40:y=40:w=60:h=60:color=0xff00ff:t=fill`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', sourcePath], { windowsHide: true, timeout: 180_000 })
  const clip = Object.freeze({ id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: FRAMES, timelineInFrame: 0, timelineOutFrame: FRAMES, rate: 1 })
  // The face evidence says the only face is in the top-left corner: the bottom band is free and is the one the plan decides.
  const envelope = sealedSourceWindow({ start: 0, end: FRAMES, rowsAt: () => [[0.9, 40 / master.width, 40 / master.height, 100 / master.width, 100 / master.height]] })
  const reader = { async listSourceWindows() { return [{ envelope }] } }
  const planned = await planCaptionPlacement({ faceEvidence: reader, clock: () => new Date('2026-10-20T12:00:00.000Z') }, {
    workspaceId: 'workspace-1', projectId: 'project-1', format, canvas,
    editPlan: { fps: FPS, durationFrames: FRAMES, videoTracks: [{ kind: 'base-video', clips: [clip] }] }, clips: [clip],
    renderSources: [{ artifactId: 'source-1', sha256: 'b'.repeat(64), mediaType: 'video', probe: { width: master.width, height: master.height } }],
    subtitleCues: cues.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame })), subtitlePresetId: PRESET_ID,
    placementElements: [], primarySourceArtifactId: 'source-1' })
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  const base = {
    renderKind: 'proxy', sources: [{ artifactId: 'source-1', path: sourcePath, mediaType: 'video', colorPipelineCompilation: colorCompilation('source-1') }],
    lutPaths: {}, clips: [clip], audioTimelineHash: createEditorialAudioTimelineHash({ fps: FPS, clips: [clip] }), fps: FPS, format, placementPlan: planned.placementPlan,
  }
  const render = (suffix, list) => renderer.render({ ...base, operationId: `layout-${format.replace(':', 'x')}-${suffix}`, subtitleCues: list })
  return { root, canvas, spec: preset.spec, plan: planned.placementPlan, render, critic: new FfmpegCaptionPixelCritic({ ffmpegPath, faceVeto: markerVeto }) }
}

async function judge(w, cues) {
  const delivered = await w.render('delivered', cues.map((cue) => ({ ...cue })))
  const verification = await w.critic.verify({ plan: w.plan, deliveredPath: delivered.outputPath,
    renderControl: async () => ({ path: (await w.render('control', [])).outputPath }) })
  return { delivered, verification }
}

for (const format of ['16:9', '9:16']) {
  test(`W70 prep ${format}: captions of 16 to 55 characters are drawn inside the certified band, the safe area and the canvas, and the critic has nothing to say`, { timeout: 8 * 60_000 }, async () => {
    const w = await world(format, CUES)
    try {
      const geometry = deriveCaptionGeometry(w.plan.subtitleAnchorPlan, w.canvas)
      const { delivered, verification } = await judge(w, CUES)
      assert.deepEqual(verification.issues, [], `the production critic judged the delivered pixels: ${JSON.stringify(verification.issues)}`)
      const safe = { left: w.spec.safeArea.left * w.canvas.width, right: (1 - w.spec.safeArea.right) * w.canvas.width, top: w.spec.safeArea.top * w.canvas.height, bottom: (1 - w.spec.safeArea.bottom) * w.canvas.height }
      const measured = []
      for (const cue of CUES) {
        const frame = Math.floor((cue.startFrame + cue.endFrame) / 2)
        const raw = rawFrame(delivered.outputPath, frame, w.canvas.width, w.canvas.height)
        const glyphs = glyphBox(raw, w.canvas.width, w.canvas.height)
        assert.ok(glyphs, `${cue.id}: the caption is in the pixels`)
        const decision = subtitleAnchorDecisionFor(w.plan.subtitleAnchorPlan, cue.id)
        assert.equal(decision.disposition, 'placed', cue.id)
        const band = px(decision.bounds, w.canvas)
        assert.ok(within(glyphs, band, 2), `${cue.id} ${format}: glyphs ${JSON.stringify(glyphs)} inside the band ${JSON.stringify(band)}`)
        assert.ok(within(glyphs, safe, 0), `${cue.id} ${format}: glyphs inside the safe area ${JSON.stringify(safe)}`)
        assert.ok(glyphs.left >= 0 && glyphs.right <= w.canvas.width && glyphs.top >= 0 && glyphs.bottom <= w.canvas.height, `${cue.id}: inside the canvas`)
        // the lines drawn are the lines the layout chose, and their width never exceeds the estimate
        const layout = layoutCaption({ text: cue.text, fontPx: geometry.fontPx, maxLines: geometry.maxLines, maxWidthPx: captionTextWidthPx(geometry.bandWidthPx, 1) })
        assert.equal(layout.fits, true, `${cue.id}: the layout fits ${geometry.maxLines} lines in the band`)
        const rows = glyphRows(raw, w.canvas.width, glyphs)
        assert.ok(rows.length >= 1 && rows.length <= layout.lines.length + 1, `${cue.id}: ${rows.length} glyph row-runs for ${layout.lines.length} line(s)`)
        assert.ok(glyphs.right - glyphs.left <= layout.widthPx, `${cue.id}: measured width ${glyphs.right - glyphs.left} <= estimated ${layout.widthPx.toFixed(1)}`)
        assert.ok(glyphs.bottom - glyphs.top <= layout.heightPx + 2, `${cue.id}: measured height ${glyphs.bottom - glyphs.top} <= ${layout.heightPx} + 2`)
        measured.push({ cue: cue.id, chars: cue.text.length, lines: layout.lines.length, glyphs: [glyphs.left, glyphs.top, glyphs.right, glyphs.bottom], band: [band.left, band.top, band.right, band.bottom].map(Math.round) })
      }
      // at 16:9 the cues of 30-40 characters (the ones that used to block) are ONE line of the preset font
      if (format === '16:9') for (const entry of measured.filter((item) => item.chars >= 30 && item.chars <= 40)) assert.equal(entry.lines, 1, `${entry.cue} is one line at 16:9`)
      console.log(`W70-LAYOUT ${format} font=${geometry.fontPx} ${JSON.stringify(measured)}`)
      // no caption pixel outside the cues
      assert.equal(glyphBox(rawFrame(delivered.outputPath, 5, w.canvas.width, w.canvas.height), w.canvas.width, w.canvas.height), null)
    } finally { await rm(w.root, { recursive: true, force: true }) }
  })

  test(`W70 prep ${format}: a text that cannot fit its lines is not cut - it overflows the band and the production critic blocks it`, { timeout: 8 * 60_000 }, async () => {
    const overflow = [{ id: 'cue-x', startFrame: 20, endFrame: 60,
      // Five lines at 16:9 (a third line alone stays inside the 6 px tolerance of the critic: the layout reports it, the pixels do not yet).
      text: 'Este texto é propositalmente longo demais para caber em duas linhas dentro da faixa de legendas deste formato, de modo que ele transborda e o crítico precisa reprovar. '.repeat(2).trim() }]
    const w = await world(format, overflow)
    try {
      const geometry = deriveCaptionGeometry(w.plan.subtitleAnchorPlan, w.canvas)
      const layout = layoutCaption({ text: overflow[0].text, fontPx: geometry.fontPx, maxLines: geometry.maxLines, maxWidthPx: captionTextWidthPx(geometry.bandWidthPx, 1) })
      assert.equal(layout.fits, false)
      assert.ok(layout.lines.length > geometry.maxLines, `${layout.lines.length} lines for a band of ${geometry.maxLines}`)
      assert.equal(layout.lines.join(' '), overflow[0].text, 'nothing is cut')
      const { delivered, verification } = await judge(w, overflow)
      assert.ok(verification.issues.some((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH' && issue.severity === 'hard' && issue.cueId === 'cue-x'), JSON.stringify(verification.issues))
      const glyphs = glyphBox(rawFrame(delivered.outputPath, 40, w.canvas.width, w.canvas.height), w.canvas.width, w.canvas.height)
      const decision = subtitleAnchorDecisionFor(w.plan.subtitleAnchorPlan, 'cue-x')
      assert.equal(within(glyphs, px(decision.bounds, w.canvas), 6), false, 'the oracle agrees: the glyphs are not inside the band')
    } finally { await rm(w.root, { recursive: true, force: true }) }
  })
}

test('W70 readiness 16:9: a three-line caption overflows the two-line band by less than the pixel critic tolerance, and the layout blocks it before the render', { timeout: 8 * 60_000 }, async () => {
  // Three lines at 16:9 (the third holds one word): the block is ~11 px taller than the band, about half above and half below it.
  const three = [{ id: 'cue-y', startFrame: 20, endFrame: 60,
    text: 'Esta legenda tem palavras suficientes para ocupar exatamente três linhas na faixa de legendas larga do formato horizontal dezesseis por nove, sem cortar nada' }]
  const w = await world('16:9', three)
  try {
    const anchorPlan = w.plan.subtitleAnchorPlan
    const geometry = deriveCaptionGeometry(anchorPlan, w.canvas)
    const overflows = captionLayoutOverflows({ anchorPlan, cues: three, canvas: w.canvas })
    assert.deepEqual(overflows.map((overflow) => [overflow.cueId, overflow.lines, overflow.maxLines]), [['cue-y', 3, 2]], 'known before anything is rendered')
    const { delivered, verification } = await judge(w, three)
    // drawn in full: three runs of glyph rows, nothing cut
    const raw = rawFrame(delivered.outputPath, 40, w.canvas.width, w.canvas.height)
    const glyphs = glyphBox(raw, w.canvas.width, w.canvas.height)
    const rows = glyphRows(raw, w.canvas.width, glyphs)
    const band = px(subtitleAnchorDecisionFor(anchorPlan, 'cue-y').bounds, w.canvas)
    const overflowPx = Math.max(band.top - glyphs.top, glyphs.bottom - band.bottom)
    console.log(`W70-LAYOUT-3LINE font=${geometry.fontPx} rows=${rows.length} glyphs=${JSON.stringify(glyphs)} band=${JSON.stringify(band)} overflowPx=${overflowPx.toFixed(1)} critic=${JSON.stringify(verification.issues.map((issue) => [issue.code, issue.severity]))}`)
    assert.equal(rows.length, 3, 'the three lines are burned')
    assert.ok(overflowPx > 0 && overflowPx <= 6, `the glyphs leave the band by ${overflowPx.toFixed(1)} px, within the critic's 6 px tolerance`)
    assert.ok(!verification.issues.some((issue) => issue.severity === 'hard'), `the pixel critic alone lets it through: ${JSON.stringify(verification.issues)}`)
    // the layout's verdict blocks the output anyway: the review of this proxy is blocked by CAPTION_TEXT_DOES_NOT_FIT
    const report = critiqueOutputFormat({ outputSpecId: w.spec.id, format: '16:9', proxyHash: delivered.sha256, map: delivered.renderElementMap,
      placementPlanHash: w.plan.placementPlanHash, subtitleAnchorPlan: anchorPlan, captionPixelIssues: verification.issues, captionLayoutOverflows: overflows })
    assert.equal(report.status, 'blocked')
    assert.deepEqual(report.issues.filter((issue) => issue.severity === 'hard').map((issue) => [issue.code, issue.elementIds]), [['CAPTION_TEXT_DOES_NOT_FIT', ['subtitle:cue-y']]])
  } finally { await rm(w.root, { recursive: true, force: true }) }
})
