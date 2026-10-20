#!/usr/bin/env node
/**
 * W63b independent label generator.
 *
 *   node scripts/validation/w63b-generate-corpus.mjs --split development|evaluation --out <dir> [--only id,id] [--allow-overwrite]
 *   env: FFMPEG_BIN (absolute), FFPROBE_PATH (absolute), W63B_FONT (absolute path of an OFL font; default Geist from next/og)
 *
 * It builds controlled clips with FFmpeg (lavfi color, looped textures, crop, xfade, concat, overlay, drawtext, aevalsrc) and writes
 * the labels as DATA from its own parameters (w63b-corpus-spec.mjs). It never runs a product producer and never reads one's output.
 * After rendering, each clip is checked against its OWN labels with separate code (cut/ramp timing, pan displacement, text ink,
 * audio bursts); a clip whose labels do not hold is a generator bug and aborts the run.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { buildCorpusSpec, canonicalSha256, CORPUS_SPEC_VERSION, GRID_QUANTUM_PX, sha256Hex, THEMES, VIDEO } from './w63b-corpus-spec.mjs'
import { insertRgb, textureRgb } from './w63b-corpus-textures.mjs'

const exec = promisify(execFile)
const here = fileURLToPath(new URL('.', import.meta.url))
const W = VIDEO.width
const H = VIDEO.height

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function sha256File(path) { return sha256Hex(await readFile(path)) }

async function run(binary, args, options = {}) {
  try {
    const { stdout } = await exec(binary, args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 900_000, ...options })
    return stdout
  } catch (error) {
    throw new Error(`${binary} ${args.slice(0, 6).join(' ')} ... failed: ${String(error.stderr ?? error.message).slice(-1500)}`)
  }
}

function collect(binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolvePromise(Buffer.concat(chunks)) : reject(new Error(`${binary} exited ${code}: ${stderr}`)))
  })
}

// ---------------------------------------------------------------------------------------------------------------- text ink

const ink = { ffmpeg: '', font: '', work: '' }
const sizeCache = new Map()

async function inkBox({ text, fontSize, x, y }) {
  const name = `ink-${sha256Hex(`${text}|${fontSize}|${x}|${y}`).slice(0, 12)}`
  await writeFile(join(ink.work, `${name}.txt`), text, 'utf8')
  await run(ink.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=1`,
    '-vf', `drawtext=fontfile=font.ttf:textfile=${name}.txt:fontsize=${fontSize}:fontcolor=white:expansion=none:x=${x}:y=${y}`,
    '-frames:v', '1', `${name}.png`], { cwd: ink.work })
  const { data, info } = await sharp(join(ink.work, `${name}.png`)).greyscale().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1
  for (let row = 0; row < info.height; row += 1) {
    for (let column = 0; column < info.width; column += 1) {
      if (data[row * info.width + column] >= 48) {
        if (column < minX) minX = column
        if (column > maxX) maxX = column
        if (row < minY) minY = row
        if (row > maxY) maxY = row
      }
    }
  }
  if (maxX < 0) throw new Error(`text "${text}" rendered no ink`)
  return [minX, minY, maxX - minX + 1, maxY - minY + 1]
}

/** The font size whose capital "H" has the requested ink height (+-1 px); the measured value is recorded. */
async function fontSizeFor(capHeightPx) {
  if (sizeCache.has(capHeightPx)) return sizeCache.get(capHeightPx)
  const probe = await inkBox({ text: 'H', fontSize: 100, x: 100, y: 100 })
  const ratio = probe[3] / 100
  let best = null
  for (const candidate of [Math.round(capHeightPx / ratio) - 1, Math.round(capHeightPx / ratio), Math.round(capHeightPx / ratio) + 1]) {
    const box = await inkBox({ text: 'H', fontSize: candidate, x: 100, y: 100 })
    const error = Math.abs(box[3] - capHeightPx)
    if (!best || error < best.error) best = { fontSize: candidate, measuredCapHeightPx: box[3], error }
  }
  if (best.error > 1) throw new Error(`cannot hit cap height ${capHeightPx}: got ${best.measuredCapHeightPx}`)
  sizeCache.set(capHeightPx, best)
  return best
}

// ---------------------------------------------------------------------------------------------------------------- rendering

