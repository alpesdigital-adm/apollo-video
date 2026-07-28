import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  createSourceDeconstructionReport,
} from '../../src/v2/domain/source-deconstruction.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/source-deconstruction',
)
const manifestPath = join(
  fixtureDirectory,
  'reel-published-golden.json',
)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const videoPath = join(fixtureDirectory, manifest.file)
const video = readFileSync(videoPath)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function frameAt(seconds, filter) {
  return execFileSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      ...(filter ? ['-vf', filter] : []),
      '-pix_fmt',
      filter ? 'gray' : 'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'buffer',
    },
  )
}

test('T-FR-120 Golden Reel is a real deterministic published audiovisual fixture', () => {
  assert.equal(sha256(video), manifest.sha256)
  assert.equal(video.byteLength, manifest.byteSize)

  const probe = JSON.parse(execFileSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      videoPath,
    ],
    { windowsHide: true, encoding: 'utf8' },
  ))
  const videoStream = probe.streams.find((stream) =>
    stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream) =>
    stream.codec_type === 'audio')
  assert.equal(videoStream.codec_name, manifest.technical.videoCodec)
  assert.equal(videoStream.width, manifest.technical.width)
  assert.equal(videoStream.height, manifest.technical.height)
  assert.equal(videoStream.avg_frame_rate, '30/1')
  assert.equal(Number(videoStream.nb_frames), 186)
  assert.equal(audioStream.codec_name, manifest.technical.audioCodec)
  assert.equal(Number(audioStream.sample_rate), 48_000)
  assert.equal(Number(probe.format.duration) * 1_000, 6_200)
})

test('T-FR-120 Golden Reel proves five distinct phases and burned captions in pixels', () => {
  const phaseMidpoints = [0.45, 1.5, 3.15, 4.55, 5.65]
  const frameHashes = phaseMidpoints.map((seconds) =>
    sha256(frameAt(seconds)))
  assert.equal(new Set(frameHashes).size, phaseMidpoints.length)

  for (const seconds of phaseMidpoints) {
    const captionPixels = frameAt(
      seconds,
      'crop=280:100:20:420',
    )
    let dark = 0
    let bright = 0
    for (const value of captionPixels) {
      if (value < 55) dark += 1
      if (value > 190) bright += 1
    }
    assert.ok(dark > 1_000, `caption box missing at ${seconds}s`)
    assert.ok(bright > 100, `burned text missing at ${seconds}s`)
  }
})

test('T-FR-120 Golden Reel deconstruction removes wrapper, body, CTA and tail while retaining the validated hook', () => {
  const report = createSourceDeconstructionReport({
    id: 'source-deconstruction-golden-reel',
    workspaceId: 'workspace-golden-reel',
    projectId: 'project-golden-reel',
    sourceArtifactId: 'artifact-golden-reel',
    sourceArtifactSha256: manifest.sha256,
    sourceTranscriptId: 'transcript-golden-reel',
    sourceTranscriptHash: sha256(
      manifest.timeline.map((segment) =>
        segment.exactText).join(' '),
    ),
    sourceDurationMs: manifest.technical.durationMs,
    desiredRole:
      manifest.expectedHookDeconstruction.desiredRole,
    validationScope: 'full',
    targetComposition: {
      objective: 'content-distribution',
      outputSpecId: '9:16',
      targetDurationMs: 15_000,
    },
    boundaryPolicy: {
      preRollMs: 120,
      postRollMs: 160,
      maxJoinGapMs: 250,
      maxContextGapMs: 500,
      minCompleteThoughtScore: 0.7,
    },
    speechEvidence: manifest.timeline.map((segment) => ({
      id: `speech-golden-${segment.role}`,
      sourceSegmentId: segment.sourceSegmentId,
      exactText: segment.exactText,
      normalizedText: segment.exactText.toLowerCase()
        .replaceAll(/[^a-z0-9 ]/g, ''),
      rangeMs: segment.rangeMs,
      completeThoughtScore: segment.completeThoughtScore,
      classification: segment.classification,
      intentions: [{
        value: segment.intention,
        confidence: 0.99,
        provenance: 'golden-reel-manifest/v1',
      }],
      segmentHash: sha256(
        `${segment.sourceSegmentId}:${segment.exactText}`,
      ),
    })),
    createdByClientId: 'client-golden-reel',
    createdAt: '2026-07-28T16:00:00.000Z',
  })

  assert.deepEqual(
    report.cleanCandidateRanges.map((range) => range.rangeMs),
    [manifest.expectedHookDeconstruction.cleanRangeMs],
  )
  assert.deepEqual(
    report.cleanCandidateRanges[0].speechRangeMs,
    manifest.expectedHookDeconstruction.speechRangeMs,
  )
  assert.deepEqual(
    report.comparison.removedRangesMs,
    manifest.expectedHookDeconstruction.removedRangesMs,
  )
  assert.equal(
    report.segments.find((segment) =>
      segment.role === 'opening').included,
    false,
  )
  assert.equal(
    report.segments.find((segment) =>
      segment.role === 'hook').included,
    true,
  )
  assert.deepEqual(
    report.semanticContaminants.map((item) => item.kind),
    manifest.expectedHookDeconstruction.contaminantKinds,
  )
  assert.equal(report.contextPreserved, true)
  assert.equal(report.decision, 'automatic')
})
