import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { decodeFace0204Output } from '../../src/v2/domain/face-detector-output.ts'
import { ACCEPTED_FACE_PRODUCERS } from '../../src/v2/domain/face-producer-registry.ts'
import { FfmpegOpenvinoFaceVideoAnalyzer } from '../../src/v2/infrastructure/perception/ffmpeg-openvino-face-video-analyzer.ts'
import { tensor } from './helpers/face-envelope-v2.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const HEAD = [0.95, 0.35, 0.15, 0.65, 0.75]

function png(width, height, seed) {
  const header = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR')])
  const size = Buffer.alloc(8); size.writeUInt32BE(width, 0); size.writeUInt32BE(height, 4)
  return Buffer.concat([header, size, Buffer.from([8, 2, 0, 0, 0]), Buffer.from(`payload-${seed}`)])
}

async function rig({ probe = {}, frameWidth = 1280, ffmpegMutate, rows = () => [], stderrPts, hashesAfter } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'apollo-face-analyzer-'))
  const files = { source: join(base, 'source.mp4'), ffmpeg: join(base, 'ffmpeg.bin'), ffprobe: join(base, 'ffprobe.bin'), license: join(base, 'LICENSE') }
  const bytes = { source: Buffer.from('source-video'), ffmpeg: Buffer.from('ffmpeg'), ffprobe: Buffer.from('ffprobe') }
  await writeFile(files.source, bytes.source); await writeFile(files.ffmpeg, bytes.ffmpeg); await writeFile(files.ffprobe, bytes.ffprobe)
  await writeFile(files.license, 'license')
  const calls = []
  const streamDefaults = { width: 1280, height: 720, r_frame_rate: '30/1', avg_frame_rate: '30/1', time_base: '1/15360' }
  const runner = async (binary, args) => {
    calls.push({ binary: basename(binary), args })
    if (binary === files.ffprobe) {
      return { stdout: Buffer.from(JSON.stringify({ streams: [{ ...streamDefaults, ...probe }], frames: [{ best_effort_timestamp: 0 }] })), stderr: Buffer.alloc(0) }
    }
    const pattern = args.at(-1), directory = dirname(pattern)
    const interval = Number(/mod\(n\\,(\d+)\)/.exec(args[args.indexOf('-vf') + 1])[1])
    const count = Number(args[args.indexOf('-frames:v') + 1])
    const first = Math.ceil(Number(args[args.indexOf('-ss') + 1]) * 30 - 1e-6) // the seek is half a frame before the first sample
    let log = ''
    for (let index = 0; index < count; index += 1) {
      await writeFile(join(directory, `frame-${String(index).padStart(6, '0')}.png`), png(frameWidth, 720, index))
      const frame = first + index * interval
      log += `[Parsed_showinfo_1 @ 0x1] n:${String(index).padStart(4)} pts:${String((stderrPts ?? ((f) => f * 512))(frame, index)).padStart(8)} pts_time:0.5 pos:1\n`
    }
    await ffmpegMutate?.(directory)
    return { stdout: Buffer.alloc(0), stderr: Buffer.from(log) }
  }
  const accepted = ACCEPTED_FACE_PRODUCERS[0]
  const detectorCalls = []
  const detector = {
    async detect(request) {
      detectorCalls.push(request)
      await hashesAfter?.(files)
      return {
        sourceSha256: request.sourceSha256, bridgeSha256: 'c'.repeat(64), pythonExecutableSha256: 'd'.repeat(64),
        modelXmlSha256: accepted.model.xmlSha256, modelBinSha256: accepted.model.binSha256, runtimeManifestSha256: 'e'.repeat(64),
        runtime: { platform: 'win32', ...Object.fromEntries(['pythonVersion', 'openvinoVersion', 'openvinoPackageVersion', 'opencvVersion', 'numpyVersion'].map((key) => [key, accepted.platforms[0][key]])) },
        coverage: 'sampled-only', elapsedMs: 5,
        frames: request.frames.map((frame, index) => {
          const raw = tensor(rows(index))
          const decoded = decodeFace0204Output(raw, 0.2)
          return { ...frame, status: 'observed', reason: null, width: 1280, height: 720, inferMs: 17, rawOutput: raw, rawOutputSha256: sha(raw), detections: decoded.detections }
        }),
      }
    },
  }
  const analyzer = new FfmpegOpenvinoFaceVideoAnalyzer({ ffmpeg: { path: files.ffmpeg, sha256: sha(bytes.ffmpeg) },
    ffprobe: { path: files.ffprobe, sha256: sha(bytes.ffprobe) }, modelLicense: { path: files.license, sha256: sha('license') } }, detector,
  { runner, adapterPath: join(base, 'adapter.ts'), acceptedLicenseSha256: sha('license') })
  await writeFile(join(base, 'adapter.ts'), 'adapter')
  const request = (extra = {}) => ({ sourcePath: files.source, expectedSourceSha256: sha(bytes.source), workDirectory: base, sourceInFrame: 10, sourceOutFrame: 40,
    sampleIntervalFrames: 5, maxSamples: 60, timelineFps: { num: 30, den: 1 }, ...extra })
  return { base, files, analyzer, calls, detectorCalls, request, accepted }
}

