import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createManualCommandImpact, createReviewPatchCommandImpact } from '../../src/v2/domain/command-impact.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createDesiredAction, createDesiredActionReference } from '../../src/v2/domain/desired-action.ts'
import { materializeManualEditPlan } from '../../src/v2/domain/manual-editing.ts'
import { materializePatchEditPlan } from '../../src/v2/domain/review-system.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
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

test('T-FR-011 renderer materializes the canonical visual CTA and maps its exact frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-desired-action-render-'))
  const sourcePath = join(root, 'source.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=960x540:r=30:d=3',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', sourcePath,
    ], { windowsHide: true })
    const action = createDesiredAction({
      objective: 'sale',
      desiredAction: {
        destination: { type: 'url', value: 'https://checkout.example/oferta' },
        verbalCta: 'Compre agora', visualCta: 'COMPRAR AGORA',
        disclosures: ['Condições no site'],
      },
    })
    const desiredActionRef = createDesiredActionReference(action)
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'), ffmpegPath,
    })
    const result = await renderer.render({
      operationId: 'desired-action-render-test', renderKind: 'proxy',
      sources: [{
        artifactId: 'artifact-cta-source', path: sourcePath, mediaType: 'video',
        colorPipelineCompilation: colorCompilation('artifact-cta-source'),
      }],
      clips: [{
        id: 'clip-cta-source', sourceArtifactId: 'artifact-cta-source',
        sourceInFrame: 0, sourceOutFrame: 90,
        timelineInFrame: 0, timelineOutFrame: 90, rate: 1,
      }],
      fps: 30, format: '16:9',
      ctaOverlays: [{
        id: `overlay-${desiredActionRef.id}`, kind: 'cta', desiredActionRef,
        startFrame: 60, endFrame: 90, text: action.visualCta,
      }],
    })
    const sample = (second) => execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(second),
      '-i', result.outputPath, '-frames:v', '1',
      '-vf', 'crop=760:110:100:20', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { windowsHide: true })
    const countNonBlack = (buffer) => {
      let pixels = 0
      for (let index = 0; index < buffer.length; index += 3) {
        if (buffer[index] + buffer[index + 1] + buffer[index + 2] > 90) pixels += 1
      }
      return pixels
    }
    assert.ok(countNonBlack(sample(2.5)) > countNonBlack(sample(1)) + 500)
    const ctaElements = result.renderElementMap.elements.filter((item) => item.type === 'cta')
    assert.equal(ctaElements.length, 30)
    assert.equal(ctaElements[0].frame, 60)
    assert.equal(ctaElements.at(-1).frame, 89)
    assert.equal(ctaElements.every((item) => item.sourceId === `overlay-${desiredActionRef.id}`), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

test('T-FR-233 applied review patch changes subtitle pixels only inside its frame-first stale range', async () => {
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
    const beforePlan = {
      schemaVersion: 2, state: 'compiled', id: 'edit-plan-review-subtitle-base',
      projectVersionId: 'project-version-review-subtitle-base', fps: 30, durationFrames: 90,
      videoTracks: [{ id: 'base-video', kind: 'base-video', clips }],
      subtitleTracks: [{ id: 'captions', kind: 'captions', cues: [
        { id: 'cue-manual', startFrame: 30, endFrame: 60, text: 'ANTES', anchor: 'bottom' },
      ] }],
      composition: { layout: 'fit', background: 'black', foregroundScale: 1, verticalPosition: 0.5 },
      createdAt: '2026-08-01T01:10:00.000Z',
    }
    const patch = {
      id: 'review-patch-subtitle-golden', baseVersionId: beforePlan.projectVersionId,
      operations: [{ op: 'update-text', targetId: 'subtitle:cue-manual', value: { text: 'DEPOIS REVISADO' }, rangeMs: [1000, 2000] }],
      annotationIds: ['annotation-review-subtitle-golden'], estimatedCost: 0,
      invalidatedRanges: [[1000, 2000]],
    }
    const afterPlan = materializePatchEditPlan({
      editPlan: beforePlan, patch, newVersionId: 'project-version-review-subtitle-result',
      createdAt: '2026-08-01T01:11:00.000Z',
    })
    const impact = createReviewPatchCommandImpact({
      commandId: 'review-command-subtitle-golden',
      baseVersionId: beforePlan.projectVersionId,
      resultVersionId: afterPlan.projectVersionId,
      variantIds: ['16:9'], operations: patch.operations,
      invalidatedRangesMs: patch.invalidatedRanges,
      beforeEditPlan: beforePlan, afterEditPlan: afterPlan,
      outputReferences: [{
        artifactId: 'artifact-subtitle-base-proxy', kind: 'proxy',
        sourceVersionId: beforePlan.projectVersionId, variantId: '16:9',
      }],
    })
    assert.deepEqual(impact.affectedRanges, [{ startFrame: 30, endFrame: 60 }])
    const base = await renderer.render({
      operationId: 'subtitle-range-base', renderKind: 'proxy', sources: [source], clips,
      fps: 30, format: '16:9',
      subtitleCues: beforePlan.subtitleTracks[0].cues,
    })
    const revised = await renderer.render({
      operationId: 'subtitle-range-partial', renderKind: 'proxy', sources: [source], clips: afterPlan.videoTracks[0].clips,
      fps: 30, format: '16:9',
      subtitleCues: afterPlan.subtitleTracks[0].cues,
      rangeReuse: {
        schemaVersion: 'project-proxy-range-reuse/v1',
        commandId: impact.commandId, impactHash: impact.impactHash,
        baseVersionId: impact.baseVersionId,
        ranges: impact.minimalRenders[0].ranges,
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

test('T-FR-233 materialized B-roll replacement recomposes only its stale range', async () => {
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
    const beforePlan = {
      schemaVersion: 2, state: 'compiled', id: 'edit-plan-broll-base',
      projectVersionId: 'project-version-range-base', fps: 30, durationFrames: 90,
      videoTracks: [{ id: 'base-video', kind: 'base-video', clips: [
        { id: 'clip-prefix', sourceArtifactId: masterSource.artifactId, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
        { id: 'clip-middle', sourceArtifactId: masterSource.artifactId, sourceInFrame: 30, sourceOutFrame: 60, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
        { id: 'clip-suffix', sourceArtifactId: masterSource.artifactId, sourceInFrame: 60, sourceOutFrame: 90, timelineInFrame: 60, timelineOutFrame: 90, rate: 1 },
      ] }],
      subtitleTracks: [],
      createdAt: '2026-07-31T08:00:00.000Z',
    }
    const operation = {
      kind: 'replace', clipId: 'clip-middle', sourceId: 'artifact-range-replacement',
    }
    const afterPlan = materializeManualEditPlan({
      editPlan: beforePlan, operation,
      newVersionId: 'project-version-range-result',
      createdAt: '2026-07-31T08:01:00.000Z',
      availableAssetIds: [masterSource.artifactId, operation.sourceId],
      variantId: '16:9',
    })
    const impact = createManualCommandImpact({
      commandId: 'manual-command-range-golden',
      baseVersionId: beforePlan.projectVersionId,
      resultVersionId: afterPlan.projectVersionId,
      variantId: '16:9', targetId: operation.clipId, action: 'apply', operation,
      beforeEditPlan: beforePlan, afterEditPlan: afterPlan,
      outputReferences: [{
        artifactId: 'artifact-range-base-proxy', kind: 'proxy',
        sourceVersionId: beforePlan.projectVersionId, variantId: '16:9',
      }],
    })
    assert.deepEqual(impact.changeKinds, ['replace-source'])
    assert.deepEqual(impact.affectedRanges, [{ startFrame: 30, endFrame: 60 }])
    const replacementClip = afterPlan.videoTracks[0].clips.find((clip) => clip.id === operation.clipId)
    assert.equal(replacementClip.audioSourceArtifactId, masterSource.artifactId)
    assert.deepEqual(
      [replacementClip.audioSourceInFrame, replacementClip.audioSourceOutFrame],
      [30, 60],
    )
    const partial = await renderer.render({
      operationId: 'range-reuse-partial', renderKind: 'proxy',
      sources: [masterSource, {
        artifactId: 'artifact-range-replacement', path: replacementPath, mediaType: 'video',
        colorPipelineCompilation: colorCompilation('artifact-range-replacement'),
      }],
      clips: afterPlan.videoTracks[0].clips,
      fps: 30, format: '16:9',
      rangeReuse: {
        schemaVersion: 'project-proxy-range-reuse/v1',
        commandId: impact.commandId, impactHash: impact.impactHash,
        baseVersionId: impact.baseVersionId,
        ranges: impact.minimalRenders[0].ranges,
        artifactId: 'artifact-range-base-proxy', manifestId: 'manifest-range-base-proxy',
        path: base.outputPath, sha256: base.sha256, byteSize: base.byteSize,
      },
    })
    const rangeProbe = await probeVideo(
      join(root, 'work', 'range-reuse-partial', 'editorial-proxy-range.mp4'),
    )
    assert.ok(Math.abs(rangeProbe.duration - 1) <= 0.1)
    assert.ok(Math.abs(partial.probe.duration - 3) <= 0.1)
    assert.equal(partial.probe.audioCodec, 'aac')
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

test('T-FR-233 renderer re-renders two disjoint stale ranges and reuses every frame between them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-multi-range-render-'))
  const masterPath = join(root, 'master.mp4')
  const greenPath = join(root, 'green.mp4')
  const bluePath = join(root, 'blue.mp4')
  try {
    // 6s red master with audio: 180 frames at 30fps.
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', masterPath,
    ], { windowsHide: true })
    for (const [color, path] of [['green', greenPath], ['blue', bluePath]]) {
      execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=1`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
      ], { windowsHide: true })
    }
    const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
    const master = {
      artifactId: 'artifact-multi-master', path: masterPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-multi-master'),
    }
    const green = {
      artifactId: 'artifact-multi-green', path: greenPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-multi-green'),
    }
    const blue = {
      artifactId: 'artifact-multi-blue', path: bluePath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-multi-blue'),
    }
    const base = await renderer.render({
      operationId: 'multi-range-base', renderKind: 'proxy',
      sources: [master],
      clips: [{
        id: 'clip-base', sourceArtifactId: master.artifactId,
        sourceInFrame: 0, sourceOutFrame: 180,
        timelineInFrame: 0, timelineOutFrame: 180, rate: 1,
      }],
      fps: 30, format: '16:9',
    })

    // Two stale ranges, frames [30,60) and [120,150), each replaced by a
    // different colour. Everything else must come from the base proxy.
    const partial = await renderer.render({
      operationId: 'multi-range-partial', renderKind: 'proxy',
      sources: [master, green, blue],
      clips: [
        { id: 'clip-1', sourceArtifactId: master.artifactId, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
        { id: 'clip-2', sourceArtifactId: green.artifactId, audioSourceArtifactId: master.artifactId, audioSourceInFrame: 30, audioSourceOutFrame: 60, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 30, timelineOutFrame: 60, rate: 1 },
        { id: 'clip-3', sourceArtifactId: master.artifactId, sourceInFrame: 60, sourceOutFrame: 120, timelineInFrame: 60, timelineOutFrame: 120, rate: 1 },
        { id: 'clip-4', sourceArtifactId: blue.artifactId, audioSourceArtifactId: master.artifactId, audioSourceInFrame: 120, audioSourceOutFrame: 150, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 120, timelineOutFrame: 150, rate: 1 },
        { id: 'clip-5', sourceArtifactId: master.artifactId, sourceInFrame: 150, sourceOutFrame: 180, timelineInFrame: 150, timelineOutFrame: 180, rate: 1 },
      ],
      fps: 30, format: '16:9',
      rangeReuse: {
        schemaVersion: 'project-proxy-range-reuse/v1',
        commandId: 'manual-command-multi-range-golden', impactHash: '5'.repeat(64),
        baseVersionId: 'project-version-multi-base',
        ranges: [{ startFrame: 30, endFrame: 60 }, { startFrame: 120, endFrame: 150 }],
        artifactId: 'artifact-multi-base-proxy', manifestId: 'manifest-multi-base-proxy',
        path: base.outputPath, sha256: base.sha256, byteSize: base.byteSize,
      },
    })

    // One composition file per stale range, each exactly one second long.
    for (const index of [0, 1]) {
      const rangeProbe = await probeVideo(
        join(root, 'work', 'multi-range-partial', `editorial-proxy-range-0${index}.mp4`),
      )
      assert.ok(
        Math.abs(rangeProbe.duration - 1) <= 0.1,
        `range ${index} must last one second, got ${rangeProbe.duration}`,
      )
    }
    // Full timeline length and audio survive the interleaved stitch.
    assert.ok(Math.abs(partial.probe.duration - 6) <= 0.1, `expected 6s, got ${partial.probe.duration}`)
    assert.ok(Math.abs(partial.probe.fps - 30) <= 0.01)
    assert.equal(partial.probe.width, 960)
    assert.equal(partial.probe.height, 540)
    assert.equal(partial.probe.audioCodec, 'aac')
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', partial.outputPath,
      '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(audioAnalysis.status, 0, audioAnalysis.stderr)
    assert.ok([...audioAnalysis.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)].length >= 1)

    // Colour proof: red before, green in range A, red in the GAP BETWEEN the two
    // ranges, blue in range B, red after. The gap is the multi-range payoff.
    const channelAt = (second) => {
      const pixel = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', partial.outputPath,
        '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true })
      assert.equal(pixel.byteLength, 3)
      return [pixel[0], pixel[1], pixel[2]]
    }
    for (const [second, dominant, label] of [
      [0.5, 0, 'base prefix'],
      [1.5, 1, 'stale range A'],
      [2.5, 0, 'reused gap'],
      [3.5, 0, 'reused gap'],
      [4.5, 2, 'stale range B'],
      [5.5, 0, 'base suffix'],
    ]) {
      const channels = channelAt(second)
      for (const other of [0, 1, 2].filter((index) => index !== dominant)) {
        assert.ok(
          channels[dominant] > channels[other] * 2 + 8,
          `${label} at ${second}s must be dominated by channel ${dominant}: ${channels}`,
        )
      }
    }

    // Byte proof: untouched regions are the reused base pixels, not a re-render.
    const sample = (path, second) => execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
      '-frames:v', '1', '-vf', 'scale=240:135', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { windowsHide: true })
    for (const second of [0.5, 2.5, 3.5, 5.5]) {
      assert.deepEqual(
        sample(partial.outputPath, second),
        sample(base.outputPath, second),
        `frames at ${second}s must be reused byte-for-byte from the base proxy`,
      )
    }
    for (const second of [1.5, 4.5]) {
      assert.notDeepEqual(sample(partial.outputPath, second), sample(base.outputPath, second))
    }
    await renderer.cleanup('multi-range-partial')
    await renderer.cleanup('multi-range-base')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-233 renderer retimes clips faster and slower with exact frame counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-rate-render-'))
  const masterPath = join(root, 'timed-master.mp4')
  try {
    // 6s master built from three 2s colour segments so retiming is observable:
    // red 0-2s, green 2-4s, blue 4-6s. 180 frames at 30fps.
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-map', '3:a:0', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
      masterPath,
    ], { windowsHide: true })
    const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
    const master = {
      artifactId: 'artifact-rate-master', path: masterPath, mediaType: 'video',
      colorPipelineCompilation: colorCompilation('artifact-rate-master'),
    }
    // 150 source frames (5s) become 120 timeline frames (4s): 120 source frames
    // at rate 2 give 60, and 30 source frames at rate 0.5 give 60.
    const retimed = await renderer.render({
      operationId: 'rate-retimed', renderKind: 'proxy',
      sources: [master],
      clips: [
        {
          id: 'clip-fast', sourceArtifactId: master.artifactId,
          sourceInFrame: 0, sourceOutFrame: 120,
          timelineInFrame: 0, timelineOutFrame: 60, rate: 2,
        },
        {
          id: 'clip-slow', sourceArtifactId: master.artifactId,
          sourceInFrame: 120, sourceOutFrame: 150,
          timelineInFrame: 60, timelineOutFrame: 120, rate: 0.5,
        },
      ],
      fps: 30, format: '16:9',
    })

    // Numeric proof: 5 seconds of source became exactly 4 seconds of timeline.
    assert.ok(
      Math.abs(retimed.probe.duration - 4) <= 0.1,
      `retimed proxy must last 4s, got ${retimed.probe.duration}`,
    )
    assert.ok(Math.abs(retimed.probe.fps - 30) <= 0.01)
    const counted = execFileSync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', retimed.outputPath,
    ], { encoding: 'utf8', windowsHide: true }).trim()
    assert.ok(
      Math.abs(Number(counted) - 120) <= 3,
      `retimed proxy must hold 120 frames, ffprobe counted ${counted}`,
    )
    assert.equal(retimed.renderElementMap.durationFrames, 120)
    assert.equal(retimed.probe.audioCodec, 'aac')
    const audioAnalysis = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', retimed.outputPath,
      '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(audioAnalysis.status, 0, audioAnalysis.stderr)
    assert.ok(
      [...audioAnalysis.stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)].length >= 1,
      'retimed audio must survive the atempo chain',
    )

    // Visual proof of the mapping. Doubled speed folds source 0-2s (red) into
    // output 0-1s and source 2-4s (green) into output 1-2s; half speed stretches
    // source 4-5s (blue) across output 2-4s.
    const channelAt = (second) => {
      const pixel = execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', retimed.outputPath,
        '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { windowsHide: true })
      assert.equal(pixel.byteLength, 3)
      return [pixel[0], pixel[1], pixel[2]]
    }
    for (const [second, dominant, label] of [
      [0.5, 0, 'red at double speed'],
      [1.5, 1, 'green at double speed'],
      [2.5, 2, 'blue at half speed'],
      [3.5, 2, 'blue still on screen at half speed'],
    ]) {
      const channels = channelAt(second)
      for (const other of [0, 1, 2].filter((index) => index !== dominant)) {
        assert.ok(
          channels[dominant] > channels[other] * 2 + 8,
          `${label} at ${second}s must be dominated by channel ${dominant}: ${channels}`,
        )
      }
    }

    // Control: the same source spans at rate 1 last 5s, not 4s.
    const realTime = await renderer.render({
      operationId: 'rate-real-time', renderKind: 'proxy',
      sources: [master],
      clips: [{
        id: 'clip-real', sourceArtifactId: master.artifactId,
        sourceInFrame: 0, sourceOutFrame: 150,
        timelineInFrame: 0, timelineOutFrame: 150, rate: 1,
      }],
      fps: 30, format: '16:9',
    })
    assert.ok(
      Math.abs(realTime.probe.duration - 5) <= 0.1,
      `real-time control must last 5s, got ${realTime.probe.duration}`,
    )
    await renderer.cleanup('rate-retimed')
    await renderer.cleanup('rate-real-time')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
