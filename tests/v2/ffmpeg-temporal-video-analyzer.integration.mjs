import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { FfmpegTemporalVideoAnalyzer } from '../../src/v2/infrastructure/perception/ffmpeg-temporal-video-analyzer.ts'

const exec = promisify(execFile)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const enabled = process.env.APOLLO_TEMPORAL_VIDEO_E2E === '1'
const ffmpeg = process.env.APOLLO_TEMPORAL_FFMPEG
const ffprobe = process.env.APOLLO_TEMPORAL_FFPROBE

test('real pinned temporal adapter measures static, pan and cut without semantic claims', {
  skip: !enabled && 'requires explicit pinned FFmpeg/FFprobe paths', timeout: 180_000,
}, async () => {
  assert.ok(isAbsolute(ffmpeg) && isAbsolute(ffprobe))
  const root = await mkdtemp(join(tmpdir(), 'apollo-w63-temporal-'))
  try {
    const { default: sharp } = await import('sharp')
    const width = 640, height = 180
    const raw = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      raw[offset] = (x * 17 + y * 31 + x * y) % 256
      raw[offset + 1] = (x * 7 + y * 13 + (x >> 2) * 41) % 256
      raw[offset + 2] = (x * 23 + y * 3 + (y >> 2) * 29) % 256
    }
    const imagePath = join(root, 'pattern.png')
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(imagePath)
    const staticPath = join(root, 'static.mkv'), panPath = join(root, 'pan.mkv')
    const cutPath = join(root, 'cut.mkv'), irregularPath = join(root, 'irregular.mkv')
    const rotationInputPath = join(root, 'rotation-input.mp4'), rotatedPath = join(root, 'rotated.mp4')
    for (const [path, crop] of [[staticPath, '0'], [panPath, 'n*4']]) {
      await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1',
        '-framerate', '30', '-t', '1', '-i', imagePath,
        '-vf', `crop=320:180:${crop}:0,format=yuv420p`, '-c:v', 'ffv1', path],
      { windowsHide: true, timeout: 30_000 })
    }
    await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=30:d=0.5',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
      '-c:v', 'ffv1', cutPath], { windowsHide: true, timeout: 30_000 })
    await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', staticPath,
      '-vf', 'setpts=PTS+0.5/TB*gte(N\\,15)', '-fps_mode', 'passthrough',
      '-c:v', 'ffv1', irregularPath], { windowsHide: true, timeout: 30_000 })
    // MP4 carries display-matrix rotation on stream-copy remux. Keep the
    // lossless FFV1 fixtures above for all temporal/pixel measurements.
    await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', staticPath,
      '-map', '0:v:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rotationInputPath],
    { windowsHide: true, timeout: 30_000 })
    await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', rotationInputPath,
      '-map', '0:v:0', '-c:v', 'copy', '-metadata:s:v:0', 'rotate=90', rotatedPath],
    { windowsHide: true, timeout: 30_000 })
    const runtime = { ffmpegBinary: ffmpeg, ffprobeBinary: ffprobe,
      expectedFFmpegSha256: digest(await readFile(ffmpeg)),
      expectedFFprobeSha256: digest(await readFile(ffprobe)) }
    const adapter = new FfmpegTemporalVideoAnalyzer(runtime)
    const request = async (path, signal) => adapter.analyze({ sourcePath: path,
      expectedSourceSha256: digest(await readFile(path)), signal })
    const stationary = await request(staticPath)
    assert.equal(stationary.sourceClock, 'constant-frame-rate')
    assert.equal(stationary.observedFrameCount, 30)
    assert.equal(stationary.shot.observations.length, 29)
    assert.deepEqual(stationary.assessedDomain, {
      startSourcePts: stationary.shot.observations[0].startSourcePts,
      endSourcePts: stationary.shot.observations.at(-1).endSourcePts,
    })
    assert.equal(stationary.shot.gaps.length, 0)
    assert.equal(stationary.motion.gaps.length, 0)
    assert.ok(Math.max(...stationary.shot.observations.map((item) => item.changeScore)) < 0.03)
    assert.ok(Math.max(...stationary.motion.observations.map((item) =>
      Math.hypot(item.vectorPxPerSecond.x, item.vectorPxPerSecond.y))) < 2)
    assert.ok(Math.max(...stationary.motion.observations.map((item) => item.residualMeanAbsoluteLuma)) < 0.03)
    assert.equal(stationary.runtime.ffmpegSha256, digest(await readFile(ffmpeg)))
    assert.equal(stationary.runtime.ffprobeSha256, digest(await readFile(ffprobe)))
    assert.equal('faceSafety' in stationary, false)
    assert.equal('hardCut' in stationary.shot.observations[0], false)
    let wrongPinStarted = false
    const wrongPin = new FfmpegTemporalVideoAnalyzer({ ...runtime,
      expectedFFmpegSha256: 'f'.repeat(64) }, {
      onProcessStarted: () => { wrongPinStarted = true },
    })
    await assert.rejects(wrongPin.analyze({ sourcePath: staticPath,
      expectedSourceSha256: digest(await readFile(staticPath)) }), /pinned digest/i)
    assert.equal(wrongPinStarted, false, 'mismatched binary must be rejected before execution')
    const pan = await request(panPath)
    const magnitudes = pan.motion.observations.map((item) =>
      Math.hypot(item.vectorPxPerSecond.x, item.vectorPxPerSecond.y)).sort((a, b) => a - b)
    assert.ok(magnitudes[Math.floor(magnitudes.length / 2)] > 10)
    assert.ok(pan.motion.observations.every((item) => Number.isFinite(item.residualMeanAbsoluteLuma) &&
      item.residualMeanAbsoluteLuma < 0.20))
    const cut = await request(cutPath)
    assert.ok(cut.shot.observations[14].changeScore > 0.80)
    assert.ok(cut.motion.gaps.some((gap) => gap.startSourcePts === cut.shot.observations[14].startSourcePts &&
      gap.endSourcePts === cut.shot.observations[14].endSourcePts &&
      gap.reasonCode === 'UNRELIABLE_FRAME_DIFFERENCE'))
    await assert.rejects(request(irregularPath), /PTS.*non-CFR|PTS.*reordered/i)
    const rotationMetadata = await exec(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_streams', '-of', 'json', rotatedPath], { windowsHide: true, timeout: 30_000 })
    const [rotationStream] = JSON.parse(rotationMetadata.stdout).streams
    assert.equal(rotationStream.codec_name, 'h264')
    const rotations = [
      ...(rotationStream.side_data_list ?? []).filter((item) => item.side_data_type === 'Display Matrix')
        .map((item) => item.rotation),
      ...(rotationStream.tags?.rotate === undefined ? [] : [rotationStream.tags.rotate]),
    ]
    assert.ok(rotations.length > 0 && rotations.every((angle) =>
      angle !== null && String(angle).trim() !== '' && Number.isFinite(Number(angle)) && Math.abs(Number(angle)) === 90),
    `Remuxed H264/MP4 fixture must carry structural 90-degree rotation before adapter rejection: ${JSON.stringify(rotations)}`)
    let rotationProbed = false, rotationDecoded = false
    const rotationAdapter = new FfmpegTemporalVideoAnalyzer(runtime, {
      onProcessStarted: (kind) => {
        if (kind === 'probe') rotationProbed = true
        if (kind === 'decode') rotationDecoded = true
      },
    })
    await assert.rejects(rotationAdapter.analyze({ sourcePath: rotatedPath,
      expectedSourceSha256: digest(await readFile(rotatedPath)) }), /display rotation is unsupported/i)
    assert.equal(rotationProbed, true)
    assert.equal(rotationDecoded, false, 'Unsupported display rotation must be rejected before decoder launch')
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(request(staticPath, abort.signal), /aborted/i)
    const duringDecode = new AbortController()
    let decodePid
    const abortingAdapter = new FfmpegTemporalVideoAnalyzer(runtime, {
      onProcessStarted: (kind, pid) => {
        if (kind === 'decode') { decodePid = pid; duringDecode.abort() }
      },
    })
    await assert.rejects(abortingAdapter.analyze({ sourcePath: staticPath,
      expectedSourceSha256: digest(await readFile(staticPath)), signal: duringDecode.signal }), /aborted/i)
    assert.ok(Number.isSafeInteger(decodePid) && decodePid > 0)
    assert.throws(() => process.kill(decodePid, 0), /ESRCH|not found/i,
      'aborted decoder PID must be terminal before analyze settles')
    const duringCpu = new AbortController()
    let measuredPairs = 0
    const cpuAdapter = new FfmpegTemporalVideoAnalyzer(runtime, {
      onPairMeasured: (frame) => {
        measuredPairs += 1
        if (frame === 8) setImmediate(() => duringCpu.abort())
      },
    })
    await assert.rejects(cpuAdapter.analyze({ sourcePath: panPath,
      expectedSourceSha256: digest(await readFile(panPath)), signal: duringCpu.signal }), /aborted/i)
    assert.ok(measuredPairs >= 8 && measuredPairs < 29, 'abort must interrupt CPU measurement')
    const expired = new FfmpegTemporalVideoAnalyzer(runtime, { deadlineMs: 1 })
    await assert.rejects(expired.analyze({ sourcePath: staticPath,
      expectedSourceSha256: digest(await readFile(staticPath)) }), /deadline/i)
  } finally {
    const canonical = await realpath(root).catch(() => null)
    if (canonical && isAbsolute(canonical)) {
      const offset = relative(resolve(tmpdir()), canonical)
      if (offset && !offset.startsWith('..') && !isAbsolute(offset)) {
        await rm(canonical, { recursive: true, force: true })
      }
    }
  }
})
