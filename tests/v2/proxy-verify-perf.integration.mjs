import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'

import { faceRectOf } from './w67/corpus-geometry.mjs'
import { criticRequest, encodeSource, outputSpecOf, planOutput, presetBands, renderOutput } from './w67/render-world.mjs'

const { FfmpegMp4PixelCritic, selectExpression } = await import('../../src/v2/infrastructure/media/ffmpeg-mp4-pixel-critic.ts')
const { FfmpegEditorialProxyRenderer } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')
const { FfmpegColorPipelineProcessor } = await import('../../src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts')

/**
 * Proxy verification performance: the same measurements with fewer ffmpeg passes.
 *  - source frames come from ONE decoding pass (not one pass per 48 frames) and are byte-identical to what the 48-frame passes produced;
 *  - each source is colour-normalized once per operation, and the control renders read the very file the first render wrote.
 */
const require = createRequire(import.meta.url)
const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
const execFileAsync = promisify(execFile)
const SOURCE = Object.freeze({ width: 1024, height: 768 })
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sha256File = async (path) => sha(await readFile(path))

let root, sourcePath
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'apollo-proxy-verify-perf-'))
  sourcePath = encodeSource({
    ffmpegPath, outPath: join(root, 'source.mp4'), lavfiVideo: `mandelbrot=size=${SOURCE.width}x${SOURCE.height}:rate=30:end_scale=3`,
  }).path
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

/** The extraction this change replaced, verbatim: blocks of 48 frames, one `select` pass over the file for each block. */
async function referenceFrames(path, frames, width, height) {
  const frameBytes = width * height * 3
  const out = []
  let passes = 0
  for (let offset = 0; offset < frames.length; offset += 48) {
    const chunk = frames.slice(offset, offset + 48)
    const select = chunk.map((frame) => `eq(n\\,${frame})`).join('+')
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-v', 'error', '-i', path, '-map', '0:v:0', '-vf', `select=${select}`, '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: frameBytes * chunk.length + 4096, windowsHide: true })
    passes += 1
    assert.equal(stdout.byteLength, frameBytes * chunk.length)
    const ordered = [...chunk.entries()].toSorted((left, right) => left[1] - right[1])
    const byFrame = new Map(ordered.map(([, frame], position) => [frame, Buffer.from(stdout.subarray(position * frameBytes, (position + 1) * frameBytes))]))
    for (const frame of chunk) out.push(byFrame.get(frame))
  }
  return { out, passes }
}

test('select expression: isolated frames use eq, runs of three or more use between, and the order is kept', () => {
  assert.equal(selectExpression([0]), 'select=eq(n\\,0)')
  assert.equal(selectExpression([2, 3]), 'select=eq(n\\,2)+eq(n\\,3)')
  assert.equal(selectExpression([1, 5, 6, 7, 8, 20]), 'select=eq(n\\,1)+between(n\\,5\\,8)+eq(n\\,20)')
  assert.throws(() => selectExpression([-1]))
})

test('source frames: one decoding pass returns the very bytes (and order) the 48-frame passes returned', { timeout: 5 * 60_000 }, async () => {
  const frames = [0, 1, 2, 3, 4, 9, 10, 11, 12, 17, 23, ...Array.from({ length: 40 }, (_unused, index) => 30 + index), 71, 72, 88, 89]
  assert.ok(frames.length > 48, 'the request spans more than one 48-frame block')
  const reference = await referenceFrames(sourcePath, frames, SOURCE.width, SOURCE.height)
  assert.equal(reference.passes, 2)
  const spawns = []
  const critic = new FfmpegMp4PixelCritic({ oracle: { models: [], analyze: async () => { throw new Error('unused') } }, workRoot: join(root, 'critic'), ffmpegPath, onFfmpegSpawn: (args) => spawns.push(args) })
  const decoders = []
  await mkdir(join(root, 'scripts'), { recursive: true })
  const produced = []
  for await (const frame of critic.selectedFrames(sourcePath, frames, SOURCE.width, SOURCE.height, join(root, 'scripts', 'select.txt'), decoders)) produced.push(sha(frame))
  assert.equal(spawns.length, 1, 'ONE ffmpeg pass for the whole request')
  assert.deepEqual(produced, reference.out.map(sha), 'every frame hash, in request order, equals the 48-frame passes')
  assert.equal((await stat(join(root, 'scripts', 'select.txt'))).isFile(), true)
})

test('source frames: a request beyond the end of the file is refused, never returned short', { timeout: 120_000 }, async () => {
  const critic = new FfmpegMp4PixelCritic({ oracle: { models: [], analyze: async () => { throw new Error('unused') } }, workRoot: join(root, 'critic'), ffmpegPath })
  await assert.rejects(async () => {
    for await (const unused of critic.selectedFrames(sourcePath, [5, 10_000], SOURCE.width, SOURCE.height, join(root, 'scripts-short.txt'), [])) void unused
  }, /could not decode every requested frame/)
})