const textureFiles = new Map()
async function texturePng(work, { seed, width, height, bias, chroma }) {
  const key = `tex-${seed}-${width}x${height}-${bias}-${chroma ?? 'd'}.png`
  if (textureFiles.has(key) && existsSync(join(work, key))) return key
  const rgb = textureRgb({ seed, width, height, bias, ...(chroma === undefined ? {} : { chroma }) })
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 3 }).toFile(join(work, key))
  textureFiles.set(key, true)
  return key
}

async function insertPng(work, { seed, width, height }) {
  const key = `ins-${seed}-${width}x${height}.png`
  await sharp(insertRgb({ seed, width, height }), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 3 }).toFile(join(work, key))
  return key
}

const FACE_SVG = (mouthOpen) => `<svg width="500" height="620" xmlns="http://www.w3.org/2000/svg">
<ellipse cx="250" cy="320" rx="220" ry="290" fill="#E0B090"/>
<ellipse cx="170" cy="250" rx="42" ry="26" fill="#FFFFFF"/><ellipse cx="330" cy="250" rx="42" ry="26" fill="#FFFFFF"/>
<circle cx="172" cy="252" r="15" fill="#2A1A10"/><circle cx="328" cy="252" r="15" fill="#2A1A10"/>
<rect x="126" y="196" width="88" height="10" fill="#4A3020"/><rect x="286" y="196" width="88" height="10" fill="#4A3020"/>
<rect x="244" y="270" width="12" height="110" fill="#C08A68"/>
${mouthOpen ? '<ellipse cx="250" cy="470" rx="70" ry="42" fill="#7A1F2B"/>' : '<rect x="180" y="462" width="140" height="14" rx="7" fill="#7A1F2B"/>'}
</svg>`

