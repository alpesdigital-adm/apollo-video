import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { FfmpegYunetFaceVideoAnalyzer } from '../../src/v2/infrastructure/perception/ffmpeg-yunet-face-video-analyzer.ts'
import { YunetCpuFaceDetector } from '../../src/v2/infrastructure/perception/yunet-cpu-face-detector.ts'

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const bridgePath = fileURLToPath(new URL('../../src/v2/infrastructure/perception/yunet_cpu_bridge.py', import.meta.url))
const required = ['W61_PYTHON', 'W61_PYDEPS', 'W61_YUNET_MODEL', 'W61_OPENCV_BINARY',
  'W61_FFMPEG', 'W61_FFPROBE', 'W61_YUNET_LICENSE', 'W61_FACE_VIDEO_SMOKE']
const enabled = required.every((key) => !!process.env[key])

test('face video analyzer rejects missing runtime pins before a process starts', () => {
  assert.throws(() => new FfmpegYunetFaceVideoAnalyzer({
    ffmpeg: { path: 'relative-ffmpeg', sha256: 'a'.repeat(64) },
    ffprobe: { path: 'relative-ffprobe', sha256: 'b'.repeat(64) },
    modelLicense: { path: 'relative-license', sha256: 'c'.repeat(64) },
  }, { detect: async () => { throw new Error('must not run') } }), /runtime path or SHA-256/)
})

test('pinned local FFprobe/FFmpeg frames and YuNet bridge preserve source PTS and unknown authority',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const detector = new YunetCpuFaceDetector({
      pythonExecutable: process.env.W61_PYTHON,
      pythonExecutableSha256: sha(process.env.W61_PYTHON),
      pythonModulePath: process.env.W61_PYDEPS,
      modelPath: process.env.W61_YUNET_MODEL,
      bridgePath, bridgeSha256: sha(bridgePath),
      opencvBinaryPath: process.env.W61_OPENCV_BINARY,
      opencvBinarySha256: sha(process.env.W61_OPENCV_BINARY), timeoutMs: 30_000,
    })
    const analyzer = new FfmpegYunetFaceVideoAnalyzer({
      ffmpeg: { path: process.env.W61_FFMPEG, sha256: sha(process.env.W61_FFMPEG) },
      ffprobe: { path: process.env.W61_FFPROBE, sha256: sha(process.env.W61_FFPROBE) },
      modelLicense: { path: process.env.W61_YUNET_LICENSE,
        sha256: sha(process.env.W61_YUNET_LICENSE) },
    }, detector)
    const sourcePath = process.env.W61_FACE_VIDEO_SMOKE
    const result = await analyzer.analyze({ sourcePath, expectedSourceSha256: sha(sourcePath),
      workDirectory: fileURLToPath(new URL('.', import.meta.url)),
      sourceInFrame: 0, sourceOutFrame: 30, sampleIntervalFrames: 15, maxSamples: 2,
      timelineFps: { num: 30, den: 1 } })
    assert.equal(result.sourceWidth, 320)
    assert.equal(result.sourceHeight, 180)
    assert.equal(result.sourceOrientation, 'rotation-0-exif-neutral')
    assert.deepEqual(result.samples.map((sample) => sample.sourceFrame), [0, 15])
    assert.deepEqual(result.samples.map((sample) => sample.sourcePts), [0, 7680])
    assert.ok(result.samples.every((sample) => sample.frameWidth === 320 &&
      sample.frameHeight === 180 && sample.status === 'observed' &&
      /^[a-f0-9]{64}$/.test(sample.imageSha256)))
    assert.equal(result.detectorConfig.inputWidth, 640)
    assert.equal(result.producer.assessment.status, 'failed-gate')
    assert.equal(result.producer.modelSha256,
      '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4')
  })
