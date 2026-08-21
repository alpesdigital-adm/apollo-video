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
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { readSubtitlePreset, SUBTITLE_STYLE_REGISTRY } from '../../src/v2/domain/subtitle-system.ts'

/**
 * T-FR-172 — pixel evidence for the tokens F1.035 added to `SubtitleStylePreset`.
 *
 * The 20-golden set (T-FR-170) already proves the five canonical presets render. What it cannot
 * prove is that `casing`, `shadow` and `placement` are *load-bearing*: every canonical preset holds
 * them constant, so a renderer that ignored them would still produce those 20 stills.
 *
 * This file renders the same preset twice — once as authored, once with exactly one new token
 * changed — and measures the difference on the frame. Nothing here reads the function under test
 * for its verdict: the verdict is ink, centroid and halo counted on real Remotion output.
 *
 * The variant tokens travel to the renderer the way FR-172 says they must: inside a
 * content-addressed `presetSnapshot` on a render-input section that names an older registry. That
 * makes this test double as the reproducibility proof — a render input compiled against a registry
 * revision that no longer exists still draws the style it was compiled with.
 */

const RENDER_TIMEOUT_MS = 180_000
const CANVAS = Object.freeze({ '9:16': [540, 960] })
// Two backdrops, each chosen for what it can actually measure. Casing and placement are measured
// on the dark frame, where white glyphs stand out as ink. A BLACK cast shadow is invisible over a
// near-black backdrop — measured, not assumed: on #09111F the shadow-off still was byte-identical
// to the baseline — so the shadow pair is rendered on the light frame, where the penumbra darkens
// pixels the backdrop would otherwise leave bright.
const DARK_BACKGROUND = '#09111F'
const LIGHT_BACKGROUND = '#E8EEF5'
const TEXT = 'Ação com clareza total'

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

const DARK_LUMINANCE = relativeLuminance(0x09, 0x11, 0x1F)
const LIGHT_LUMINANCE = relativeLuminance(0xE8, 0xEE, 0xF5)
// Anything this far from the flat backdrop is painted subtitle material rather than encoder noise.
const INK_DELTA = .05
// A blur penumbra darkens a pixel without reaching the density of the black outline itself.
const PENUMBRA_LOW = .01
const PENUMBRA_HIGH = .5

/**
 * Whole-canvas measurement against the frame's own flat backdrop.
 *
 * - `ink` = pixels that differ from the backdrop enough to be painted material.
 * - `centroidY` = ink-weighted vertical centre of mass, in pixels from the top. This is the
 *   quantity a placement anchor must move.
 * - `penumbra` = pixels *darker* than the backdrop by a small-to-moderate amount: the soft skirt a
 *   cast shadow paints around the glyphs, distinct from the hard black outline.
 */
async function measure(filePath, backdropLuminance) {
  const { data, info } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true })
  let ink = 0, penumbra = 0, weightedY = 0
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * info.channels
    const delta = relativeLuminance(data[offset], data[offset + 1], data[offset + 2]) - backdropLuminance
    if (Math.abs(delta) >= INK_DELTA) {
      ink += 1
      weightedY += Math.floor(index / info.width)
    }
    const darkening = -delta
    if (darkening > PENUMBRA_LOW && darkening < PENUMBRA_HIGH) penumbra += 1
  }
  return { ink, penumbra, centroidY: ink > 0 ? weightedY / ink : null, pixelHash: createHash('sha256').update(data).digest('hex'), width: info.width, height: info.height }
}

/**
 * Pixels that differ between two stills by more than encoder noise. When the two frames were
 * rendered from identical inputs except one token, every differing pixel is that token's doing —
 * which is what makes this a measurement and not an inference.
 */