test('one FFmpeg pass decodes every sampled frame of the window and the detector gets exactly those frames', async () => {
  const r = await rig({ rows: (index) => (index === 1 ? [HEAD] : []) })
  try {
    const analysis = await r.analyzer.analyze(r.request())
    assert.equal(r.calls.filter((call) => call.binary === 'ffmpeg.bin').length, 1, 'a single decode process per window')
    assert.equal(r.calls.filter((call) => call.binary === 'ffprobe.bin').length, 1)
    const decode = r.calls.find((call) => call.binary === 'ffmpeg.bin').args
    assert.ok(decode.includes('-copyts') && decode.includes('-ss'))
    assert.equal(decode[decode.indexOf('-frames:v') + 1], '6')
    assert.match(decode[decode.indexOf('-vf') + 1], /^select=not\(mod\(n\\,5\)\),showinfo$/)
    // Samples are the multiples of 5 inside [10, 40): 10, 15, ..., 35.
    assert.deepEqual(analysis.samples.map((sample) => sample.sourceFrame), [10, 15, 20, 25, 30, 35])
    assert.deepEqual(analysis.samples.map((sample) => sample.sourcePts), [10, 15, 20, 25, 30, 35].map((frame) => frame * 512))
    assert.equal(analysis.samples[1].boxes.length, 1)
    assert.equal(analysis.samples[0].status, 'observed')
    assert.equal(analysis.samples[0].rawOutput.bytes, 5600)
    assert.equal(analysis.rawOutputs.length, 6)
    assert.equal(analysis.rawOutputs[1].byteLength, 5600)
    assert.equal(analysis.sourceWidth, 1280); assert.equal(analysis.sourceHeight, 720)
    assert.equal(analysis.sourcePtsStart, 0)
    assert.deepEqual(analysis.sourceTimebase, { num: 1, den: 15360 })
    assert.equal(analysis.producer.assessment.runtimeParity.status, 'passed')
    assert.equal(analysis.producer.assessment.scope, 'foreground-faces-and-speaker')
    assert.equal(r.detectorCalls[0].frames.length, 6)
    assert.ok(r.detectorCalls[0].frames.every((frame, index) => frame.ptsMs === Math.round([10, 15, 20, 25, 30, 35][index] * 512 * 1000 / 15360)))
    assert.ok(existsSync(r.detectorCalls[0].framesDirectory) === false, 'the frame directory is removed afterwards')
    assert.deepEqual((await readdir(r.base)).filter((name) => name.startsWith('face-frames-')), [])
  } finally { await rm(r.base, { recursive: true, force: true }) }
})