test('verify: no file is decoded by more than one selection pass, and the sources go to disk in one pass', { timeout: 10 * 60_000 }, async () => {
  const bands = await presetBands('9:16', SOURCE)
  const face = faceRectOf({ XMin: 0.46, YMin: 0.34, XMax: 0.56, YMax: 0.5 })
  const spec = outputSpecOf({ imageId: 'synthetic', format: '9:16', variant: 'caption', face, source: SOURCE, bands })
  const planned = await planOutput(spec, bands)
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work-verify'), ffmpegPath })
  const render = (kind) => renderOutput({ renderer, spec, planned, sourcePath, kind })
  const delivered = await render('delivered')
  const blind = { models: [], async analyze({ frames }) {
    return { receipt: { protocol: 'apollo-pixel-oracle/v1', bridgeSha256: 'b'.repeat(64), pythonSha256: 'c'.repeat(64), runtime: {} },
      frames: frames.map((frame) => ({ id: frame.id, sha256: 'f'.repeat(64), status: 'error', reason: 'BLIND', width: null, height: null, readings: [] })), registrations: [] }
  } }
  for (const [label, sampling] of [['all frames', undefined], ['stride with edges', { allFramesUpTo: 20, strideFrames: 7 }]]) {
    const spawns = []
    const critic = new FfmpegMp4PixelCritic({ oracle: blind, workRoot: join(root, `critic-${label}`), ffmpegPath, ...(sampling ? { sampling } : {}), onFfmpegSpawn: (args) => spawns.push(args) })
    const verification = await critic.verify(criticRequest({
      spec, deliveredPath: delivered.outputPath, sourcePath, sourceSha256: await sha256File(sourcePath), renderInputHash: 'd'.repeat(64),
      renderControl: async (kind) => ({ path: (await render(kind)).outputPath }),
    }))
    assert.equal(verification.report.decode.status, 'complete', label)
    const selections = spawns.filter((args) => args.includes('-filter_script:v'))
    const perFile = new Map()
    for (const args of selections) perFile.set(args[args.indexOf('-i') + 1], (perFile.get(args[args.indexOf('-i') + 1]) ?? 0) + 1)
    assert.ok([...perFile.values()].every((count) => count === 1), `${label}: each file is selected from in one pass (${JSON.stringify([...perFile.values()])})`)
    assert.equal(perFile.get(sourcePath), 1, `${label}: the source is read once for every sampled frame`)
    assert.equal(spawns.length - selections.length, 4, `${label}: the lockstep pass is still delivered + three controls`)
  }
})

/** A processor that counts and records what it was asked to produce, delegating to the real one. */
function countingProcessor() {
  const real = new FfmpegColorPipelineProcessor({ ffmpegPath })
  const calls = []
  return { calls, process: async (input) => { const result = await real.process(input); calls.push({ sourcePath: input.sourcePath, outputPath: input.outputPath, sha256: result.sha256 }); return result } }
}

async function normalizationWorld(name, processor = countingProcessor()) {
  const bands = await presetBands('9:16', SOURCE)
  const face = faceRectOf({ XMin: 0.46, YMin: 0.34, XMax: 0.56, YMax: 0.5 })
  const spec = outputSpecOf({ imageId: 'synthetic', format: '9:16', variant: 'combined', face, source: SOURCE, bands })
  const planned = await planOutput(spec, bands)
  const real = new FfmpegEditorialProxyRenderer({ workRoot: join(root, name), ffmpegPath, colorProcessor: processor })
  const scoped = (scope) => ({ render: (input) => real.render({ ...input, ...(scope ? { normalizationScopeId: scope } : {}) }), cleanup: (id) => real.cleanup(id) })
  const render = (renderer, kind) => renderOutput({ renderer, spec, planned, sourcePath, kind })
  return { processor, real, scoped, render }
}