async function diffPixels(pathA, pathB) {
  const [a, b] = await Promise.all([
    sharp(pathA).raw().toBuffer({ resolveWithObject: true }),
    sharp(pathB).raw().toBuffer({ resolveWithObject: true }),
  ])
  assert.equal(a.info.width * a.info.height, b.info.width * b.info.height)
  let differing = 0
  for (let index = 0; index < a.info.width * a.info.height; index += 1) {
    const offset = index * a.info.channels
    if (Math.abs(a.data[offset] - b.data[offset]) > 4 ||
        Math.abs(a.data[offset + 1] - b.data[offset + 1]) > 4 ||
        Math.abs(a.data[offset + 2] - b.data[offset + 2]) > 4) differing += 1
  }
  return differing
}

/** Re-seals a preset body so its content address matches the edited tokens. */
function sealPreset(preset, patch) {
  const { presetHash, ...body } = { ...preset, ...patch }
  return Object.freeze({ ...body, presetHash: calculateCanonicalHash(body) })
}

/**
 * A render-input subtitle section carrying `tokens`, materialized against `registryHash`. When that
 * hash is not the live registry's, the section is a replay: the renderer must draw from the
 * snapshot, which is precisely how a variant preset reaches the frame here.
 */
function sectionFor(tokens, registryHash) {
  const snapshotBody = {
    schemaVersion: 'subtitle-preset-snapshot/v1', presetId: tokens.id, presetVersion: 1,
    presetHash: tokens.presetHash, registryHash, tokens,
  }
  const snapshot = Object.freeze({ ...snapshotBody, snapshotHash: calculateCanonicalHash(snapshotBody) })
  const body = {
    schemaVersion: 'render-input-subtitles/v3',
    configurationId: 'subtitle-config-token-golden', configurationHash: '4'.repeat(64),
    variantId: '9:16', origin: 'project', enabled: true,
    presetId: tokens.id, presetVersion: 1, presetHash: tokens.presetHash,
    registryHash, presetSnapshot: snapshot, transcriptHash: '5'.repeat(64), cues: Object.freeze([]),
  }
  return Object.freeze({ ...body, sectionHash: calculateCanonicalHash(body) })
}

async function renderStill(directory, { name, tokens, registryHash, background }, videoPath, fontPath) {
  const [width, height] = CANVAS['9:16']
  const [videoStat, fontStat] = await Promise.all([stat(videoPath), stat(fontPath)])
  const input = {
    schemaVersion: 'materialized-render-input/v1', inputHash: '1'.repeat(64),
    renderer: { id: 'remotion', version: '4.0.489', digest: '2'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: `subtitle-token-${name}`, versionId: 'version-token-golden', hash: '3'.repeat(64) },
    output: { id: 'subtitle-9x16', locale: 'pt-BR', aspectRatio: '9:16', width, height, fps: 30, safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, durationInFrames: 30 },
    assets: [
      { id: 'primary-video', artifactId: `video-${background}`, artifactKey: `${background}.mp4`, kind: 'video', role: 'primary', ordinal: 0, sha256: await sha256(videoPath), byteSize: videoStat.size, uri: pathToFileURL(videoPath).href },
      { id: 'font', artifactId: 'font-geist-latin-ext', artifactKey: 'geist-latin-ext.woff2', kind: 'font', role: 'subtitle-font', ordinal: 1, sha256: await sha256(fontPath), byteSize: fontStat.size, uri: pathToFileURL(fontPath).href },
    ],
    props: { primaryVideoAssetId: 'primary-video', fontAssetId: 'font', scenes: [], subtitles: [{ text: TEXT, fromFrame: 0, toFrame: 30, anchor: 'bottom' }], palette: { primary: '#4ECDC4', secondary: '#2457A7', accent: '#FFB800', text: '#FFFFFF', background: background === 'dark' ? DARK_BACKGROUND : LIGHT_BACKGROUND }, subtitleStyle: tokens.id },
  }
  const compiled = compileApolloVideoRenderProps(input, undefined, sectionFor(tokens, registryHash))
  // The renderer receives the SNAPSHOT tokens, not a fresh registry lookup.
  assert.equal(compiled.subtitlePreset.presetHash, tokens.presetHash, `${name} compiled a different preset than the snapshot carried`)
  const outputPath = path.join(directory, `${name}.png`)
  const script = path.join(process.cwd(), 'remotion', 'scripts', 'render-materialized.mjs')
  const request = { schemaVersion: 'apollo-remotion-render-request/v1', renderKind: 'still', outputPath, width, height, fps: 30, durationInFrames: 30, frame: 15, inputProps: compiled }
  await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], { cwd: path.join(process.cwd(), 'remotion'), timeout: RENDER_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(`render failed: ${stderr || error.message}`)) : resolve())
    child.stdin.end(JSON.stringify(request))
  })
  return outputPath
}