test('a frame whose PTS the constant-frame-rate clock cannot explain, or a wrong set of files, is refused', async () => {
  for (const [options, pattern] of [
    [{ stderrPts: (frame) => frame * 512 + 700 }, /PTS does not match/],
    [{ stderrPts: (frame, index) => (index === 3 ? 0 : frame * 512) }, /PTS does not match/],
    [{ frameWidth: 640 }, /geometry differs/],
    [{ ffmpegMutate: async () => {} , stderrPts: () => 0 }, /PTS does not match/],
    [{ probe: { r_frame_rate: '30/1', avg_frame_rate: '29/1' } }, /not constant frame rate/],
    [{ probe: { r_frame_rate: '25/1', avg_frame_rate: '25/1' } }, /fps differ/],
    [{ probe: { width: 4000 } }, /dimensions are unsupported/],
    [{ probe: { tags: { rotate: '90' } } }, /rotation is unsupported/],
    [{ probe: { side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] } }, /rotation is unsupported/],
    [{ probe: { time_base: '1/10' } }, /cannot resolve individual frames/],
  ]) {
    const r = await rig(options)
    try { await assert.rejects(r.analyzer.analyze(r.request()), pattern, JSON.stringify(options).slice(0, 80)) } finally { await rm(r.base, { recursive: true, force: true }) }
  }
  const missing = await rig({ ffmpegMutate: async (directory) => { await rm(join(directory, 'frame-000002.png')) } })
  try { await assert.rejects(missing.analyzer.analyze(missing.request()), /unexpected set of frames/) } finally { await rm(missing.base, { recursive: true, force: true }) }
})

test('source, runtime or adapter bytes that differ from their digests, or change during the run, are refused', async () => {
  const wrongSource = await rig()
  try { await assert.rejects(wrongSource.analyzer.analyze(wrongSource.request({ expectedSourceSha256: 'a'.repeat(64) })), /differs from its expected digest/) } finally { await rm(wrongSource.base, { recursive: true, force: true }) }
  const swapped = await rig({ hashesAfter: async (files) => { await writeFile(files.ffmpeg, 'swapped ffmpeg') } })
  try {
    await assert.rejects(swapped.analyzer.analyze(swapped.request()), /changed during analysis/)
    assert.deepEqual((await readdir(swapped.base)).filter((name) => name.startsWith('face-frames-')), [], 'cleanup also runs on failure')
  } finally { await rm(swapped.base, { recursive: true, force: true }) }
  const edited = await rig({ hashesAfter: async (files) => { await writeFile(files.source, 'edited') } })
  try { await assert.rejects(edited.analyzer.analyze(edited.request()), /changed during analysis/) } finally { await rm(edited.base, { recursive: true, force: true }) }
})

test('sampling limits, aborts and the accepted license are enforced', async () => {
  const r = await rig()
  try {
    await assert.rejects(r.analyzer.analyze(r.request({ sourceInFrame: 11, sourceOutFrame: 14 })), /between one and the maximum/)
    await assert.rejects(r.analyzer.analyze(r.request({ sourceInFrame: 0, sourceOutFrame: 400 })), /between one and the maximum/)
    await assert.rejects(r.analyzer.analyze(r.request({ maxSamples: 61 })), /input is invalid/)
    await assert.rejects(r.analyzer.analyze(r.request({ sourceInFrame: 10, sourceOutFrame: 10 })), /input is invalid/)
    await assert.rejects(r.analyzer.analyze(r.request({ sourcePath: 'relative.mp4' })), /input is invalid/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(r.analyzer.analyze(r.request({ signal: controller.signal })), /aborted/)
    const sixty = await r.analyzer.analyze(r.request({ sourceInFrame: 0, sourceOutFrame: 300 }))
    assert.equal(sixty.samples.length, 60)
    assert.throws(() => new FfmpegOpenvinoFaceVideoAnalyzer({ ffmpeg: { path: r.files.ffmpeg, sha256: 'a'.repeat(64) }, ffprobe: { path: r.files.ffprobe, sha256: 'b'.repeat(64) },
      modelLicense: { path: r.files.license, sha256: 'c'.repeat(64) } }, {}), /not the accepted one/)
  } finally { await rm(r.base, { recursive: true, force: true }) }
})
