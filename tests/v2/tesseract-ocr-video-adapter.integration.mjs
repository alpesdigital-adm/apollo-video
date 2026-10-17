import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { TesseractOcrVideoAdapter } from '../../src/v2/infrastructure/perception/tesseract-ocr-video-adapter.ts'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('real pinned Tesseract OCR observes decoded video frames and original PTS without claiming facial safety', {
  skip: process.env.APOLLO_OCR_VIDEO_E2E !== '1' && 'requires explicit local OCR binary and traineddata paths',
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-ocr-real-'))
  try {
    const imagePath = join(root, 'opening.png')
    const secondImagePath = join(root, 'ending.png')
    const videoPath = join(root, 'source.mp4')
    const { default: sharp } = await import('sharp')
    const image = (text) => Buffer.from(`<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="white"/><text x="50" y="200" font-size="100" font-family="Arial" font-weight="bold" fill="black">${text}</text></svg>`)
    await sharp(image('APOLLO')).png().toFile(imagePath)
    await sharp(image('VIDEO')).png().toFile(secondImagePath)
    await exec(process.env.APOLLO_OCR_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-framerate', '30', '-t', '0.5', '-i', imagePath,
      '-loop', '1', '-framerate', '30', '-t', '0.5', '-i', secondImagePath,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-r', '30', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', videoPath], { windowsHide: true, timeout: 30_000 })
    const sourceSha256 = sha(await readFile(videoPath))
    const tessdata = process.env.APOLLO_OCR_TESSDATA
    const adapter = new TesseractOcrVideoAdapter({
      ffmpegBinary: process.env.APOLLO_OCR_FFMPEG,
      ffprobeBinary: process.env.APOLLO_OCR_FFPROBE,
      tesseractBinary: process.env.APOLLO_OCR_TESSERACT,
      tessdataDirectory: tessdata,
      traineddata: [{ language: 'eng', path: join(tessdata, 'eng.traineddata'),
        licensePath: join(tessdata, 'LICENSE') }],
    })
    const output = await adapter.analyze({ sourcePath: videoPath,
      expectedSourceSha256: sourceSha256, workDirectory: root,
      sampleIntervalFrames: 15, maxSamples: 2,
      timelineFps: { num: 30, den: 1 } })
    assert.equal(output.observedFrameCount, 30)
    assert.equal(output.samples.length, 2)
    assert.equal(output.samples[0].sourcePts, 0)
    assert.ok(output.samples[1].sourcePts > output.samples[0].sourcePts)
    assert.match(output.producer.executableSha256, /^[a-f0-9]{64}$/)
    assert.match(output.producer.traineddata[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(output.producer.executableSha256, sha(await readFile(process.env.APOLLO_OCR_TESSERACT)))
    assert.equal(output.producer.traineddata[0].sha256, sha(await readFile(join(tessdata, 'eng.traineddata'))))
    assert.equal(output.producer.traineddata[0].licenseSha256, sha(await readFile(join(tessdata, 'LICENSE'))))
    assert.ok(output.samples[0].ocr.some((region) => /APOLLO/i.test(region.text)),
      'first sampled frame should contain the opening text')
    assert.ok(output.samples[1].ocr.some((region) => /VIDEO/i.test(region.text)),
      'second sampled frame should contain the later text')
    assert.equal('faceSafety' in output, false)
    const originalAnalyze = adapter.provider.analyze.bind(adapter.provider)
    let changedSource = false
    adapter.provider.analyze = async (request) => {
      const result = await originalAnalyze(request)
      if (!changedSource) {
        await appendFile(videoPath, Buffer.from('source changed during OCR'))
        changedSource = true
      }
      return result
    }
    await assert.rejects(adapter.analyze({ sourcePath: videoPath,
      expectedSourceSha256: sourceSha256, workDirectory: root,
      sampleIntervalFrames: 15, maxSamples: 2,
      timelineFps: { num: 30, den: 1 } }), /source bytes changed/i)
    const rotatedPath = join(root, 'rotated.mp4')
    await exec(process.env.APOLLO_OCR_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-display_rotation:v:0', '90', '-i', videoPath, '-c', 'copy', rotatedPath],
    { windowsHide: true, timeout: 30_000 })
    const rotationProbe = await exec(process.env.APOLLO_OCR_FFPROBE, ['-v', 'error',
      '-select_streams', 'v:0', '-show_streams', '-of', 'json', rotatedPath],
    { windowsHide: true, timeout: 30_000 })
    assert.match(rotationProbe.stdout, /rotation|rotate/, 'controlled source must carry display rotation')
    await assert.rejects(adapter.analyze({ sourcePath: rotatedPath,
      expectedSourceSha256: sha(await readFile(rotatedPath)), workDirectory: root,
      sampleIntervalFrames: 15, maxSamples: 2,
      timelineFps: { num: 30, den: 1 } }), /display rotation is unsupported/)
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