async function headPngs(work) {
  const files = []
  for (const open of [false, true]) {
    const name = `head-${open ? 'open' : 'closed'}.png`
    await sharp(Buffer.from(FACE_SVG(open))).png().toFile(join(work, name))
    files.push(name)
  }
  const { data, info } = await sharp(join(work, 'head-closed.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1
  for (let row = 0; row < info.height; row += 1) {
    for (let column = 0; column < info.width; column += 1) {
      if (data[(row * info.width + column) * 4 + 3] > 128) {
        minX = Math.min(minX, column); maxX = Math.max(maxX, column); minY = Math.min(minY, row); maxY = Math.max(maxY, row)
      }
    }
  }
  return { files, alphaBox: [minX, minY, maxX - minX + 1, maxY - minY + 1] }
}

const q = (value) => `'${value}'`

function panWindow(scene, extraStart = 0) {
  const motion = scene.pan ?? (scene.drift ? { startFrame: 0, ...scene.drift } : null)
  if (!motion) return null
  const moving = scene.frames - motion.startFrame
  return { motion, moving, width: W + Math.abs(motion.dxPxPerFrame) * moving, height: H + Math.abs(motion.dyPxPerFrame) * moving, extraStart }
}

async function sceneInput(work, scene, index, inputs) {
  const filters = []
  const label = `s${index}`
  const window = panWindow(scene)
  if (scene.type === 'flat') {
    inputs.push('-f', 'lavfi', '-i', `color=c=${scene.color}:s=${W}x${H}:r=${VIDEO.fps}`)
    filters.push(`[${inputs.filter((value) => value === '-i').length - 1}:v]trim=end_frame=${scene.frames},setpts=PTS-STARTPTS,fps=${VIDEO.fps},format=yuv420p,setsar=1[${label}]`)
    return filters
  }
  const width = window ? window.width : W
  const height = window ? window.height : H
  const png = await texturePng(work, { seed: scene.seed, width, height, bias: scene.bias })
  inputs.push('-loop', '1', '-framerate', String(VIDEO.fps), '-i', png)
  const position = inputs.filter((value) => value === '-i').length - 1
  let crop = `crop=${W}:${H}:0:0`
  if (window) {
    const { motion, moving } = window
    const x0 = motion.dxPxPerFrame > 0 ? motion.dxPxPerFrame * moving : 0
    const y0 = motion.dyPxPerFrame > 0 ? motion.dyPxPerFrame * moving : 0
    crop = `crop=${W}:${H}:x=${q(`${x0}-(${motion.dxPxPerFrame})*max(n-${motion.startFrame},0)`)}:y=${q(`${y0}-(${motion.dyPxPerFrame})*max(n-${motion.startFrame},0)`)}`
  }
  filters.push(`[${position}:v]${crop},trim=end_frame=${scene.frames},setpts=PTS-STARTPTS,fps=${VIDEO.fps},format=yuv420p,setsar=1[${label}]`)
  return filters
}

async function renderClip(spec, work, outPath, tools) {
  const inputs = []
  const filters = []
  for (const [index, scene] of spec.scenes.entries()) filters.push(...await sceneInput(work, scene, index, inputs))
  // fold the scenes: a cut is a concat, a crossfade an xfade whose offset is the folded length minus the fade
  let current = 's0'
  let length = spec.scenes[0].frames
  for (let index = 1; index < spec.scenes.length; index += 1) {
    const transition = spec.transitions[index - 1]
    const next = `f${index}`
    if (transition.type === 'cut') {
      filters.push(`[${current}][s${index}]concat=n=2:v=1:a=0[${next}]`)
      length += spec.scenes[index].frames
    } else {
      filters.push(`[${current}][s${index}]xfade=transition=fade:duration=${transition.frames / VIDEO.fps}:offset=${(length - transition.frames) / VIDEO.fps}[${next}]`)
      length += spec.scenes[index].frames - transition.frames
    }
    current = next
  }
  if (length !== spec.frames) throw new Error(`${spec.id}: scene program yields ${length} frames, spec says ${spec.frames}`)
  // overlays
  for (const insert of spec.overlays.inserts) {
    const png = await insertPng(work, { seed: insert.imageSeed, width: insert.boxPx[2], height: insert.boxPx[3] })
    inputs.push('-loop', '1', '-framerate', String(VIDEO.fps), '-i', png)
    const position = inputs.filter((value) => value === '-i').length - 1
    const next = `o${insert.id.replace(/\W/g, '')}`
    filters.push(`[${current}][${position}:v]overlay=x=${insert.boxPx[0]}:y=${insert.boxPx[1]}:enable=${q(`between(n,${insert.startFrame},${insert.endFrame - 1})`)}:eof_action=repeat[${next}]`)
    current = next
  }
  if (spec.overlays.head) {
    const head = spec.overlays.head
    const { files } = await headPngs(work)
    for (const file of files) inputs.push('-loop', '1', '-framerate', String(VIDEO.fps), '-i', file)
    const closed = inputs.filter((value) => value === '-i').length - 2
    const sway = `${head.x}+${head.swayPx}*sin(2*PI*n/${head.swayPeriodFrames})`
    const speaking = spec.audio.intervals.map((interval) => `between(t,${interval.startSec},${interval.endSec})`).join('+') || '0'
    filters.push(`[${current}][${closed}:v]overlay=x=${q(sway)}:y=${head.y}:eval=frame:eof_action=repeat[h1]`)
    filters.push(`[h1][${closed + 1}:v]overlay=x=${q(sway)}:y=${head.y}:eval=frame:eof_action=repeat:enable=${q(`(${speaking})*lt(mod(n,${head.mouthPeriodFrames}),${head.mouthPeriodFrames / 2})`)}[h2]`)
    current = 'h2'
  }
  // text
  const theme = spec.theme ? THEMES[spec.theme] : THEMES.dark
  for (const [index, item] of spec.text.entries()) {
    const file = `t-${item.id}.txt`
    await writeFile(join(work, file), item.text, 'utf8')
    const { fontSize } = await fontSizeFor(item.capHeightPx)
    const next = `t${index}`
    const box = spec.textBox ? ':box=1:boxcolor=0x000000@0.78:boxborderw=14' : ''
    filters.push(`[${current}]drawtext=fontfile=font.ttf:textfile=${file}:fontsize=${fontSize}:fontcolor=${theme.text}:expansion=none:x=${item.x}:y=${item.y}:enable=${q(`between(n,${item.startFrame},${item.endFrame - 1})`)}${box}[${next}]`)
    current = next
  }
  const ptsGap = spec.evaluation.ptsGapAtFrame === undefined ? '' : `,setpts=${q(`PTS+${spec.evaluation.ptsGapSeconds}/TB*gte(N,${spec.evaluation.ptsGapAtFrame})`)}`
  filters.push(`[${current}]format=yuv420p${ptsGap}[vout]`)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', ...inputs]
  const maps = ['-map', '[vout]']
  if (spec.audio) {
    const seconds = spec.frames / VIDEO.fps
    const expression = spec.audio.intervals.map((interval) => `0.3*sin(2*PI*${interval.hz}*t)*between(t,${interval.startSec},${interval.endSec})`).join('+') || '0'
    args.push('-f', 'lavfi', '-i', `aevalsrc=${q(expression)}:s=48000:c=mono:d=${seconds}`)
    maps.push('-map', `${inputs.filter((value) => value === '-i').length}:a`)
  }
  const common = ['-filter_complex', filters.join(';'), ...maps, '-frames:v', String(spec.frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-x264-params', 'threads=1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1']
  if (spec.evaluation.ptsGapAtFrame === undefined) common.push('-r', String(VIDEO.fps), '-fps_mode', 'cfr')
  else common.push('-fps_mode', 'passthrough')
  if (spec.audio) common.push('-c:a', 'aac', '-b:a', '96k', '-flags:a', '+bitexact', '-shortest')
  await run(tools.ffmpeg, [...args, ...common, outPath], { cwd: work })
}

// ---------------------------------------------------------------------------------------------------------------- probing

async function probe(tools, path) {
  const json = JSON.parse(await run(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,nb_read_frames:frame=best_effort_timestamp',
    '-of', 'json', path]))
  const stream = json.streams[0]
  const pts = json.frames.map((frame) => Number(frame.best_effort_timestamp))
  const [num, den] = String(stream.time_base).split('/').map(Number)
  const [fpsNum, fpsDen] = String(stream.r_frame_rate).split('/').map(Number)
  const ticksPerFrame = (fpsDen * den) / (fpsNum * num)
  const cfr = pts.every((value, index) => index === 0 || (value > pts[index - 1] && Math.abs(value - (pts[0] + index * ticksPerFrame)) <= 1))
  const audio = JSON.parse(await run(tools.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', path])).streams
  return { codec: stream.codec_name, width: stream.width, height: stream.height, pixFmt: stream.pix_fmt, rFrameRate: stream.r_frame_rate,
    timeBase: stream.time_base, frames: pts.length, firstPts: pts[0], lastPts: pts.at(-1), ticksPerFrame, cfr, audio }
}

// ---------------------------------------------------------------------------------------------------------------- label checks

const GRID_W = 160
const GRID_H = 90

async function gridFrames(tools, path) {
  const raw = await collect(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `scale=${GRID_W}:${GRID_H}:flags=bicubic,format=gray`, '-fps_mode', 'passthrough', '-an', '-f', 'rawvideo', 'pipe:1'])
  const size = GRID_W * GRID_H
  return Array.from({ length: raw.length / size }, (_, index) => raw.subarray(index * size, (index + 1) * size))
}

const meanAbs = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]); return sum / (a.length * 255) }

async function fullFrames(tools, path, indices) {
  const expression = indices.map((index) => `eq(n\\,${index})`).join('+')
  const raw = await collect(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `select=${expression},format=gray`, '-fps_mode', 'passthrough', '-an', '-f', 'rawvideo', 'pipe:1'])
  const size = W * H
  return indices.map((_, position) => raw.subarray(position * size, (position + 1) * size))
}

