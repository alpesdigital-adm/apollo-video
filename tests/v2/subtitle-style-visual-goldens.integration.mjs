import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import sharp from 'sharp'

import { compileApolloVideoRenderProps } from '../../src/v2/application/compile-apollo-video-render-props.ts'
import { SUBTITLE_STYLE_REGISTRY } from '../../src/v2/domain/subtitle-system.ts'

// Canonical proxy dimensions of the two MVP formats (docs/output-format-registry). The registry
// authors fontPx at referenceHeight, so a proxy render is an honest optical reduction of delivery.
const formats = Object.freeze({ '9:16': [540, 960], '16:9': [960, 540] })
const backgrounds = Object.freeze({ light: '#E8EEF5', dark: '#09111F' })

// Same character count in both strings, so line breaking, chunking and advance widths are held
// constant: the ONLY pixel difference between them is the ink of the latin-ext diacritics.
const LATIN_EXT_TEXT = 'AÇÃO, CORAÇÃO E ÊXITO COM CLAREZA'
const ASCII_FOLDED_TEXT = 'ACAO, CORACAO E EXITO COM CLAREZA'

const RENDER_TIMEOUT_MS = 180_000
const MIN_CONTRAST_RATIO = 4.5

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, timeout: options.timeout ?? RENDER_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${command} failed: ${stderr || error.message}`)) : resolve({ stdout, stderr }))
  })
}

const sha256 = async (filePath) => createHash('sha256').update(await readFile(filePath)).digest('hex')

const relativeLuminance = (r, g, b) => {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  })
  return .2126 * rl + .7152 * gl + .0722 * bl
}

const contrastRatio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05)

const BAND_TOP_FRACTION = .5
// A subtitle glyph body covers thousands of pixels; the composition's own background gradient
// spreads thinly across many buckets and never reaches this population in a single one. The floor
// is therefore what separates a real painted glyph population from gradient/antialiasing noise.
const GLYPH_POPULATION_FLOOR = 150

async function bandOf(filePath, width, height) {
  const top = Math.floor(height * BAND_TOP_FRACTION)
  return sharp(filePath)
    .extract({ left: 0, top, width, height: height - top })
    .raw().toBuffer({ resolveWithObject: true })
}

/**
 * Inspects the lower half of the still — where every preset anchors its block. The composition
 * paints a full-canvas gradient behind the subtitle, so percentile statistics over the band are
 * dominated by the backdrop; what identifies the subtitle is the pair of dense luminance
 * populations it paints (glyph fill, and its outline or opaque container).
 */
function measureBand({ data, info }) {
  const channels = info.channels
  const pixels = info.width * info.height
  const histogram = new Array(256).fill(0)
  const luminances = new Float64Array(pixels)
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * channels
    const luminance = relativeLuminance(data[offset], data[offset + 1], data[offset + 2])
    luminances[index] = luminance
    histogram[Math.min(255, Math.floor(luminance * 256))] += 1
  }
  const backdropBucket = histogram.reduce((best, count, bucket) => count > histogram[best] ? bucket : best, 0)
  const backdropLuminance = (backdropBucket + .5) / 256
  let inkPixels = 0
  for (let index = 0; index < pixels; index += 1) {
    if (Math.abs(luminances[index] - backdropLuminance) > .06) inkPixels += 1
  }
  const dense = histogram
    .map((count, bucket) => ({ count, luminance: (bucket + .5) / 256 }))
    .filter((entry) => entry.count >= GLYPH_POPULATION_FLOOR)
  const darkest = dense.length ? dense[0].luminance : null
  const lightest = dense.length ? dense[dense.length - 1].luminance : null
  return {
    bandPixels: pixels,
    inkPixels,
    inkRatio: inkPixels / pixels,
    backdropLuminance,
    darkest,
    lightest,
    densePopulations: dense.length,
    contrast: dense.length < 2 ? 0 : contrastRatio(lightest, darkest),
    pixelHash: createHash('sha256').update(data).digest('hex'),
  }
}

/** Pixels that differ between two renders of the identical frame — the literal pixel diff. */
function differingPixels(a, b) {
  assert.equal(a.data.length, b.data.length, 'bands must be comparable')
  const channels = a.info.channels
  const pixels = a.info.width * a.info.height
  let differing = 0
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * channels
    if (Math.abs(a.data[offset] - b.data[offset]) > 8 ||
        Math.abs(a.data[offset + 1] - b.data[offset + 1]) > 8 ||
        Math.abs(a.data[offset + 2] - b.data[offset + 2]) > 8) differing += 1
  }
  return differing
}

async function renderStill(directory, { presetId, format, background, text, tag }, videoPath, fontPath) {
  const [width, height] = formats[format]
  const [videoStat, fontStat] = await Promise.all([stat(videoPath), stat(fontPath)])
  const input = {
    schemaVersion: 'materialized-render-input/v1', inputHash: '1'.repeat(64),
    renderer: { id: 'remotion', version: '4.0.489', digest: '2'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: `subtitle-${presetId}-${format}-${background}`, versionId: 'version-subtitle-golden', hash: '3'.repeat(64) },
    output: { id: `subtitle-${format}`, locale: 'pt-BR', aspectRatio: format, width, height, fps: 30, safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, durationInFrames: 30 },
    assets: [
      { id: 'primary-video', artifactId: `video-${background}`, artifactKey: `${background}.mp4`, kind: 'video', role: 'primary', ordinal: 0, sha256: await sha256(videoPath), byteSize: videoStat.size, uri: pathToFileURL(videoPath).href },
      { id: 'font', artifactId: 'font-geist-latin-ext', artifactKey: 'geist-latin-ext.woff2', kind: 'font', role: 'subtitle-font', ordinal: 1, sha256: await sha256(fontPath), byteSize: fontStat.size, uri: pathToFileURL(fontPath).href },
    ],
    props: { primaryVideoAssetId: 'primary-video', fontAssetId: 'font', scenes: [], subtitles: [{ text, fromFrame: 0, toFrame: 30, anchor: 'bottom' }], palette: { primary: '#4ECDC4', secondary: '#2457A7', accent: '#FFB800', text: '#FFFFFF', background: backgrounds[background] }, subtitleStyle: presetId },
  }
  const compiled = compileApolloVideoRenderProps(input)
  // The compiler — never the canvas — decides which authored format the renderer must use.
  assert.equal(compiled.subtitleFormat, format)
  assert.equal(compiled.subtitlePreset.id, presetId)
  const outputPath = path.join(directory, `${presetId}-${format.replace(':', 'x')}-${background}-${tag}.png`)
  const script = path.join(process.cwd(), 'remotion', 'scripts', 'render-materialized.mjs')
  const request = { schemaVersion: 'apollo-remotion-render-request/v1', renderKind: 'still', outputPath, width, height, fps: 30, durationInFrames: 30, frame: 15, inputProps: compiled }
  await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], { cwd: path.join(process.cwd(), 'remotion'), timeout: RENDER_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(`render failed: ${stderr || error.message}`)) : resolve())
    child.stdin.end(JSON.stringify(request))
  })
  return outputPath
}

test('T-FR-170 renders and inspects 20 real Remotion subtitle goldens', { timeout: 20 * 60_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `apollo-subtitle-goldens-${randomUUID().slice(0, 8)}-`))
  context.after(() => rm(directory, { recursive: true, force: true }))

  // Geist is published under the SIL Open Font License 1.1 — the same licence every preset in the
  // registry declares — and this is its latin-ext subset, which carries ã/ç/é.
  const fontPath = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'next-devtools', 'server', 'font', 'geist-latin-ext.woff2')
  assert.ok((await stat(fontPath)).size > 1_000, 'licensed latin-ext materialized font is unavailable')
  for (const preset of Object.values(SUBTITLE_STYLE_REGISTRY.presets)) {
    assert.equal(preset.typography.licenseSpdx, 'OFL-1.1')
    assert.equal(preset.typography.glyphCoverage, 'latin-ext')
  }

  await mkdir(path.join(process.cwd(), 'remotion', 'build'), { recursive: true })
  await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd: path.join(process.cwd(), 'remotion'), timeout: 240_000 })

  const videoPaths = {}
  for (const [name, color] of Object.entries(backgrounds)) {
    const filePath = path.join(directory, `${name}.mp4`)
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=960x960:r=30:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', filePath])
    videoPaths[name] = filePath
  }

  const presetIds = Object.keys(SUBTITLE_STYLE_REGISTRY.presets)
  assert.deepEqual(presetIds, ['kinetic', 'karaoke-box', 'karaoke-pill', 'caps-stroke', 'clean-color'])

  // ---- measure everything first, report, then assert, so one run yields every number ----
  const goldens = []
  for (const presetId of presetIds) for (const format of Object.keys(formats)) for (const background of Object.keys(backgrounds)) {
    const [width, height] = formats[format]
    const outputPath = await renderStill(directory, { presetId, format, background, text: LATIN_EXT_TEXT, tag: 'latin-ext' }, videoPaths[background], fontPath)
    const metadata = await sharp(outputPath).metadata()
    const band = await bandOf(outputPath, width, height)
    goldens.push({ presetId, format, background, width, height, metadata, ...measureBand(band), outputPath })
  }

  const glyphEvidence = []
  for (const presetId of presetIds) for (const format of Object.keys(formats)) {
    const [width, height] = formats[format]
    const controlPath = await renderStill(directory, { presetId, format, background: 'dark', text: ASCII_FOLDED_TEXT, tag: 'ascii' }, videoPaths.dark, fontPath)
    const accented = goldens.find((item) => item.presetId === presetId && item.format === format && item.background === 'dark')
    const [accentedBand, foldedBand] = await Promise.all([bandOf(accented.outputPath, width, height), bandOf(controlPath, width, height)])
    const folded = measureBand(foldedBand)
    glyphEvidence.push({
      presetId, format,
      diffPixels: differingPixels(accentedBand, foldedBand),
      bandPixels: accented.bandPixels,
      accentedInk: accented.inkPixels,
      foldedInk: folded.inkPixels,
      foldedHash: folded.pixelHash,
      accentedHash: accented.pixelHash,
    })
  }

  console.log('T-FR-170 golden measurements (20 goldens, band = lower half of the canvas):')
  for (const item of goldens) {
    console.log(`  ${item.presetId.padEnd(13)} ${item.format.padEnd(5)} ${item.background.padEnd(5)} ${item.metadata.width}x${item.metadata.height} ink=${String(item.inkPixels).padStart(6)} ratio=${item.inkRatio.toFixed(4)} dark=${(item.darkest ?? -1).toFixed(3)} light=${(item.lightest ?? -1).toFixed(3)} contrast=${item.contrast.toFixed(2)} hash=${item.pixelHash.slice(0, 12)}`)
  }
  console.log('T-FR-170 latin-ext pixel diff (accented vs ASCII-folded control, identical layout, dark):')
  for (const item of glyphEvidence) {
    console.log(`  ${item.presetId.padEnd(13)} ${item.format.padEnd(5)} diffPixels=${String(item.diffPixels).padStart(6)} (${(item.diffPixels / item.bandPixels * 100).toFixed(3)}% of band) accentedInk=${item.accentedInk} foldedInk=${item.foldedInk}`)
  }
  const contrasts = goldens.map((item) => item.contrast)
  console.log(`T-FR-170 contrast over 20 goldens: min=${Math.min(...contrasts).toFixed(2)} max=${Math.max(...contrasts).toFixed(2)}`)

  // (1) DIMENSIONS — every still is exactly the declared MVP canvas.
  for (const item of goldens) {
    assert.deepEqual([item.metadata.width, item.metadata.height], [item.width, item.height], `${item.presetId}/${item.format}/${item.background} canvas`)
  }

  // (2) PIXELS — the subtitle band actually carries ink.
  for (const item of goldens) {
    assert.ok(item.inkPixels > 0, `${item.presetId}/${item.format}/${item.background} rendered no subtitle pixels`)
    assert.ok(item.inkRatio > .002, `${item.presetId}/${item.format}/${item.background} ink ratio ${item.inkRatio.toFixed(5)} is too low to be a legible block`)
  }

  // (3) CONTRAST — the block paints a dense light population and a dense dark population separated
  // by at least WCAG AA, so it reads over this frame instead of depending on dark footage.
  for (const item of goldens) {
    assert.ok(item.densePopulations >= 2, `${item.presetId}/${item.format}/${item.background} paints no glyph population pair`)
    assert.ok(item.contrast >= MIN_CONTRAST_RATIO, `${item.presetId}/${item.format}/${item.background} contrast ${item.contrast.toFixed(2)} < ${MIN_CONTRAST_RATIO}`)
  }

  // (4) LATIN-EXT GLYPHS — pixel diff against absence. The ASCII-folded control has the same
  // character count and word count, so layout, chunking and advances are held constant and the
  // differing pixels can only be the ink of the ã/ç/Ê diacritics themselves.
  assert.equal(glyphEvidence.length, 10)
  for (const item of glyphEvidence) {
    assert.notEqual(item.accentedHash, item.foldedHash, `${item.presetId}/${item.format} diacritics produced no pixel difference`)
    assert.ok(item.diffPixels > 0, `${item.presetId}/${item.format} diacritics rendered zero pixels`)
    assert.ok(item.accentedInk > item.foldedInk, `${item.presetId}/${item.format} accented ink ${item.accentedInk} <= folded ${item.foldedInk}: diacritics were dropped`)
    // Bounded: accent marks are small marks over existing letters. A missing glyph would rasterize
    // as a .notdef box replacing the whole letter and would move far more of the band.
    assert.ok(item.diffPixels < item.bandPixels * .02, `${item.presetId}/${item.format} diff ${item.diffPixels} looks like replaced glyphs, not diacritics`)
  }

  // (5) DISTINCT PIXELS — 20 unique goldens, and within each format/background the five presets
  // are pairwise distinct, so distinctness comes from the presets and not merely from the canvas.
  assert.equal(goldens.length, 20)
  assert.equal(new Set(goldens.map((item) => `${item.presetId}:${item.format}:${item.background}`)).size, 20)
  assert.equal(new Set(goldens.map((item) => item.pixelHash)).size, 20, 'every golden must produce distinct pixels')
  for (const format of Object.keys(formats)) for (const background of Object.keys(backgrounds)) {
    const group = goldens.filter((item) => item.format === format && item.background === background)
    assert.equal(new Set(group.map((item) => item.pixelHash)).size, 5, `${format}/${background} presets collapsed onto shared pixels`)
  }
})
