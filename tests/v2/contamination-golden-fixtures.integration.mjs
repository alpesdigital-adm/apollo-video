import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  createContaminationReport,
} from '../../src/v2/domain/contamination-report.ts'
import {
  createSourceDeconstructionReport,
} from '../../src/v2/domain/source-deconstruction.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/contamination',
)
const manifest = JSON.parse(readFileSync(
  join(fixtureDirectory, 'contamination-goldens.json'),
  'utf8',
))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function frame(fixture, filter, pixelFormat = 'rgb24') {
  return execFileSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      '1',
      '-i',
      join(fixtureDirectory, fixture.file),
      '-frames:v',
      '1',
      ...(filter ? ['-vf', filter] : []),
      '-pix_fmt',
      pixelFormat,
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

function audioRms(fixture) {
  const audio = execFileSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      join(fixtureDirectory, fixture.file),
      '-map',
      '0:a:0',
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      '48000',
      'pipe:1',
    ],
    {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'buffer',
    },
  )
  let sum = 0
  const samples = audio.length / 2
  for (let offset = 0; offset < audio.length; offset += 2) {
    const value = audio.readInt16LE(offset) / 32_768
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}

function sourceReport(fixture) {
  return createSourceDeconstructionReport({
    id: `source-${fixture.id}`,
    workspaceId: 'workspace-contamination-golden',
    projectId: 'project-contamination-golden',
    sourceArtifactId: `artifact-${fixture.id}`,
    sourceArtifactSha256: fixture.sha256,
    sourceTranscriptId: `transcript-${fixture.id}`,
    sourceTranscriptHash: sha256(fixture.id),
    sourceDurationMs: fixture.technical.durationMs,
    desiredRole: 'hook',
    validationScope: 'opening-edit',
    targetComposition: {
      objective: 'content-distribution',
      outputSpecId: '9:16',
      targetDurationMs: 15_000,
    },
    boundaryPolicy: {
      preRollMs: 0,
      postRollMs: 0,
      maxJoinGapMs: 0,
      maxContextGapMs: 0,
      minCompleteThoughtScore: 0.7,
    },
    speechEvidence: [{
      id: `speech-${fixture.id}`,
      sourceSegmentId: 0,
      exactText: 'Esta fala essencial ocupa toda a fixture.',
      normalizedText: 'esta fala essencial ocupa toda a fixture',
      rangeMs: [0, fixture.technical.durationMs],
      completeThoughtScore: 0.99,
      classification: 'complete-thought',
      intentions: [{
        value: 'hook',
        confidence: 0.99,
        provenance: 'contamination-golden/v1',
      }],
      segmentHash: sha256(`speech:${fixture.id}`),
    }],
    createdByClientId: 'client-contamination-golden',
    createdAt: '2026-07-28T20:30:00.000Z',
  })
}

function report(fixture) {
  const source = sourceReport(fixture)
  return createContaminationReport({
    id: `report-${fixture.id}`,
    sourceDeconstruction: source,
    expectedSourceDeconstructionReportHash: source.reportHash,
    analyzer: {
      provider: 'apollo',
      model: 'contamination-golden',
      version: '1.0.0',
    },
    policy: {
      minObservationConfidence: 0.5,
      minAutomaticConfidence: 0.85,
      protectedIntersectionReviewRatio: 0.1,
      protectedIntersectionDestructiveRatio: 0.35,
      lowConfidenceRequiresReview: true,
    },
    observations: fixture.observations,
    protectedRegions: fixture.protectedRegions,
    createdByClientId: 'client-contamination-golden',
    createdAt: '2026-07-28T20:31:00.000Z',
  })
}

test('T-FR-121 fixtures are six real deterministic audiovisual files with exact manifests', () => {
  assert.equal(
    manifest.schemaVersion,
    'contamination-golden-fixtures/v1',
  )
  assert.equal(manifest.fixtures.length, 6)
  for (const fixture of manifest.fixtures) {
    const path = join(fixtureDirectory, fixture.file)
    const bytes = readFileSync(path)
    assert.equal(sha256(bytes), fixture.sha256)
    assert.equal(bytes.byteLength, fixture.byteSize)
    const probe = JSON.parse(execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ))
    const video = probe.streams.find((stream) =>
      stream.codec_type === 'video')
    const audio = probe.streams.find((stream) =>
      stream.codec_type === 'audio')
    assert.equal(video.codec_name, 'h264')
    assert.equal(video.width, 320)
    assert.equal(video.height, 568)
    assert.equal(video.avg_frame_rate, '30/1')
    assert.equal(Number(video.nb_frames), 60)
    assert.equal(audio.codec_name, 'aac')
    assert.equal(Number(audio.sample_rate), 48_000)
    assert.equal(Number(probe.format.duration) * 1_000, 2_000)
  }
})

test('T-FR-121 fixtures prove captions, watermark, border, overlay and music in media bytes', () => {
  const byId = Object.fromEntries(
    manifest.fixtures.map((fixture) => [fixture.id, fixture]),
  )
  const caption = frame(
    byId['contamination-burned-caption'],
    'crop=280:90:20:430',
    'gray',
  )
  const watermark = frame(
    byId['contamination-logo-watermark'],
    'crop=90:80:230:0',
    'gray',
  )
  const border = frame(
    byId['contamination-border'],
    'crop=320:40:0:0',
    'gray',
  )
  const overlay = frame(
    byId['contamination-overlay'],
    'crop=144:270:88:180',
  )
  assert.ok([...caption].filter((value) => value > 190).length > 100)
  assert.ok([...watermark].filter((value) => value > 180).length > 40)
  assert.ok(
    [...border].reduce((sum, value) => sum + value, 0) /
      border.length < 20,
  )
  let redDominant = 0
  for (let offset = 0; offset < overlay.length; offset += 3) {
    if (
      overlay[offset] > overlay[offset + 1] * 1.3 &&
      overlay[offset] > overlay[offset + 2] * 1.2
    ) redDominant += 1
  }
  assert.ok(redDominant > 10_000)
  assert.ok(
    audioRms(byId['contamination-music']) >
      audioRms(byId['contamination-border']) + 0.02,
  )
})

test('T-FR-121 each fixture maps to its exact localized finding and the combination preserves overlaps', () => {
  const individual = manifest.fixtures.filter((fixture) =>
    fixture.kinds.length === 1)
  for (const fixture of individual) {
    const diagnosis = report(fixture)
    assert.equal(diagnosis.findings.length, 1)
    assert.equal(diagnosis.findings[0].kind, fixture.kinds[0])
    assert.deepEqual(
      diagnosis.findings[0].rangeMs,
      fixture.observations[0].rangeMs,
    )
  }
  const combined = report(manifest.fixtures.find((fixture) =>
    fixture.kinds.length === 5))
  assert.equal(
    new Set(combined.findings.map((finding) =>
      finding.kind)).size,
    5,
  )
  assert.ok(combined.overlaps.length >= 5)
  assert.equal(combined.humanReviewRequired, true)
  assert.equal(
    combined.decision,
    'manual-preservation-required',
  )
})
