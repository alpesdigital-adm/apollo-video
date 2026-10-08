import { createReadStream } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { TesseractImageVisionProvider } from '../image/tesseract-image-vision-provider.ts'

const exec = promisify(execFile)
const SHA = /^[a-f0-9]{64}$/
function invalid(message: string): never { throw new DomainError('PERSISTENCE_NOT_CONFIGURED', message) }

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function fraction(value: string) {
  const [num, den] = value.split('/').map(Number)
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Source video has an invalid rational clock')
  }
  return { num, den }
}

export type OcrVideoRuntime = Readonly<{
  ffmpegBinary: string
  ffprobeBinary: string
  tesseractBinary: string
  tessdataDirectory: string
  traineddata: readonly Readonly<{ language: 'por' | 'eng'; path: string; licensePath: string }>[]
}>

/** Uses observed frame PTS and exact local executables; never asserts facial safety. */
export class TesseractOcrVideoAdapter {
  private readonly runtime: OcrVideoRuntime
  private readonly provider: TesseractImageVisionProvider

  constructor(runtime: OcrVideoRuntime) {
    if (![runtime.ffmpegBinary, runtime.ffprobeBinary, runtime.tesseractBinary,
      runtime.tessdataDirectory, ...runtime.traineddata.flatMap((entry) => [entry.path, entry.licensePath])]
      .every((value) => isAbsolute(value))) invalid('OCR runtime requires absolute binary, model and license paths')
    if (!runtime.traineddata.length || new Set(runtime.traineddata.map((entry) => entry.language)).size !== runtime.traineddata.length) {
      invalid('OCR runtime requires unique traineddata languages')
    }
    if (runtime.traineddata.some((entry) => resolve(entry.path) !==
      resolve(join(runtime.tessdataDirectory, `${entry.language}.traineddata`)))) {
      invalid('OCR traineddata hash path must be the file selected by Tesseract')
    }
    this.runtime = Object.freeze({ ...runtime,
      traineddata: Object.freeze(runtime.traineddata.map((entry) => Object.freeze({ ...entry }))),
    })
    this.provider = new TesseractImageVisionProvider({
      binary: runtime.tesseractBinary,
      languages: runtime.traineddata.map((entry) => entry.language),
      tessdataPrefix: runtime.tessdataDirectory,
    })
  }

