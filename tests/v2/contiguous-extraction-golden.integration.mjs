import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  calculateContiguousMomentEvaluationHash,
  extractContiguous,
} from '../../src/v2/domain/contiguous-extraction.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)
const hex = (value) => value.repeat(64).slice(0, 64)
const colorMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
  range: 'limited', bitDepth: 8,
})

function colorCompilation(artifactId) {
  const manifestId = 'manifest-two-hour-golden'
  const probe = createMediaColorProbe({
    id: 'probe-two-hour-golden', workspaceId: 'workspace-two-hour-golden',
    artifactId, manifestId,
    detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
    createdAt: '2026-08-02T12:00:00.000Z',
  })
  const implementation = (provider, parameters) => ({
    provider, version: 'v1', parameters,
    parametersHash: calculateCanonicalHash(parameters),
  })
  return createColorPipelineCompilation({
    id: 'compilation-two-hour-golden', workspaceId: probe.workspaceId,
    projectId: 'project-two-hour-golden', sourceArtifactId: artifactId,
    sourceManifestId: manifestId, probe, outputMetadata: colorMetadata,
    createdByClientId: 'client-two-hour-golden', createdAt: '2026-08-02T12:01:00.000Z',
    stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: colorMetadata, output: colorMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: colorMetadata, output: colorMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ],
  })
}

function quality(value, evidenceRef) {
  return { value, evidenceRefs: [evidenceRef] }
}

function evaluatedMoment({
  id,
  sourceSha256,
  rangeMs,
  score,
}) {
  const body = {
    id,
    momentHash: hex(id.endsWith('selected') ? 'a' : 'b'),
    evaluationId: `${id}:evaluation`,
    indexRunId: 'long-form-index-run-golden',
    sourceArtifactId: 'artifact-two-hour-golden',
    sourceArtifactSha256: sourceSha256,
    sourceManifestId: 'manifest-two-hour-golden',
    sourceManifestHash: hex('c'),
    chapterId: 'chapter-offer-golden',
    topic: 'oferta de entrada',
    objectiveTags: ['discovery'],
    recommendedRangeMs: rangeMs,
    semanticRangeMs: rangeMs,
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-two-hour-golden',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    scores: {
      selfContained: quality(score, `${id}:self-contained`),
      density: quality(score, `${id}:density`),
      integrity: quality(1, `${id}:integrity`),
      audio: quality(score, `${id}:audio`),
      visual: quality(score, `${id}:visual`),
    },
    evaluationProducer: {
      provider: 'apollo',
      model: 'contiguous-evidence-policy',
      version: '1.0.0',
      inputHash: hex('d'),
      outputHash: hex(id.endsWith('selected') ? 'e' : 'f'),
    },
  }
  return {
    ...body,
    evaluationHash: calculateContiguousMomentEvaluationHash({
      momentId: body.id,
      momentHash: body.momentHash,
      indexRunId: body.indexRunId,
      objectiveTags: body.objectiveTags,
      semanticRangeMs: body.semanticRangeMs,
      scores: body.scores,
      producer: body.evaluationProducer,
    }),
  }
}

async function samplePixel(filePath, seconds) {
  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  )
  assert.equal(stdout.byteLength, 3)
  return [...stdout]
}

function assertGold(pixel, label) {
  const [red, green, blue] = pixel
  assert.ok(
    red >= 170 && green >= 120 && blue <= 110,
    `${label} must preserve the gold semantic window; got rgb(${pixel.join(',')})`,
  )
}

function assertDark(pixel, label) {
  assert.ok(
    Math.max(...pixel) <= 55,
    `${label} must remain outside the selected semantic window; got rgb(${pixel.join(',')})`,
  )
}