test('T-FR-172 casing, shadow and placement tokens are load-bearing on real rendered frames', { timeout: 20 * 60_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `apollo-subtitle-tokens-${randomUUID().slice(0, 8)}-`))
  context.after(() => rm(directory, { recursive: true, force: true }))

  const fontPath = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'next-devtools', 'server', 'font', 'geist-latin-ext.woff2')
  assert.ok((await stat(fontPath)).size > 1_000, 'licensed latin-ext materialized font is unavailable')

  await mkdir(path.join(process.cwd(), 'remotion', 'build'), { recursive: true })
  await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd: path.join(process.cwd(), 'remotion'), timeout: 240_000 })

  const videoPaths = {}
  for (const [name, color] of Object.entries({ dark: DARK_BACKGROUND, light: LIGHT_BACKGROUND })) {
    videoPaths[name] = path.join(directory, `${name}.mp4`)
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=960x960:r=30:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', videoPaths[name]])
  }

  const live = SUBTITLE_STYLE_REGISTRY.registryHash
  // A registry revision that does not exist any more. The baselines below are rendered through the
  // SAME replay path as the variants, so the only difference between a pair is the one token.
  const retired = 'e'.repeat(64)
  const kinetic = readSubtitlePreset('kinetic')
  const shadowless = sealPreset(kinetic, { shadow: { enabled: false, offsetXPx: 0, offsetYPx: 0, blurPx: 0, color: '#000000', opacity: 0 } })

  const cases = [
    { name: 'baseline', background: 'dark', tokens: kinetic, registryHash: retired },
    { name: 'casing-uppercase', background: 'dark', tokens: sealPreset(kinetic, { casing: 'uppercase' }), registryHash: retired },
    { name: 'placement-center', background: 'dark', tokens: sealPreset(kinetic, { placement: { formats: { ...kinetic.placement.formats, '9:16': { ...kinetic.placement.formats['9:16'], anchor: 'center' } } } }), registryHash: retired },
    // Same tokens as `baseline`, but declaring the live registry. Proves the replay path is not a
    // different renderer: an up-to-date section must produce the very same pixels.
    { name: 'live-registry', background: 'dark', tokens: kinetic, registryHash: live },
    // Shadow pair, on the light backdrop where a black penumbra is measurable at all.
    { name: 'light-baseline', background: 'light', tokens: kinetic, registryHash: retired },
    { name: 'light-shadow-off', background: 'light', tokens: shadowless, registryHash: retired },
  ]

  const measured = {}
  const stills = {}
  for (const item of cases) {
    stills[item.name] = await renderStill(directory, item, videoPaths[item.background], fontPath)
    measured[item.name] = await measure(stills[item.name], item.background === 'dark' ? DARK_LUMINANCE : LIGHT_LUMINANCE)
  }
  const shadowDiff = await diffPixels(stills['light-baseline'], stills['light-shadow-off'])

  console.log('T-FR-172 token goldens (540x960, frame 15, flat backdrop per case):')
  for (const [name, item] of Object.entries(measured)) {
    console.log(`  ${name.padEnd(17)} ink=${String(item.ink).padStart(6)} penumbra=${String(item.penumbra).padStart(6)} centroidY=${item.centroidY === null ? '  n/a' : item.centroidY.toFixed(1).padStart(6)}`)
  }

  // (0) Every still is the declared canvas and actually carries painted subtitle material.
  for (const [name, item] of Object.entries(measured)) {
    assert.deepEqual([item.width, item.height], [540, 960], `${name} canvas`)
    assert.ok(item.ink > 500, `${name} painted only ${item.ink} ink pixels — no legible block`)
  }

  // (1) REPRODUCIBILITY — a section naming a retired registry renders byte-identically to the same
  // tokens naming the live one. The snapshot, not the registry lookup, decided the frame.
  assert.equal(measured['live-registry'].pixelHash, measured.baseline.pixelHash,
    'a replayed render input drew different pixels than the same tokens against the live registry')

  // (2) CASING — uppercase is the same string in taller glyphs with no descenders: strictly more
  // ink, and a block that has visibly changed. A renderer ignoring `casing` would tie here.
  assert.notEqual(measured['casing-uppercase'].pixelHash, measured.baseline.pixelHash, 'casing token changed no pixels')
  assert.ok(measured['casing-uppercase'].ink > measured.baseline.ink * 1.05,
    `uppercase ink ${measured['casing-uppercase'].ink} is not measurably above lowercase ${measured.baseline.ink}`)

  // (3) SHADOW — removing the cast shadow removes its penumbra. The glyph bodies stay (ink barely
  // moves) while the soft darkened skirt collapses. Both directions are asserted so a change that
  // merely erased the text could not pass.
  console.log(`T-FR-172 shadow pixel diff (light-baseline vs light-shadow-off): ${shadowDiff} pixels`)
  assert.notEqual(measured['light-shadow-off'].pixelHash, measured['light-baseline'].pixelHash, 'shadow token changed no pixels')
  assert.ok(shadowDiff > 1_000, `disabling the shadow moved only ${shadowDiff} pixels: the shadow token was ignored`)
  assert.ok(measured['light-shadow-off'].penumbra < measured['light-baseline'].penumbra,
    `penumbra ${measured['light-shadow-off'].penumbra} did not shrink against ${measured['light-baseline'].penumbra}`)
  assert.ok(Math.abs(measured['light-shadow-off'].ink - measured['light-baseline'].ink) < measured['light-baseline'].ink * .05,
    'disabling the shadow must not repaint the glyph bodies')

  // (4) PLACEMENT — a `center` anchor lifts the block's centre of mass by hundreds of rows. The
  // domain resolves bottomPx 230→892 at reference height 1920, i.e. ~331 px at this 960 px canvas.
  assert.notEqual(measured['placement-center'].pixelHash, measured.baseline.pixelHash, 'placement token changed no pixels')
  const lift = measured.baseline.centroidY - measured['placement-center'].centroidY
  console.log(`T-FR-172 placement lift: baseline centroidY=${measured.baseline.centroidY.toFixed(1)} center centroidY=${measured['placement-center'].centroidY.toFixed(1)} lift=${lift.toFixed(1)}px`)
  assert.ok(lift > 250, `center anchor lifted the block only ${lift.toFixed(1)}px`)
  assert.ok(lift < 420, `center anchor lifted the block ${lift.toFixed(1)}px — further than the resolved geometry allows`)
  // Ink is conserved: the block moved, it was not resized or dropped.
  assert.ok(Math.abs(measured['placement-center'].ink - measured.baseline.ink) < measured.baseline.ink * .15,
    'a placement change must move the block, not repaint it')

  // (5) Every token state is its own frame — five distinct stills across the two backdrops.
  assert.equal(new Set(['baseline', 'casing-uppercase', 'placement-center', 'light-baseline', 'light-shadow-off'].map((name) => measured[name].pixelHash)).size, 5)
})