function shiftError(previous, current, dx, dy) {
  // mean abs difference of current(x) against previous(x - dx), over an interior region, sampled every 4 px
  let sum = 0
  let count = 0
  for (let y = 100; y < H - 100; y += 4) {
    for (let x = 100; x < W - 100; x += 4) {
      sum += Math.abs(current[y * W + x] - previous[(y - dy) * W + (x - dx)])
      count += 1
    }
  }
  return sum / count
}

async function verifyClip(spec, path, tools, probed) {
  const checks = []
  const fail = (message) => { throw new Error(`${spec.id}: label check failed: ${message}`) }
  if (probed.frames !== spec.frames) fail(`frame count ${probed.frames} != ${spec.frames}`)
  if (spec.evaluation.ptsGapAtFrame === undefined) {
    if (!probed.cfr) fail('clip is not constant frame rate')
    if (probed.rFrameRate !== `${VIDEO.fps}/1`) fail(`r_frame_rate ${probed.rFrameRate}`)
  } else if (probed.cfr) fail('the pts-gap clip is unexpectedly CFR')
  checks.push('frames/cfr')
  if (spec.evaluation.ptsGapAtFrame !== undefined) return checks
  const grids = await gridFrames(tools, path)
  const diffs = grids.slice(1).map((frame, index) => meanAbs(grids[index], frame))
  const localMax = (center, radius) => { let best = center; for (let p = Math.max(0, center - radius); p <= Math.min(diffs.length - 1, center + radius); p += 1) if (diffs[p] > diffs[best]) best = p; return best }
  for (const cut of spec.labels.hardCuts) {
    const pair = cut.frame - 1
    if (localMax(pair, 4) !== pair) fail(`hard cut ${cut.frame}: largest pair near it is ${localMax(pair, 4)}`)
    if (diffs[pair] < 0.1) fail(`hard cut ${cut.frame}: pair score ${diffs[pair].toFixed(3)} below 0.1`)
  }
  if (spec.labels.hardCuts.length) checks.push('hard-cuts')
  for (const fade of spec.labels.crossfades) {
    const length = fade.endFrame - fade.startFrame
    const inside = diffs.slice(fade.startFrame + 1, fade.endFrame - 1)
    const mean = inside.reduce((sum, value) => sum + value, 0) / Math.max(1, inside.length)
    const before = diffs.slice(Math.max(0, fade.startFrame - 6), fade.startFrame - 1)
    const after = diffs.slice(fade.endFrame + 2, fade.endFrame + 8)
    const quiet = Math.max(0, ...before, ...after)
    if (inside.some((value) => value < mean * 0.5 || value > mean * 1.6)) fail(`crossfade ${fade.startFrame}-${fade.endFrame}: ramp is not flat (${inside.map((v) => v.toFixed(3)).join(',')})`)
    if (quiet > mean * 0.6) fail(`crossfade ${fade.startFrame}-${fade.endFrame}: not quiet outside the ramp (${quiet.toFixed(4)} vs ${mean.toFixed(4)})`)
    // the ramp must start and end on the labelled pairs (an off-by-one of the xfade offset would otherwise pass)
    let first = -1
    let last = -1
    for (let p = Math.max(0, fade.startFrame - 4); p <= Math.min(diffs.length - 1, fade.endFrame + 4); p += 1) {
      if (diffs[p] > mean * 0.5) { if (first < 0) first = p; last = p }
    }
    if (first !== fade.startFrame || last !== fade.endFrame - 1) fail(`crossfade ${fade.startFrame}-${fade.endFrame}: measured ramp pairs ${first}..${last}`)
    if (!(length >= 8)) fail('crossfade shorter than 8 frames')
  }
  if (spec.labels.crossfades.length) checks.push('crossfades')
  const movers = spec.labels.motion.filter((segment) => segment.dxPxPerFrame !== 0 || segment.dyPxPerFrame !== 0)
  for (const segment of movers) {
    if (Math.abs(segment.dxPxPerFrame) < GRID_QUANTUM_PX / 2 && Math.abs(segment.dyPxPerFrame) < GRID_QUANTUM_PX / 2) continue
    const pair = Math.floor((segment.startPair + segment.endPair) / 2)
    const [previous, current] = await fullFrames(tools, path, [pair, pair + 1])
    const wanted = shiftError(previous, current, segment.dxPxPerFrame, segment.dyPxPerFrame)
    for (const [dx, dy] of [[0, 0], [segment.dxPxPerFrame + 6, segment.dyPxPerFrame], [segment.dxPxPerFrame - 6, segment.dyPxPerFrame],
      [segment.dxPxPerFrame, segment.dyPxPerFrame + 6], [segment.dxPxPerFrame, segment.dyPxPerFrame - 6]]) {
      if (shiftError(previous, current, dx, dy) <= wanted) fail(`motion ${segment.startPair}-${segment.endPair}: displacement (${dx},${dy}) fits as well as the label`)
    }
    if (wanted > 6) fail(`motion ${segment.startPair}-${segment.endPair}: the labelled displacement does not explain the frames (${wanted.toFixed(2)})`)
  }
  if (movers.length) checks.push('motion-displacement')
  if (spec.text.length) {
    const theme = spec.theme ? THEMES[spec.theme] : THEMES.dark
    const wantBright = theme.inkLuma === 'bright'
    const frames = new Set()
    for (const item of spec.text) for (const frame of [item.startFrame - 1, item.startFrame, item.endFrame - 1, item.endFrame]) if (frame >= 0 && frame < spec.frames) frames.add(frame)
    const ordered = [...frames].sort((a, b) => a - b)
    const decoded = await fullFrames(tools, path, ordered)
    const inkFraction = (frame, box) => {
      const data = decoded[ordered.indexOf(frame)]
      let hits = 0
      let total = 0
      for (let y = box[1]; y < box[1] + box[3]; y += 1) for (let x = box[0]; x < box[0] + box[2]; x += 1) { total += 1; const v = data[y * W + x]; if (wantBright ? v >= (spec.textBox ? 235 : 110) : v <= 170) hits += 1 }
      return hits / total
    }
    for (const item of spec.text) {
      const visible = (frame) => inkFraction(frame, item.boxPx)
      if (visible(item.startFrame) < 0.01) fail(`text ${item.id} shows no ink at its first frame ${item.startFrame}`)
      if (visible(item.endFrame - 1) < 0.01) fail(`text ${item.id} shows no ink at its last frame ${item.endFrame - 1}`)
      if (item.startFrame > 0 && visible(item.startFrame - 1) > 0.002) fail(`text ${item.id} shows ink before ${item.startFrame}`)
      if (item.endFrame < spec.frames && visible(item.endFrame) > 0.002) fail(`text ${item.id} still shows ink at ${item.endFrame}`)
    }
    checks.push('text-ink-ranges')
  }
  for (const insert of spec.labels.inserts) {
    const [before, first, last, after] = await fullFrames(tools, path, [insert.startFrame - 1, insert.startFrame, insert.endFrame - 1, insert.endFrame])
    const region = (a, b, box) => { let sum = 0; let count = 0; for (let y = box[1] + 8; y < box[1] + box[3] - 8; y += 4) for (let x = box[0] + 8; x < box[0] + box[2] - 8; x += 4) { sum += Math.abs(a[y * W + x] - b[y * W + x]); count += 1 } return sum / count }
    if (region(before, first, insert.boxPx) < 12) fail(`insert ${insert.id} does not appear at ${insert.startFrame}`)
    if (region(last, after, insert.boxPx) < 12) fail(`insert ${insert.id} does not vanish at ${insert.endFrame}`)
  }
  if (spec.labels.inserts.length) checks.push('inserts')
  if (spec.labels.audio.length) {
    const raw = await collect(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'])
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)))
    const rms = (from, to) => { let sum = 0; let count = 0; for (let i = Math.floor(from * 8000); i < Math.min(samples.length, Math.floor(to * 8000)); i += 1) { sum += samples[i] * samples[i]; count += 1 } return Math.sqrt(sum / Math.max(1, count)) }
    for (const interval of spec.labels.audio) {
      if (rms(interval.startSec + 0.1, interval.endSec - 0.1) < 0.1) fail(`audio burst ${interval.startSec}-${interval.endSec} is silent`)
    }
    const total = spec.frames / VIDEO.fps
    let cursor = 0
    for (const interval of [...spec.labels.audio, { startSec: total + 1, endSec: total + 1 }]) {
      if (interval.startSec - cursor > 0.4 && rms(cursor + 0.15, interval.startSec - 0.15) > 0.01) fail(`audio is not silent between bursts near ${cursor}`)
      cursor = interval.endSec
    }
    checks.push('audio-bursts')
  }
  if (spec.labels.faces.length) {
    const [first] = await fullFrames(tools, path, [0])
    const face = spec.labels.faces[0].boxPx
    const flatValue = first[20 * W + 20]
    const cx = face[0] + face[2] / 2
    const cy = face[1] + face[3] / 2
    if (Math.abs(first[Math.round(cy) * W + Math.round(cx)] - flatValue) < 25) fail('the face-like shape is not drawn at its labelled box')
    checks.push('face-shape')
  }
  return checks
}