test(
  'T-FR-134 golden materializes one exact two-minute MP4 from a real two-hour master',
  { timeout: 120_000 },
  async () => {
    assert.equal(typeof ffmpegPath, 'string')
    const root = await mkdtemp(
      join(tmpdir(), 'apollo-contiguous-two-hour-golden-'),
    )
    const masterPath = join(root, 'two-hour-master.mp4')
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'render-work'),
      ffmpegPath,
    })
    try {
      await execFileAsync(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          [
            'color=c=#10151b:s=160x90:r=1:d=7200',
            "drawbox=x=0:y=0:w=iw:h=ih:color=#d9aa3d:t=fill:enable='between(t,3540,3660)'",
          ].join(','),
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=16000:cl=mono:d=7200',
          '-shortest',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-tune',
          'stillimage',
          '-g',
          '1',
          '-keyint_min',
          '1',
          '-sc_threshold',
          '0',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '16k',
          '-ar',
          '16000',
          masterPath,
        ],
        {
          windowsHide: true,
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
        },
      )

      const [masterProbe, sourceSha256] = await Promise.all([
        probeVideo(masterPath, { requireAudio: true }),
        calculateFileSha256(masterPath),
      ])
      assert.ok(Math.abs(masterProbe.duration - 7_200) <= 0.1)
      assert.equal(masterProbe.fps, 1)
      assertDark(
        await samplePixel(masterPath, 3_539),
        'frame before the semantic window',
      )
      assertGold(
        await samplePixel(masterPath, 3_541),
        'frame inside the semantic window',
      )
      assertDark(
        await samplePixel(masterPath, 3_661),
        'frame after the semantic window',
      )

      const extraction = extractContiguous({
        id: 'contiguous-extraction-two-hour-golden',
        workspaceId: 'workspace-two-hour-golden',
        projectId: 'project-two-hour-golden',
        objective: 'discovery',
        topic: 'oferta de entrada',
        targetDurationMs: 120_000,
        toleranceMs: 0,
        fps: 1,
        moments: [
          evaluatedMoment({
            id: 'moment-distractor',
            sourceSha256,
            rangeMs: [120_000, 240_000],
            score: 0.62,
          }),
          evaluatedMoment({
            id: 'moment-selected',
            sourceSha256,
            rangeMs: [3_540_000, 3_660_000],
            score: 0.94,
          }),
        ],
      })
      const clip = extraction.editPlan.videoTracks[0].clips[0]
      assert.equal(extraction.storyPlan.mode, 'contiguous')
      assert.equal(extraction.storyPlan.blocks.length, 1)
      assert.equal(extraction.editPlan.videoTracks[0].clips.length, 1)
      assert.equal(extraction.editPlan.durationFrames, 120)
      assert.equal(extraction.editPlan.synthesizedRanges, false)
      assert.equal(
        extraction.editPlan.movementPolicy.automaticZoom,
        false,
      )
      assert.deepEqual(
        [clip.sourceInFrame, clip.sourceOutFrame],
        [3_540, 3_660],
      )

      const rendered = await renderer.render({
        operationId: 'fr134-two-hour-golden',
        renderKind: 'proxy',
        sources: [
          {
            artifactId: 'artifact-two-hour-golden',
            path: masterPath,
            mediaType: 'video',
            colorPipelineCompilation: colorCompilation('artifact-two-hour-golden'),
          },
        ],
        clips: [clip],
        fps: extraction.editPlan.fps,
        format: '16:9',
      })
      assert.ok(Math.abs(rendered.probe.duration - 120) <= 0.1)
      assert.equal(rendered.probe.width, 960)
      assert.equal(rendered.probe.height, 540)
      assert.equal(rendered.probe.audioCodec, 'aac')
      assertGold(await samplePixel(rendered.outputPath, 1), 'golden start')
      assertGold(await samplePixel(rendered.outputPath, 60), 'golden middle')
      assertGold(await samplePixel(rendered.outputPath, 119), 'golden end')
      assert.match(rendered.sha256, /^[a-f0-9]{64}$/)
      assert.ok(rendered.byteSize > 0)
    } finally {
      await renderer.cleanup('fr134-two-hour-golden')
      await rm(root, { recursive: true, force: true })
    }
  },
)