test('normalization: the delivered render and its three controls normalize the master ONCE, and every render reads identical bytes', { timeout: 10 * 60_000 }, async () => {
  const unscoped = await normalizationWorld('work-unscoped')
  const baseline = {}
  for (const kind of ['delivered', 'captions-off', 'cta-off', 'overlays-off']) baseline[kind] = await unscoped.render(unscoped.scoped(undefined), kind)
  assert.equal(unscoped.processor.calls.length, 4, 'without a scope every render normalizes for itself (today)')
  assert.equal(new Set(unscoped.processor.calls.map((call) => call.sha256)).size, 1, 'the four normalizations are the same bytes')

  const world = await normalizationWorld('work-scoped')
  const renderer = world.scoped('operation-1')
  const scopedRuns = {}
  for (const kind of ['delivered', 'captions-off', 'cta-off', 'overlays-off']) scopedRuns[kind] = await world.render(renderer, kind)
  assert.equal(world.processor.calls.length, 1, 'ONE normalization for the four renders')
  assert.equal(world.processor.calls[0].sha256, unscoped.processor.calls[0].sha256, 'the normalized input is byte-identical to the one each render made for itself')
  for (const kind of Object.keys(baseline)) {
    assert.equal(scopedRuns[kind].sha256, baseline[kind].sha256, `${kind}: the rendered output is byte-identical with and without the shared normalization`)
  }
  // the shared file is the one the first render wrote, and it still hashes to what the processor reported
  assert.equal(await sha256File(world.processor.calls[0].outputPath), world.processor.calls[0].sha256)
})

test('normalization: the entry dies with its directory and with its scope, and a different source or scope never reuses it', { timeout: 10 * 60_000 }, async () => {
  const world = await normalizationWorld('work-lifetime')
  const renderer = world.scoped('operation-a')
  await world.render(renderer, 'delivered')
  await world.render(renderer, 'overlays-off')
  assert.equal(world.processor.calls.length, 1)
  // another scope (another operation) normalizes for itself
  await world.render(world.scoped('operation-b'), 'cta-off')
  assert.equal(world.processor.calls.length, 2, 'a different scope shares nothing')
  // cleaning the directory that holds the file forgets the entry: the next render normalizes again
  await renderer.cleanup(`${(await planOutputIdOf(world))}-delivered`)
  await world.render(renderer, 'captions-off')
  assert.equal(world.processor.calls.length, 3, 'the owner directory was removed, so the file is normalized again')
  // a source whose content changed is a different key even at the same path
  const changed = join(root, 'source-changed.mp4')
  encodeSource({ ffmpegPath, outPath: changed, lavfiVideo: `mandelbrot=size=${SOURCE.width}x${SOURCE.height}:rate=30:end_scale=2` })
  const bands = await presetBands('9:16', SOURCE)
  const spec = outputSpecOf({ imageId: 'synthetic', format: '9:16', variant: 'combined', face: faceRectOf({ XMin: 0.46, YMin: 0.34, XMax: 0.56, YMax: 0.5 }), source: SOURCE, bands })
  const planned = await planOutput(spec, bands)
  await renderOutput({ renderer, spec, planned, sourcePath: changed, kind: 'overlays-off' })
  assert.equal(world.processor.calls.length, 4, 'a different source content is normalized, never served from the cache')
})

async function planOutputIdOf() {
  const bands = await presetBands('9:16', SOURCE)
  return outputSpecOf({ imageId: 'synthetic', format: '9:16', variant: 'combined', face: faceRectOf({ XMin: 0.46, YMin: 0.34, XMax: 0.56, YMax: 0.5 }), source: SOURCE, bands }).id
}

test('normalization: a cancelled or failed attempt leaves no entry behind, and the retry of the same operation normalizes again with a new file', { timeout: 10 * 60_000 }, async () => {
  const real = countingProcessor()
  let failNext = true
  const calls = []
  const processor = {
    calls,
    process: async (input) => {
      if (failNext) {
        failNext = false
        calls.push({ outcome: 'aborted' })
        // what a cancelled render leaves behind: a partial output and a rejection
        await (await import('node:fs/promises')).writeFile(input.outputPath, Buffer.from('partial'))
        throw Object.assign(new Error('Color pipeline render was cancelled'), { code: 'RENDER_EXECUTION_FAILED' })
      }
      const result = await real.process(input)
      calls.push({ outcome: 'normalized', sha256: result.sha256 })
      return result
    },
  }
  const world = await normalizationWorld('work-cancel', processor)
  const renderer = world.scoped('operation-cancelled')
  await assert.rejects(() => world.render(renderer, 'delivered'), /cancelled/)
  // the worker's finally: cleanup of the operation, then the retry attempt of the SAME operation id, same scope id
  await renderer.cleanup(`${await planOutputIdOf()}-delivered`)
  const retried = await world.render(renderer, 'delivered')
  const control = await world.render(renderer, 'overlays-off')
  assert.deepEqual(calls.map((call) => call.outcome), ['aborted', 'normalized'], 'the failed attempt cached nothing; the retry normalized once and its control reused it')
  assert.ok(retried.sha256 && control.sha256)
  // a failure WITHOUT the cleanup (a crash that never reached the finally) leaves no usable entry either
  failNext = true
  const other = world.scoped('operation-crashed')
  await assert.rejects(() => world.render(other, 'cta-off'), /cancelled/)
  await world.render(other, 'cta-off')
  assert.deepEqual(calls.map((call) => call.outcome), ['aborted', 'normalized', 'aborted', 'normalized'])
})