// ---------------------------------------------------------------------------------------------------------------- main

async function main() {
  const split = argument('split')
  const out = argument('out')
  const only = argument('only')?.split(',')
  const tools = { ffmpeg: process.env.FFMPEG_BIN, ffprobe: process.env.FFPROBE_PATH ?? process.env.FFPROBE_BIN }
  if (!split || !out || !isAbsolute(out) || !isAbsolute(tools.ffmpeg ?? '') || !isAbsolute(tools.ffprobe ?? '')) {
    throw new Error('usage: --split <development|evaluation> --out <absolute dir>; FFMPEG_BIN and FFPROBE_PATH must be absolute')
  }
  const fontPath = process.env.W63B_FONT ?? resolve(here, '../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf')
  const manifestPath = join(out, 'manifest.json')
  if (existsSync(manifestPath) && !process.argv.includes('--allow-overwrite')) {
    throw new Error(`${manifestPath} exists; the evaluation corpus is generated once. --allow-overwrite is for the development split only.`)
  }
  if (split === 'evaluation' && process.argv.includes('--allow-overwrite')) throw new Error('the evaluation corpus is never overwritten')
  await mkdir(out, { recursive: true })
  const spec = buildCorpusSpec(split)
  const work = join(out, '_work')
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  await copyFile(fontPath, join(work, 'font.ttf'))
  ink.ffmpeg = tools.ffmpeg
  ink.work = work
  const versionLine = (await run(tools.ffmpeg, ['-version'])).split(/\r?\n/)[0]
  const toolchain = { ffmpegVersion: versionLine, ffmpegSha256: await sha256File(tools.ffmpeg), ffprobeSha256: await sha256File(tools.ffprobe),
    fontSha256: await sha256File(fontPath), fontName: 'Geist-Regular.ttf (SIL Open Font License 1.1, copyright 2024 The Geist Project Authors)',
    node: process.version, sharp: sharp.versions.sharp }
  const entries = []
  for (const clip of spec.clips) {
    if (only && !only.includes(clip.id)) continue
    const started = Date.now()
    const item = structuredClone(clip)
    // text boxes are measured from the generator's own render of each string
    for (const text of item.text) {
      const { fontSize, measuredCapHeightPx } = await fontSizeFor(text.capHeightPx)
      text.fontSize = fontSize
      text.measuredCapHeightPx = measuredCapHeightPx
      text.boxPx = await inkBox({ text: text.text, fontSize, x: text.x, y: text.y })
      if (text.boxPx[0] + text.boxPx[2] > W - 8 || text.boxPx[1] + text.boxPx[3] > H - 8) throw new Error(`${item.id}/${text.id} does not fit the frame`)
      text.box = [text.boxPx[0] / W, text.boxPx[1] / H, text.boxPx[2] / W, text.boxPx[3] / H]
    }
    if (item.overlays.head) {
      const { alphaBox } = await headPngs(work)
      const head = item.overlays.head
      item.labels.faces[0].boxPx = [head.x + alphaBox[0] - head.swayPx, head.y + alphaBox[1], alphaBox[2] + 2 * head.swayPx, alphaBox[3]]
    }
    const file = `${item.id}.mp4`
    const outPath = join(out, file)
    await renderClip(item, work, outPath, tools)
    const probed = await probe(tools, outPath)
    const checks = await verifyClip(item, outPath, tools, probed)
    const bytes = (await stat(outPath)).size
    entries.push({ id: item.id, stratum: item.stratum, file, sha256: await sha256File(outPath), bytes, video: probed, labelChecks: checks,
      spec: item, renderSeconds: Number(((Date.now() - started) / 1000).toFixed(1)) })
    console.log(JSON.stringify({ event: 'clip', id: item.id, bytes, seconds: entries.at(-1).renderSeconds, checks }))
  }
  await rm(work, { recursive: true, force: true })
  const manifest = { schemaVersion: 'w63b-corpus-manifest/v1', specVersion: CORPUS_SPEC_VERSION, split, createdAtNote: 'no wall-clock time is recorded: the manifest is a function of the generator and its pinned tools',
    video: VIDEO, ocrSampleIntervalFrames: spec.ocrSampleIntervalFrames, gridQuantumPx: GRID_QUANTUM_PX, toolchain,
    generator: { specSha256: await sha256File(join(here, 'w63b-corpus-spec.mjs')), texturesSha256: await sha256File(join(here, 'w63b-corpus-textures.mjs')),
      generatorSha256: await sha256File(fileURLToPath(import.meta.url)) },
    specSha256: canonicalSha256({ specVersion: spec.specVersion, split, clips: spec.clips }), unrun: spec.unrun, clips: entries }
  if (only) manifest.partial = only
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestPath, text)
  const manifestSha256 = sha256Hex(Buffer.from(text))
  await writeFile(join(out, 'manifest.sha256'), `${manifestSha256}  manifest.json\n`)
  console.log(JSON.stringify({ event: 'manifest', split, clips: entries.length, manifestSha256 }))
}

main().catch((error) => { console.error(error.stack ?? error); process.exit(1) })
