import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import { createTransformationBrief } from '../../src/v2/domain/transformation-brief.ts'
import { createNoveltyBudgetPolicy, evaluateNoveltyBudget } from '../../src/v2/domain/novelty-budget.ts'
import { FfmpegTransformationCriticEvaluator } from '../../src/v2/infrastructure/transformation/ffmpeg-transformation-critic.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const ffprobe = require('ffprobe-static').path
const digest = (character) => character.repeat(64)

function video(path, background, protectedColor) {
  execFileSync(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=${background}:s=320x180:r=30:d=3`,
    '-vf', `drawbox=x=64:y=36:w=96:h=54:color=${protectedColor}:t=fill`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path,
  ], { windowsHide: true })
}

function artifact(id, key, hash) {
  return { id, workspaceId: 'workspace-critic-media', artifactKey: key, sha256: hash, byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', lifecycleRevision: 1, manifests: [], createdAt: '2029-03-01T10:00:00.000Z' }
}

test('T-FR-116 real ffprobe and decoded pixels approve protected regions and reject tamper', async () => {
  const root = join(tmpdir(), `apollo-transformation-critic-${process.pid}-${Date.now()}`)
  await mkdir(root, { recursive: true })
  const sourcePath = join(root, 'source.mp4')
  const acceptedPath = join(root, 'accepted.mp4')
  const tamperedPath = join(root, 'tampered.mp4')
  try {
    video(sourcePath, 'black', 'red')
    video(acceptedPath, 'blue', 'red')
    video(tamperedPath, 'blue', 'green')
    const paths = new Map([['source', sourcePath], ['accepted', acceptedPath], ['tampered', tamperedPath]])
    const evaluator = new FfmpegTransformationCriticEvaluator({
      sources: {
        async materialize(input) { return { path: paths.get(input.artifactKey), sha256: input.sha256, byteSize: input.byteSize } },
        async cleanup() {},
      },
      prober: { probe(path, options) { return probeVideo(path, { ...options, requireAudio: false }) } },
    })
    const brief = createTransformationBrief({
      workspaceId: 'workspace-critic-media', projectId: 'project-critic-media', projectVersionId: 'version-critic-media',
      storyPlanId: 'story-critic-media', storyPlanHash: digest('1'), sourceArtifactId: 'artifact-source-media', sourceArtifactHash: digest('2'),
      sourceRange: { startFrame: 0, endFrame: 90 }, intent: 'world-shift', editorialIntent: 'Replace only the background while preserving the red protected subject.',
      mode: 'background-replacement', prompt: 'A saturated blue environment.', negativeConstraints: [],
      preserve: ['identity', 'foreground'], allowedChanges: ['background'], target: { background: 'blue' }, outputSpecIds: ['output-spec-media'],
      intensityBps: 3_000, noveltyBps: 4_000, safety: ['preserve-subject'], safeZones: [{ x: 0.2, y: 0.2, width: 0.3, height: 0.3, purpose: 'subject' }],
      fallbackLadder: ['video-to-video', 'source-unchanged'], rightsSnapshotId: 'rights-critic-media', rightsSnapshotHash: digest('3'),
      identitySnapshotId: 'identity-critic-media', identitySnapshotHash: digest('4'), createdAt: '2029-03-01T10:00:00.000Z',
    })
    const accepted = await evaluator.evaluate({ brief, source: artifact('artifact-source-media', 'source', digest('2')), result: artifact('artifact-result-accepted', 'accepted', digest('5')), operationId: 'critic-media-accepted' })
    assert.equal(accepted.measurements.length, 14)
    assert.equal(accepted.decision, 'approved')
    assert.deepEqual(accepted.hardGates, [])
    assert.ok(accepted.intentScoreBps >= 4_500)
    const tampered = await evaluator.evaluate({ brief, source: artifact('artifact-source-media', 'source', digest('2')), result: artifact('artifact-result-tampered', 'tampered', digest('6')), operationId: 'critic-media-tampered' })
    assert.equal(tampered.decision, 'rejected')
    assert.ok(tampered.hardGates.includes('preserve-list'))
    assert.ok(tampered.hardGates.includes('identity'))
    assert.ok(tampered.issues.every((issue) => issue.frameRange.endFrame === 90))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-114 sober, balanced and intense novelty goldens are real 270-frame videos', async () => {
  const root = join(tmpdir(), `apollo-novelty-goldens-${process.pid}-${Date.now()}`)
  await mkdir(root, { recursive: true })
  const policy = createNoveltyBudgetPolicy({
    id: 'novelty-video-golden-policy', totalUnits: 10_000, windowUnits: 10_000, windowFrames: 10_000,
    cooldownFrames: 0, minimumSeparationFrames: 0, maximumPerGroup: 20, diversityFloor: 0,
    baseUnitsByGroup: { world: 1_000, style: 1_000, insert: 1_000, camera: 1_000, light: 1_000 },
    unitsPerSecond: 0, proximityPenaltyBps: 0, repetitionPenaltyBps: 0,
  })
  const goldens = [
    { name: 'sober', count: 1, expected: 'sober' },
    { name: 'balanced', count: 4, expected: 'balanced' },
    { name: 'intense', count: 9, expected: 'intense' },
  ]
  try {
    for (const golden of goldens) {
      const path = join(root, `${golden.name}.mp4`)
      const boxes = Array.from({ length: golden.count }, (_, index) => {
        const start = index
        return `drawbox=x=${10 + index * 12}:y=${10 + index * 7}:w=48:h=32:color=0x${['D7B259', '4C8ED9', '8F64C9'][index % 3]}:t=fill:enable='between(t,${start},${start + 0.8})'`
      }).join(',')
      execFileSync(ffmpeg, [
        '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x111111:s=320x180:r=30:d=9',
        '-vf', boxes, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path,
      ], { windowsHide: true })
      const candidates = Array.from({ length: golden.count }, (_, index) => ({
        id: `candidate-${golden.name}-${index}`, briefId: `brief-${golden.name}-${index}`,
        mode: ['background-replacement', 'stylization', 'camera-motion'][index % 3], intensityBps: 10_000,
        startFrame: index * 30, endFrame: index * 30 + 24, fps: 30, servedFromCache: false,
      }))
      const decision = evaluateNoveltyBudget({ policy, candidates })
      assert.equal(decision.treatment, golden.expected)
      assert.equal(decision.blockedCount, 0)
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate', '-of', 'json', path], { encoding: 'utf8', windowsHide: true }))
      assert.equal(Number(probe.streams[0].nb_read_frames), 270)
      assert.equal(probe.streams[0].width, 320)
      assert.equal(probe.streams[0].height, 180)
      assert.equal(probe.streams[0].r_frame_rate, '30/1')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-123 burned subtitle, logo and complex-background cleanup pass protected-region visual evaluation', async () => {
  const root = join(tmpdir(), `apollo-cleanup-visual-${process.pid}-${Date.now()}`)
  await mkdir(root, { recursive: true })
  const fixtures = [
    { name: 'burned-subtitle', input: 'color=c=black:s=320x180:r=30:d=3', target: 'drawbox=x=15:y=145:w=130:h=22:color=white:t=fill' },
    { name: 'logo', input: 'color=c=0x20283A:s=320x180:r=30:d=3', target: 'drawbox=x=12:y=12:w=44:h=44:color=white:t=fill' },
    { name: 'complex-background', input: 'testsrc2=s=320x180:r=30:d=3', target: 'drawbox=x=205:y=115:w=75:h=38:color=white:t=fill' },
  ]
  try {
    for (const fixture of fixtures) {
      const sourcePath = join(root, `${fixture.name}-source.mp4`)
      const resultPath = join(root, `${fixture.name}-result.mp4`)
      const protectedBox = 'drawbox=x=112:y=32:w=70:h=90:color=red:t=fill'
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', fixture.input, '-vf', `${protectedBox},${fixture.target}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourcePath], { windowsHide: true })
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', fixture.input, '-vf', protectedBox, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', resultPath], { windowsHide: true })
      const paths = new Map([['source', sourcePath], ['result', resultPath]])
      const evaluator = new FfmpegTransformationCriticEvaluator({
        sources: {
          async materialize(input) { return { path: paths.get(input.artifactKey), sha256: input.sha256, byteSize: input.byteSize } },
          async cleanup() {},
        },
        prober: { probe(path, options) { return probeVideo(path, { ...options, requireAudio: false }) } },
      })
      const brief = createTransformationBrief({
        workspaceId: 'workspace-cleanup-visual', projectId: 'project-cleanup-visual', projectVersionId: 'version-cleanup-visual',
        storyPlanId: `story-${fixture.name}`, storyPlanHash: digest('1'), sourceArtifactId: `source-${fixture.name}`, sourceArtifactHash: digest('2'),
        sourceRange: { startFrame: 0, endFrame: 90 }, intent: 'world-shift', editorialIntent: `Remove ${fixture.name} only inside the reviewed mask.`,
        mode: 'object-environment-change', prompt: 'Reconstruct only the reviewed pixels.', negativeConstraints: ['do not alter subject'],
        preserve: ['identity', 'speech'], allowedChanges: ['reviewed pixels'], target: { cleanup: fixture.name }, outputSpecIds: ['output-cleanup'],
        intensityBps: 1_000, noveltyBps: 500, safety: ['subject-protected'], safeZones: [{ x: .35, y: .17, width: .22, height: .51, purpose: 'subject' }],
        fallbackLadder: ['video-to-video', 'source-unchanged'], rightsSnapshotId: 'rights-cleanup-visual', rightsSnapshotHash: digest('3'),
        identitySnapshotId: 'identity-cleanup-visual', identitySnapshotHash: digest('4'), createdAt: '2029-03-01T10:00:00.000Z',
      })
      const outcome = await evaluator.evaluate({ brief, source: artifact(`source-${fixture.name}`, 'source', digest('2')), result: artifact(`result-${fixture.name}`, 'result', digest('5')), operationId: `cleanup-${fixture.name}` })
      assert.equal(outcome.decision, 'approved', `${fixture.name}: ${JSON.stringify(outcome.issues)}`)
      assert.equal(outcome.hardGates.length, 0)
      assert.equal(outcome.measurements.length, 14)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
