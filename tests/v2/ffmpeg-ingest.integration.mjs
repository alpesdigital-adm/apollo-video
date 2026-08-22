import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)
const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`,
    workspaceId: 'workspace-ffmpeg-ingest',
    artifactId,
    manifestId,
    detection: {
      state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr',
    },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2026-08-02T00:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider,
    version: 'v1',
    parameters,
    parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`,
    workspaceId: probe.workspaceId,
    projectId: 'project-ffmpeg-ingest',
    sourceArtifactId: artifactId,
    sourceManifestId: manifestId,
    probe,
    outputMetadata: colorMetadata,
    createdByClientId: 'client-ffmpeg-ingest',
    createdAt: '2026-08-02T00:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

test('V2 FFmpeg ingest creates an inspectable proxy and speech derivative from a real master', async (t) => {
  assert.equal(typeof ffmpegPath, 'string')
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-ffmpeg-ingest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'master.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=25:duration=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1.2',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_trc', 'bt709',
    '-color_primaries', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', sourcePath,
  ], { windowsHide: true, timeout: 60_000 })

  const processor = new FfmpegIngestProcessor({ workRoot: join(root, 'work'), ffmpegPath })
  const result = await processor.normalize({ sourcePath, operationId: 'operation-real-ingest-1' })

  assert.equal(result.probe.width, 720)
  assert.equal(result.probe.height, 1280)
  assert.ok(result.probe.duration >= 1 && result.probe.duration <= 2)
  assert.equal(result.probe.codec, 'h264')
  assert.deepEqual(result.probe.color, {
    state: 'ready',
    metadata: {
      colorSpace: 'rec709',
      transfer: 'bt709',
      primaries: 'bt709',
      matrix: 'bt709',
      range: 'limited',
      bitDepth: 8,
    },
    pixelFormat: 'yuv420p',
    hdrMode: 'sdr',
  })
  assert.match(result.proxySha256, /^[a-f0-9]{64}$/)
  assert.ok(result.proxyByteSize > 0)
  assert.ok((await stat(result.audioPath)).size > 0)
  await access(result.proxyPath)

  await processor.cleanup('operation-real-ingest-1')
  await assert.rejects(() => access(result.proxyPath), { code: 'ENOENT' })
})

test('V2 editorial renderer materializes exact retained clips as a format-aware MP4 without crop zoom', async (t) => {
  assert.equal(typeof ffmpegPath, 'string')
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-ffmpeg-editorial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'master.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1.6',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1.6',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
  ], { windowsHide: true, timeout: 60_000 })

  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  const result = await renderer.render({
    operationId: 'operation-editorial-render-1',
    renderKind: 'proxy',
    sources: [{
      artifactId: 'artifact-1',
      path: sourcePath,
      mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-1'),
    }],
    fps: 25,
    format: '9:16',
    clips: [
      { id: 'clip-1', sourceArtifactId: 'artifact-1', sourceInFrame: 0, sourceOutFrame: 10, timelineInFrame: 0, timelineOutFrame: 10, rate: 1 },
      { id: 'clip-2', sourceArtifactId: 'artifact-1', sourceInFrame: 20, sourceOutFrame: 30, timelineInFrame: 10, timelineOutFrame: 20, rate: 1 },
    ],
    subtitleCues: [
      { id: 'cue-1', startFrame: 0, endFrame: 10, text: 'Legenda curta', anchor: 'bottom' },
      { id: 'cue-2', startFrame: 10, endFrame: 20, text: 'Área segura', anchor: 'bottom' },
    ],
    transitions: [
      { id: 'transition-1', fromClipId: 'clip-1', toClipId: 'clip-2', atFrame: 10, type: 'straight-cut', audioFadeMs: 24, reason: 'Invisible same-scene cut.' },
    ],
  })

  assert.equal(result.probe.width, 540)
  assert.equal(result.probe.height, 960)
  assert.ok(result.probe.duration >= 0.75 && result.probe.duration <= 0.85)
  assert.equal(result.probe.codec, 'h264')
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.ok(result.byteSize > 0)
  assert.equal(result.renderElementMap.proxyHash, result.sha256)
  assert.deepEqual(result.renderElementMap.canvas, { width: 540, height: 960 })
  assert.deepEqual(result.renderElementMap.elements.filter((item) => item.frame === 5).map((item) => item.type), ['background', 'presenter', 'subtitle'])
  await access(result.outputPath)
  const captions = await readFile(join(root, 'work', 'operation-editorial-render-1', 'captions.ass'), 'utf8')
  assert.match(captions, /Alignment,MarginL,MarginR,MarginV/)
  assert.match(captions, /Legenda curta/)
  assert.match(captions, /Área segura/)

  await renderer.cleanup('operation-editorial-render-1')
  await assert.rejects(() => access(result.outputPath), { code: 'ENOENT' })
})

test('V2 editorial renderer produces a verified 1080x1920 final MP4 from the approved timeline', async (t) => {
  assert.equal(typeof ffmpegPath, 'string')
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-ffmpeg-final-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'master.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
  ], { windowsHide: true, timeout: 60_000 })

  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
  const result = await renderer.render({
    operationId: 'operation-editorial-final-1',
    renderKind: 'final',
    sources: [{
      artifactId: 'artifact-1',
      path: sourcePath,
      mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-1'),
    }],
    fps: 30,
    format: '9:16',
    outputSpec: { width: 1080, height: 1920, fps: 30 },
    clips: [
      { id: 'clip-final-1', sourceArtifactId: 'artifact-1', sourceInFrame: 0, sourceOutFrame: 12, timelineInFrame: 0, timelineOutFrame: 12, rate: 1 },
    ],
    subtitleCues: [
      { id: 'cue-final-1', startFrame: 0, endFrame: 12, text: 'Legenda final segura', anchor: 'bottom' },
    ],
    transitions: [],
  })

  assert.equal(result.probe.width, 1080)
  assert.equal(result.probe.height, 1920)
  assert.ok(Math.abs(result.probe.fps - 30) <= 0.01)
  assert.equal(result.probe.codec, 'h264')
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.ok(result.byteSize > 0)
  assert.equal(result.renderElementMap.proxyHash, result.sha256)
  assert.deepEqual(result.renderElementMap.canvas, { width: 1080, height: 1920 })
  await access(result.outputPath)
})
