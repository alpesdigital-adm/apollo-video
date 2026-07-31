import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function colorCompilation(artifactId) {
  const manifestId = `manifest-${artifactId}`
  const probe = createMediaColorProbe({
    id: `probe-${artifactId}`, workspaceId: 'workspace-render-golden', artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2026-07-31T08:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters,
    parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: `compilation-${artifactId}`, workspaceId: probe.workspaceId,
    projectId: 'project-render-golden', sourceArtifactId: artifactId, sourceManifestId: manifestId,
    probe, outputMetadata: colorMetadata, createdByClientId: 'client-render-golden',
    createdAt: '2026-07-31T08:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

test('T-FR-221 renderer materializes B-roll video while preserving source-master audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multisource-render-'))
  const masterPath = join(root, 'master.mp4')
  const brollPath = join(root, 'broll.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-af', 'volume=16',
      '-c:a', 'aac', '-ar', '48000', masterPath,
    ], { windowsHide: true })
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', brollPath,
    ], { windowsHide: true })

    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'),
      ffmpegPath,
    })
    const result = await renderer.render({
      operationId: 'multisource-render-test',
      renderKind: 'proxy',
      sources: [
        { artifactId: 'artifact-master', path: masterPath, mediaType: 'video', colorPipelineCompilation: colorCompilation('artifact-master') },
        { artifactId: 'artifact-broll', path: brollPath, mediaType: 'video', colorPipelineCompilation: colorCompilation('artifact-broll') },
      ],
      clips: [
        {
          id: 'clip-master',
          sourceArtifactId: 'artifact-master',
          sourceInFrame: 0,
          sourceOutFrame: 60,
          timelineInFrame: 0,
          timelineOutFrame: 60,
          rate: 1,
        },
        {
          id: 'clip-broll',
          sourceArtifactId: 'artifact-broll',
          audioSourceArtifactId: 'artifact-master',
          audioSourceInFrame: 60,
          audioSourceOutFrame: 120,
          sourceInFrame: 0,
          sourceOutFrame: 60,
          timelineInFrame: 60,
          timelineOutFrame: 120,
          rate: 1,
        },
      ],
      fps: 30,
      format: '16:9',
      transitions: [{
        id: 'transition-1',
        fromClipId: 'clip-master',
        toClipId: 'clip-broll',
        atFrame: 60,
        type: 'straight-cut',
        audioFadeMs: 40,
        reason: 'B-roll editorial comprovado.',
      }],
    })

    assert.equal(result.probe.width, 960)
    assert.equal(result.probe.height, 540)
    assert.equal(result.probe.audioCodec, 'aac')
    assert.ok(Math.abs(result.probe.duration - 4) <= 0.1)
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', result.outputPath,
      '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(audioAnalysis.status, 0, audioAnalysis.stderr)
    const peaks = [...audioAnalysis.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)]
    assert.ok(peaks.length >= 1, 'True-peak analysis must produce a summary')
    assert.ok(
      Number(peaks.at(-1)[1]) <= -1,
      `Rendered audio true peak must stay at or below -1 dBTP: ${peaks.at(-1)[1]}`,
    )
    const pixel = execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '3', '-i', result.outputPath,
      '-frames:v', '1', '-vf', 'scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { windowsHide: true })
    assert.equal(pixel.byteLength, 3)
    assert.ok(pixel[2] > pixel[0] * 2, 'Second scene must visibly use the blue B-roll source')

    const final = await renderer.render({
      operationId: 'multisource-final-fps-test',
      renderKind: 'final',
      outputSpec: { width: 1920, height: 1080, fps: 30 },
      sources: [
        { artifactId: 'artifact-master', path: masterPath, mediaType: 'video', colorPipelineCompilation: colorCompilation('artifact-master') },
      ],
      clips: [{
        id: 'clip-final',
        sourceArtifactId: 'artifact-master',
        sourceInFrame: 0,
        sourceOutFrame: 30,
        timelineInFrame: 0,
        timelineOutFrame: 30,
        rate: 1,
      }],
      fps: 30.0000001,
      format: '16:9',
    })
    assert.equal(final.probe.width, 1920)
    assert.equal(final.probe.height, 1080)
    assert.ok(Math.abs(final.probe.fps - 30) <= 0.01)
    await renderer.cleanup('multisource-render-test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-233 renderer applies a scoped normalized crop only inside the stale proxy range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-crop-range-render-'))
  const masterPath = join(root, 'split-color-master.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x360:r=30:d=3',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x360:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]',
      '-map', '[v]', '-map', '2:a:0', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
      masterPath,
    ], { windowsHide: true })
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'),
      ffmpegPath,
    })
    const source = {
      artifactId: 'artifact-crop-master', path: masterPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-crop-master'),
    }
    const base = await renderer.render({
      operationId: 'crop-range-base', renderKind: 'proxy',
      sources: [source],
      clips: [{
        id: 'clip-base', sourceArtifactId: source.artifactId,
        sourceInFrame: 0, sourceOutFrame: 90,
        timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
      }],
      fps: 30, format: '16:9',
    })
    const cropped = await renderer.render({
      operationId: 'crop-range-partial', renderKind: 'proxy',
      sources: [source],
      clips: [
        { id: 'clip-before', sourceArtifactId: source.artifactId, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
        {
          id: 'clip-cropped', sourceArtifactId: source.artifactId,
          sourceInFrame: 30, sourceOutFrame: 60,
          timelineInFrame: 30, timelineOutFrame: 60, rate: 1,
          crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
        },
        { id: 'clip-after', sourceArtifactId: source.artifactId, sourceInFrame: 60, sourceOutFrame: 90, timelineInFrame: 60, timelineOutFrame: 90, rate: 1 },
      ],
      fps: 30, format: '16:9',
      rangeReuse: {
        schemaVersion: 'project-proxy-range-reuse/v1',
        commandId: 'manual-command-crop-golden', impactHash: '2'.repeat(64),
        baseVersionId: 'project-version-crop-base',
        ranges: [{ startFrame: 30, endFrame: 60 }],
        artifactId: 'artifact-crop-base-proxy', manifestId: 'manifest-crop-base-proxy',
        path: base.outputPath, sha256: base.sha256, byteSize: base.byteSize,
      },
    })
    const rangeProbe = await probeVideo(
      join(root, 'work', 'crop-range-partial', 'editorial-proxy-range.mp4'),
    )
    assert.ok(Math.abs(rangeProbe.duration - 1) <= 0.1)
    assert.ok(Math.abs(cropped.probe.duration - 3) <= 0.1)
    for (const [second, dominantChannel] of [[0.5, 0], [1.5, 2], [2.5, 0]]) {
      const pixel = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', cropped.outputPath,
        '-frames:v', '1', '-vf', 'crop=2:2:240:270,scale=1:1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true })
      assert.equal(pixel.byteLength, 3)
      const other = dominantChannel === 0 ? 2 : 0
      assert.ok(pixel[dominantChannel] > pixel[other] * 2)
    }
    const basePresenter = cropped.renderElementMap.elements.find((item) =>
      item.type === 'presenter' && item.frame === 5)
    const cropPresenter = cropped.renderElementMap.elements.find((item) =>
      item.type === 'presenter' && item.frame === 45)
    assert.deepEqual(basePresenter.bounds, { x: 0, y: 0, width: 960, height: 540 })
    assert.deepEqual(cropPresenter.bounds, { x: 240, y: 0, width: 480, height: 540 })
    await renderer.cleanup('crop-range-partial')
    await renderer.cleanup('crop-range-base')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-233 renderer changes subtitle pixels only inside the stale cue range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-subtitle-range-render-'))
  const masterPath = join(root, 'subtitle-master.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', masterPath,
    ], { windowsHide: true })
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'),
      ffmpegPath,
    })
    const source = {
      artifactId: 'artifact-subtitle-master', path: masterPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-subtitle-master'),
    }
    const clips = [{
      id: 'clip-subtitle', sourceArtifactId: source.artifactId,
      sourceInFrame: 0, sourceOutFrame: 90,
      timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
    }]
    const base = await renderer.render({
      operationId: 'subtitle-range-base', renderKind: 'proxy', sources: [source], clips,
      fps: 30, format: '16:9',
      subtitleCues: [{ id: 'cue-manual', startFrame: 30, endFrame: 60, text: 'ANTES', anchor: 'bottom' }],
    })
    const revised = await renderer.render({
      operationId: 'subtitle-range-partial', renderKind: 'proxy', sources: [source], clips,
      fps: 30, format: '16:9',
      subtitleCues: [{ id: 'cue-manual', startFrame: 30, endFrame: 60, text: 'DEPOIS REVISADO', anchor: 'bottom' }],
      rangeReuse: {
        schemaVersion: 'project-proxy-range-reuse/v1',
        commandId: 'manual-command-subtitle-golden', impactHash: '3'.repeat(64),
        baseVersionId: 'project-version-subtitle-base',
        ranges: [{ startFrame: 30, endFrame: 60 }],
        artifactId: 'artifact-subtitle-base-proxy', manifestId: 'manifest-subtitle-base-proxy',
        path: base.outputPath, sha256: base.sha256, byteSize: base.byteSize,
      },
    })
    const sample = (path, second) => execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
      '-frames:v', '1', '-vf', 'scale=240:135',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { windowsHide: true })
    assert.deepEqual(sample(revised.outputPath, 0.5), sample(base.outputPath, 0.5))
    assert.notDeepEqual(sample(revised.outputPath, 1.5), sample(base.outputPath, 1.5))
    assert.deepEqual(sample(revised.outputPath, 2.5), sample(base.outputPath, 2.5))
    const rangeProbe = await probeVideo(
      join(root, 'work', 'subtitle-range-partial', 'editorial-proxy-range.mp4'),
    )
    assert.ok(Math.abs(rangeProbe.duration - 1) <= 0.1)
    assert.ok(Math.abs(revised.probe.duration - 3) <= 0.1)
    assert.equal(revised.renderElementMap.elements.some((item) =>
      item.type === 'subtitle' && item.frame === 15), false)
    assert.equal(revised.renderElementMap.elements.some((item) =>
      item.type === 'subtitle' && item.frame === 45), true)
    await renderer.cleanup('subtitle-range-partial')
    await renderer.cleanup('subtitle-range-base')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-233 renderer recomposes only the stale range and reuses valid proxy prefix and suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-range-reuse-render-'))
  const masterPath = join(root, 'master.mp4')
  const replacementPath = join(root, 'replacement.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', masterPath,
    ], { windowsHide: true })
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', replacementPath,
    ], { windowsHide: true })
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'),
      ffmpegPath,
    })
    const masterSource = {
      artifactId: 'artifact-range-master', path: masterPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-range-master'),
    }
    const base = await renderer.render({
      operationId: 'range-reuse-base', renderKind: 'proxy',
      sources: [masterSource],
      clips: [{
        id: 'clip-base', sourceArtifactId: masterSource.artifactId,
        sourceInFrame: 0, sourceOutFrame: 90,
        timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
      }],
      fps: 30, format: '16:9',
    })
    const partial = await renderer.render({
      operationId: 'range-reuse-partial', renderKind: 'proxy',
      sources: [masterSource, {
        artifactId: 'artifact-range-replacement', path: replacementPath, mediaType: 'video',
        colorPipelineCompilation: colorCompilation('artifact-range-replacement'),
      }],
      clips: [
        { id: 'clip-prefix', sourceArtifactId: masterSource.artifactId, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
        { id: 'clip-replacement', sourceArtifactId: 'artifact-range-replacement', audioSourceArtifactId: masterSource.artifactId, audioSourceInFrame: 30, audioSourceOutFrame: 60, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
        { id: 'clip-suffix', sourceArtifactId: masterSource.artifactId, sourceInFrame: 60, sourceOutFrame: 90, timelineInFrame: 60, timelineOutFrame: 90, rate: 1 },
      ],
      fps: 30, format: '16:9',
      rangeReuse: {
        schemaVersion: 'project-proxy-range-reuse/v1',
        commandId: 'manual-command-range-golden', impactHash: '1'.repeat(64),
        baseVersionId: 'project-version-range-base',
        ranges: [{ startFrame: 30, endFrame: 60 }],
        artifactId: 'artifact-range-base-proxy', manifestId: 'manifest-range-base-proxy',
        path: base.outputPath, sha256: base.sha256, byteSize: base.byteSize,
      },
    })
    const rangeProbe = await probeVideo(
      join(root, 'work', 'range-reuse-partial', 'editorial-proxy-range.mp4'),
    )
    assert.ok(Math.abs(rangeProbe.duration - 1) <= 0.1)
    assert.ok(Math.abs(partial.probe.duration - 3) <= 0.1)
    for (const [second, dominantChannel] of [[0.5, 0], [1.5, 2], [2.5, 0]]) {
      const pixel = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', partial.outputPath,
        '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true })
      assert.equal(pixel.byteLength, 3)
      const other = dominantChannel === 0 ? 2 : 0
      assert.ok(pixel[dominantChannel] > pixel[other] * 2)
    }
    await renderer.cleanup('range-reuse-partial')
    await renderer.cleanup('range-reuse-base')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
