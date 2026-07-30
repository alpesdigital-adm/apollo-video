import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  FfmpegContiguousVisualEvidenceProvider,
} from '../../src/v2/infrastructure/analysis/ffmpeg-contiguous-visual-evidence-provider.ts'
import {
  VisualContiguousEvidenceAnalyzer,
} from '../../src/v2/infrastructure/analysis/visual-contiguous-evidence-analyzer.ts'
import {
  calculateFileSha256,
} from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), 'apollo-contiguous-visual-'),
  )
  const artifactKey = 'workspaces/visual/master.mp4'
  const source = join(root, ...artifactKey.split('/'))
  await mkdir(join(root, 'workspaces', 'visual'), {
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
      'color=c=white:s=160x90:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=160x90:r=30:d=1',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[out]',
      '-map',
      '[out]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ],
    { windowsHide: true, timeout: 30_000 },
  )
  const metadata = await stat(source)
  return {
    root,
    artifactKey,
    byteSize: metadata.size.toString(),
    sha256: await calculateFileSha256(source),
  }
}

test('T-FR-134 FFmpeg measures bright and black contiguous visual windows from verified bytes', async () => {
  const media = await fixture()
  try {
    const provider =
      new FfmpegContiguousVisualEvidenceProvider({
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
        {
          momentId: 'moment-visual-bright',
          rangeMs: [0, 1_000],
        },
        {
          momentId: 'moment-visual-black',
          rangeMs: [1_000, 2_000],
        },
      ],
      signal: new AbortController().signal,
    })

    assert.equal(values.length, 2)
    assert.ok(values[0].sampledFrameCount >= 20)
    assert.ok(values[0].averageLuma > 0.8)
    assert.equal(values[0].blackDurationMs, 0)
    assert.ok(values[1].averageLuma < 0.2)
    assert.ok(values[1].blackRatio >= 0.9)
    assert.ok(values[1].freezeRatio >= 0.4)
  } finally {
    await rm(media.root, { recursive: true, force: true })
  }
})

test('T-FR-134 visual analyzer binds measurements to exact moment ranges and fails closed', async () => {
  const source = {
    workspaceId: 'workspace-visual-analyzer',
    projectId: 'project-visual-analyzer',
    indexRunId: 'index-visual-analyzer',
    indexRunHash: 'a'.repeat(64),
    sourceArtifactId: 'artifact-visual-analyzer',
    sourceArtifactSha256: 'b'.repeat(64),
    sourceArtifactKey: 'workspaces/visual/master.mp4',
    sourceArtifactByteSize: '4096',
    sourceManifestId: 'manifest-visual-analyzer',
    sourceManifestHash: 'c'.repeat(64),
    sourceDurationMs: 120_000,
    rightsSnapshotId: 'rights-visual-analyzer',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    moments: [{
      id: 'moment-visual-analyzer',
      momentHash: 'd'.repeat(64),
      recommendedRangeMs: [10_000, 70_000],
    }],
  }
  const analyzer = new VisualContiguousEvidenceAnalyzer({
    async measure(input) {
      assert.equal(
        input.sourceArtifactSha256,
        source.sourceArtifactSha256,
      )
      return [{
        momentId: source.moments[0].id,
        rangeMs: source.moments[0].recommendedRangeMs,
        durationMs: 60_000,
        sampledFrameCount: 1_800,
        averageLuma: 0.5,
        averageSaturation: 0.25,
        averageTemporalDifference: 0.05,
        temporalOutlierRatio: 0.001,
        repeatedPixelRatio: 0.1,
        broadcastRangeViolationRatio: 0,
        blackDurationMs: 0,
        blackRatio: 0,
        freezeDurationMs: 0,
        freezeRatio: 0,
        sceneChangeCount: 3,
      }]
    },
  })
  const evidence = await analyzer.analyze(
    source,
    new AbortController().signal,
  )
  assert.deepEqual(evidence[0].dimensions, ['visual'])
  assert.equal(evidence[0].facts.sampledFrameCount, 1_800)
  assert.equal(evidence[0].facts.sourceChecksumVerified, true)

  await assert.rejects(
    analyzer.analyze(
      { ...source, sourceArtifactByteSize: undefined },
      new AbortController().signal,
    ),
    (error) => error.code === 'PRECONDITION_REQUIRED',
  )
})