  async analyze(input: {
    sourcePath: string
    expectedSourceSha256: string
    workDirectory: string
    sampleIntervalFrames: number
    maxSamples: number
    timelineFps: Readonly<{ num: number; den: number }>
    signal?: AbortSignal
  }) {
    if (!isAbsolute(input.sourcePath) || !isAbsolute(input.workDirectory) ||
        !SHA.test(input.expectedSourceSha256) ||
        !Number.isSafeInteger(input.sampleIntervalFrames) || input.sampleIntervalFrames < 1 ||
        !Number.isSafeInteger(input.maxSamples) || input.maxSamples < 1 || input.maxSamples > 1000) {
      throw new DomainError('INVALID_ARGUMENT', 'OCR video request is invalid')
    }
    if (await sha256File(input.sourcePath) !== input.expectedSourceSha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'OCR source bytes changed')
    }
    const runtimeHashes = await Promise.all([
      sha256File(this.runtime.ffmpegBinary), sha256File(this.runtime.ffprobeBinary),
      sha256File(this.runtime.tesseractBinary),
    ])
    const traineddata = await Promise.all(this.runtime.traineddata.map(async (entry) => ({
      language: entry.language,
      sha256: await sha256File(entry.path),
      licenseSha256: await sha256File(entry.licensePath),
    })))
    const versionResult = await exec(this.runtime.tesseractBinary, ['--version'], {
      windowsHide: true, timeout: 10_000, signal: input.signal, maxBuffer: 64 * 1024,
    })
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
    const executableVersion = versionOutput.split(/\r?\n/)[0]?.trim() ?? ''
    if (!executableVersion.startsWith('tesseract ')) invalid('OCR executable version is unavailable')
    const { stdout: orientationJson } = await exec(this.runtime.ffprobeBinary, [
      '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', input.sourcePath,
    ], { windowsHide: true, timeout: 30_000, signal: input.signal, maxBuffer: 2 * 1024 * 1024 })
    let orientation: { streams?: Array<Record<string, unknown>> }
    try { orientation = JSON.parse(orientationJson) as typeof orientation }
    catch { throw new DomainError('RENDER_OUTPUT_INVALID', 'FFprobe display metadata is invalid') }
    const display = orientation.streams?.[0]
    const sideData = Array.isArray(display?.side_data_list) ? display.side_data_list : []
    const hasRotation = Boolean(display?.tags && typeof display.tags === 'object' &&
      'rotate' in display.tags && Number((display.tags as Record<string, unknown>).rotate) !== 0) ||
      sideData.some((item) => {
        const entry = item as Record<string, unknown>
        return (entry.side_data_type === 'Display Matrix' &&
          (!Number.isFinite(Number(entry.rotation)) || Number(entry.rotation) !== 0))
      })
    if (hasRotation) throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR source display rotation is unsupported')
    const { stdout } = await exec(this.runtime.ffprobeBinary, [
      '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
      '-show_entries', 'stream=width,height,r_frame_rate,time_base:frame=best_effort_timestamp',
      '-of', 'json', input.sourcePath,
    ], { windowsHide: true, timeout: 120_000, signal: input.signal, maxBuffer: 64 * 1024 * 1024 })
    let probe: { streams?: Array<Record<string, unknown>>; frames?: Array<Record<string, unknown>> }
    try { probe = JSON.parse(stdout) as typeof probe }
    catch { throw new DomainError('RENDER_OUTPUT_INVALID', 'FFprobe frame-clock output is invalid') }
    const stream = probe.streams?.[0]
    const frames = probe.frames ?? []
    const width = Number(stream?.width), height = Number(stream?.height)
    if (!stream || !Number.isSafeInteger(width) || width < 1 || width > 4096 ||
        !Number.isSafeInteger(height) || height < 1 || height > 4096 ||
        frames.length < 1 || frames.length > 216_000) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR source has no usable video frames')
    }
    const sourceFps = fraction(String(stream.r_frame_rate))
    const sourceTimebase = fraction(String(stream.time_base))
    if (sourceFps.num * input.timelineFps.den !== input.timelineFps.num * sourceFps.den) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR source and timeline fps differ')
    }
    const pts = frames.map((frame) => Number(frame.best_effort_timestamp))
    const ticksPerFrame = sourceFps.den * sourceTimebase.den / (sourceFps.num * sourceTimebase.num)
    if (pts.some((value, index) => !Number.isSafeInteger(value) || value < 0 ||
      (index > 0 && (value <= pts[index - 1]! || Math.abs(value - (pts[0]! + index * ticksPerFrame)) > 1)))) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR source frame PTS are not CFR within one tick')
    }
    const sampleIndexes = Array.from({ length: Math.ceil(frames.length / input.sampleIntervalFrames) },
      (_, index) => index * input.sampleIntervalFrames)
    if (sampleIndexes.length > input.maxSamples) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR sample policy would exceed the authorized maximum')
    }
    if (sampleIndexes.length * width * height > 500_000_000 ||
        frames.length * sourceFps.den / sourceFps.num > 7200) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR source exceeds bounded decoding work')
    }
    const samples = []
    for (const sourceFrame of sampleIndexes) {
      const imagePath = join(input.workDirectory, `ocr-source-${sourceFrame}.png`)
      try {
        await exec(this.runtime.ffmpegBinary, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', input.sourcePath,
          '-vf', `select=eq(n\\,${sourceFrame})`, '-vsync', '0', '-frames:v', '1', imagePath,
        ], { windowsHide: true, timeout: 120_000, signal: input.signal, maxBuffer: 2 * 1024 * 1024 })
        const imageBytes = await readFile(imagePath)
        const analysis = await this.provider.analyze({ sourcePath: imagePath, width, height, signal: input.signal })
        if (analysis.ocr.state !== 'available') throw new DomainError('RENDER_OUTPUT_INVALID', 'OCR provider returned no observed result')
        samples.push({
          sourceFrame, sourcePts: pts[sourceFrame]!,
          sourcePtsEvidenceHash: calculateCanonicalHash({ sourceFrame, ffprobeFrame: frames[sourceFrame] }),
          imageSha256: createHash('sha256').update(imageBytes).digest('hex'),
          ocr: analysis.ocr.values.map((region) => ({
            text: region.text, language: region.language, box: region.box, confidence: region.confidence,
          })),
        })
      } finally {
        await unlink(imagePath).catch(() => undefined)
      }
    }
    const hashesAfter = await Promise.all([
      sha256File(this.runtime.ffmpegBinary), sha256File(this.runtime.ffprobeBinary),
      sha256File(this.runtime.tesseractBinary), sha256File(input.sourcePath),
      ...this.runtime.traineddata.flatMap((entry) => [sha256File(entry.path), sha256File(entry.licensePath)]),
    ])
    if (hashesAfter[3] !== input.expectedSourceSha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'OCR source bytes changed during analysis')
    }
    if (hashesAfter.slice(0, 3).some((hash, index) => hash !== runtimeHashes[index]) ||
        traineddata.some((item, index) => item.sha256 !== hashesAfter[4 + index * 2] ||
          item.licenseSha256 !== hashesAfter[5 + index * 2])) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'OCR runtime bytes changed during analysis')
    }
    return Object.freeze({
      sourceFps, sourceTimebase, sourcePtsStart: pts[0]!, sourceClock: 'constant-frame-rate' as const,
      observedFrameCount: frames.length, width, height,
      producer: Object.freeze({ name: 'tesseract' as const, executableSha256: runtimeHashes[2]!,
        executableVersion, traineddata }),
      runtime: Object.freeze({ ffmpegSha256: runtimeHashes[0]!, ffprobeSha256: runtimeHashes[1]! }),
      samples: Object.freeze(samples),
    })
  }
}
