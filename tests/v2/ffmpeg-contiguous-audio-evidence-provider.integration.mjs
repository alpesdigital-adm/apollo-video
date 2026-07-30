import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  AudioContiguousEvidenceAnalyzer,
} from '../../src/v2/infrastructure/analysis/audio-contiguous-evidence-analyzer.ts'
import {
  FfmpegContiguousAudioEvidenceProvider,
} from '../../src/v2/infrastructure/analysis/ffmpeg-contiguous-audio-evidence-provider.ts'
import {
  calculateFileSha256,
} from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), 'apollo-contiguous-audio-'),
  )
  const artifactKey = 'workspaces/audio/master.wav'
  const source = join(root, ...artifactKey.split('/'))
  await mkdir(join(root, 'workspaces', 'audio'), {
    recursive: true,
  })
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
      'sine=frequency=1000:sample_rate=48000:duration=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono:d=1',
      '-filter_complex',
      '[0:a]volume=0.25[tone];[tone][1:a]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-c:a',
      'pcm_s16le',
      source,
    ],
    { windowsHide: true, timeout: 30_000 },
  )
  const metadata = await import('node:fs/promises')
    .then(({ stat }) => stat(source))
  return {
    root,
    artifactKey,
    byteSize: metadata.size.toString(),
    sha256: await calculateFileSha256(source),
  }
}

test('T-FR-134 FFmpeg measures audible and silent contiguous windows from verified bytes', async () => {
  const media = await fixture()
  try {
    const provider =
      new FfmpegContiguousAudioEvidenceProvider({
        artifactRoot: media.root,
        ffmpegPath,
        timeoutMs: 30_000,
      })
    const values = await provider.measure({
      sourceArtifactKey: media.artifactKey,
      sourceArtifactSha256: media.sha256,
      sourceArtifactByteSize: media.byteSize,
      sourceDurationMs: 2_000,
      windows: [
        { momentId: 'moment-audio-tone', rangeMs: [0, 1_000] },
        {
          momentId: 'moment-audio-silence',
          rangeMs: [1_000, 2_000],
        },
      ],
      signal: new AbortController().signal,
    })

    assert.equal(values.length, 2)
    assert.equal(values[0].audibleSignal, true)
    assert.ok(values[0].integratedLufs > -40)
    assert.equal(values[0].clippingRisk, false)
    assert.equal(values[1].audibleSignal, false)
    assert.ok(values[1].silenceRatio >= 0.9)
    assert.ok(values[1].integratedLufs <= -60)
  } finally {
    await rm(media.root, { recursive: true, force: true })
  }
})

test('T-FR-134 audio analyzer binds provider measurements to exact moment ranges and fails closed', async () => {
  const source = {
    workspaceId: 'workspace-audio-analyzer',
    projectId: 'project-audio-analyzer',
    indexRunId: 'index-audio-analyzer',
    indexRunHash: 'a'.repeat(64),
    sourceArtifactId: 'artifact-audio-analyzer',
    sourceArtifactSha256: 'b'.repeat(64),
    sourceArtifactKey: 'workspaces/audio/master.wav',
    sourceArtifactByteSize: '4096',
    sourceManifestId: 'manifest-audio-analyzer',
    sourceManifestHash: 'c'.repeat(64),
    sourceDurationMs: 120_000,
    rightsSnapshotId: 'rights-audio-analyzer',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    moments: [{
      id: 'moment-audio-analyzer',
      momentHash: 'd'.repeat(64),
      recommendedRangeMs: [10_000, 70_000],
    }],
  }
  const analyzer = new AudioContiguousEvidenceAnalyzer({
    async measure(input) {
      assert.equal(
        input.sourceArtifactSha256,
        source.sourceArtifactSha256,
      )
      return [{
        momentId: source.moments[0].id,
        rangeMs: source.moments[0].recommendedRangeMs,
        durationMs: 60_000,
        integratedLufs: -18,
        truePeakDbfs: -2,
        meanVolumeDb: -21,
        maximumVolumeDb: -2,
        silenceDurationMs: 2_000,
        silenceRatio: 0.033333,
        audibleSignal: true,
        clippingRisk: false,
      }]
    },
  })
  const evidence = await analyzer.analyze(
    source,
    new AbortController().signal,
  )
  assert.deepEqual(evidence[0].dimensions, ['audio'])
  assert.equal(evidence[0].facts.integratedLufs, -18)
  assert.equal(evidence[0].facts.sourceChecksumVerified, true)

  await assert.rejects(
    analyzer.analyze(
      { ...source, sourceArtifactKey: undefined },
      new AbortController().signal,
    ),
    (error) => error.code === 'PRECONDITION_REQUIRED',
  )
  await assert.rejects(
    new FfmpegContiguousAudioEvidenceProvider({
      artifactRoot: tmpdir(),
      ffmpegPath,
    }).measure({
      sourceArtifactKey: source.sourceArtifactKey,
      sourceArtifactSha256: source.sourceArtifactSha256,
      sourceArtifactByteSize: source.sourceArtifactByteSize,
      sourceDurationMs: source.sourceDurationMs,
      windows: [{
        momentId: source.moments[0].id,
        rangeMs: source.moments[0].recommendedRangeMs,
      }],
      signal: new AbortController().signal,
    }),
    (error) =>
      error.code === 'MEDIA_ARTIFACT_NOT_FOUND' ||
      error.code === 'PERSISTENCE_CONFLICT',
  )
})
