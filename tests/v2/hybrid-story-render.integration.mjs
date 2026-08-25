import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { compileHybridStoryRenderInputs } from '../../src/v2/application/compile-hybrid-story-render.ts'
import { createHybridStoryPlan, STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { RemotionRenderInputRenderer } from '../../src/v2/infrastructure/remotion-render-input-renderer.ts'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegPath = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`)
const ffprobePath = require('ffprobe-static').path

async function fixture(directory) {
  const files = {
    voice: path.join(directory, 'voice.wav'),
    real: path.join(directory, 'real.mp4'),
    avatar: path.join(directory, 'avatar.mp4'),
    proof: path.join(directory, 'proof.png'),
    broll: path.join(directory, 'broll.mp4'),
  }
  await execFileAsync(ffmpegPath, ['-v','error','-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=9.5','-c:a','pcm_s16le','-y',files.voice])
  await execFileAsync(ffmpegPath, ['-v','error','-f','lavfi','-i','color=c=0xC42B36:s=270x480:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',files.real])
  await execFileAsync(ffmpegPath, ['-v','error','-f','lavfi','-i','color=c=0x1A9B65:s=270x480:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',files.avatar])
  await execFileAsync(ffmpegPath, ['-v','error','-f','lavfi','-i','color=c=0x2457C7:s=270x480','-frames:v','1','-y',files.proof])
  await execFileAsync(ffmpegPath, ['-v','error','-f','lavfi','-i','color=c=0x7A3FB0:s=270x480:r=30:d=1.5','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',files.broll])
  return files
}

async function artifact(artifactId, artifactKey, kind, file) {
  return { artifactId, artifactKey, kind, sha256: await calculateFileSha256(file), byteSize: (await stat(file)).size }
}

function hybridStoryPlan() {
  const base = STORY_GOLDEN_FIXTURES.linear
  const sourceKinds = ['real', 'synthetic', 'proof', 'voiceover']
  const presentations = ['source-video', 'synthetic-avatar', 'proof-insert', 'voiceover']
  return createHybridStoryPlan({
    id: 'story-plan-hybrid-render', workspaceId: 'workspace-hybrid-render', projectId: 'project-hybrid-render', projectVersionId: 'version-hybrid-render',
    objective: base.objective, desiredActionRef: base.desiredActionRef, treatmentPlanRef: base.treatmentPlanRef,
    targetDurationMs: base.targetDurationMs,
    acts: base.acts.map((act) => act.id === 'development' ? { ...act, blockIds: [...act.blockIds, 'broll'] } : act),
    blocks: [
      ...base.blocks.map((block, index) => ({ ...block, presentation: presentations[index] })),
      { id: 'broll', actId: 'development', role: 'context', intent: 'Illustrate the proof', dependencies: ['proof'], sourceCandidateIds: ['source-broll'], durationTargetMs: { min: 1000, ideal: 1500, max: 2500 }, content: { claimIds: [], qualifierIds: [], proofIds: [] }, presentation: 'b-roll' },
    ],
    sourceRanges: [
      ...base.sourceRanges.map((range, index) => ({
        ...range, artifactId: ['artifact-real', 'artifact-avatar', 'artifact-proof', 'artifact-voice'][index], rightsRef: `rights-hybrid-${index + 1}`, sourceKind: sourceKinds[index],
        ...(index !== 2 ? { consentRef: `consent-hybrid-${index + 1}`, identityRef: 'identity-ana', audioContinuityRef: 'audio-ana-ptbr' } : {}),
        ...(index < 2 ? { sceneContinuityRef: 'scene-studio' } : {}),
        ...(index === 1 ? { disclosure: 'Avatar gerado por IA' } : {}),
      })),
      { id: 'range-broll', artifactId: 'artifact-broll', startMs: 0, endMs: 1500, rightsRef: 'rights-hybrid-5', sourceKind: 'b-roll' },
    ],
    sourceCandidates: [...base.sourceCandidates, { id: 'source-broll', sourceRangeId: 'range-broll', purpose: 'context', rank: 1 }],
    qualifiers: base.qualifiers, claims: base.claims, proofContexts: base.proofContexts,
    createdBy: { type: 'api-client', id: 'client-hybrid-render' }, createdAt: '2029-01-01T00:00:00.000Z',
  })
}

async function pixel(file, seconds) {
  const { stdout } = await execFileAsync(ffmpegPath, ['-v','error','-ss',String(seconds),'-i',file,'-vf','crop=2:2:10:10','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], { encoding: 'buffer', maxBuffer: 1024 })
  return [...stdout.subarray(0, 3)]
}

test('T-FR-093 renders real to avatar to proof to B-roll to voiceover CTA from one hybrid StoryPlan', { timeout: 480_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-hybrid-story-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputRoot = path.join(directory, 'outputs')
  await mkdir(outputRoot, { recursive: true })
  const files = await fixture(directory)
  const artifacts = await Promise.all([
    artifact('artifact-real', 'hybrid/real.mp4', 'video', files.real),
    artifact('artifact-avatar', 'hybrid/avatar.mp4', 'video', files.avatar),
    artifact('artifact-proof', 'hybrid/proof.png', 'image', files.proof),
    artifact('artifact-voice', 'hybrid/voice.wav', 'audio', files.voice),
    artifact('artifact-broll', 'hybrid/broll.mp4', 'video', files.broll),
  ])
  const storyPlan = hybridStoryPlan()
  const compiled = compileHybridStoryRenderInputs({
    storyPlan, artifacts, renderer: { id: 'remotion', version: '4.0.489', digest: 'a'.repeat(64) },
    captionsByBlockId: { hook: 'Pessoa real', argument: 'Mesmo apresentador em avatar', proof: 'Prova atribuída', broll: 'Contexto visual', cta: 'Conheça agora' },
  })
  assert.equal(compiled.proxy.props.scenes.length, 4)
  assert.equal(compiled.proxy.props.subtitles.filter(({ text }) => text === 'Avatar gerado por IA').length, 1)
  assert.equal(compiled.proxy.assets.length, 5)
  assert.equal(compiled.proxy.output.durationInFrames, 285)

  const filesByKey = new Map([['hybrid/real.mp4', files.real], ['hybrid/avatar.mp4', files.avatar], ['hybrid/proof.png', files.proof], ['hybrid/voice.wav', files.voice], ['hybrid/broll.mp4', files.broll]])
  const materialized = { ...compiled.proxy, schemaVersion: 'materialized-render-input/v1', assets: compiled.proxy.assets.map((entry) => ({ ...entry, uri: pathToFileURL(filesByKey.get(entry.artifactKey)).href })) }
  const renderer = new RemotionRenderInputRenderer({ projectRoot: process.cwd(), outputRoot, timeoutMs: 180_000, createId: () => 'hybrid-render-stage', clock: () => new Date('2029-01-01T00:00:01.000Z') })
  const outputKey = 'hybrid/golden.mp4'
  const staged = await renderer.stage(materialized, { outputKey })
  const receipt = await staged.commit()
  const output = path.join(outputRoot, ...outputKey.split('/'))
  const { stdout } = await execFileAsync(ffprobePath, ['-v','error','-count_frames','-show_entries','stream=codec_type,codec_name,width,height,nb_read_frames:format=duration','-of','json',output])
  const metadata = JSON.parse(stdout)
  const video = metadata.streams.find((stream) => stream.codec_type === 'video')
  const audio = metadata.streams.find((stream) => stream.codec_type === 'audio')
  assert.deepEqual([video.codec_name, video.width, video.height, Number(video.nb_read_frames)], ['h264',540,960,285])
  assert.equal(audio.codec_name, 'aac')
  assert.ok(Math.abs(Number(metadata.format.duration) - 9.5) <= 0.1)
  const [realPixel, avatarPixel, proofPixel, brollPixel, ctaPixel] = await Promise.all([1, 3, 5, 6.75, 8.5].map((seconds) => pixel(output, seconds)))
  assert.ok(realPixel[0] > 150 && realPixel[0] > realPixel[1] * 3, `real phase must remain visibly red: ${realPixel}`)
  assert.ok(avatarPixel[1] > 100 && avatarPixel[1] > avatarPixel[0] * 3, `avatar phase must remain visibly green: ${avatarPixel}`)
  assert.ok(proofPixel[2] > 140 && proofPixel[2] > proofPixel[0] * 3, `proof phase must remain visibly blue: ${proofPixel}`)
  assert.ok(brollPixel[0] > 70 && brollPixel[2] > 100 && brollPixel[2] > brollPixel[1] * 2, `B-roll phase must remain visibly purple: ${brollPixel}`)
  assert.ok(ctaPixel.every((channel) => channel < 20), `voiceover CTA phase must use the declared dark canvas: ${ctaPixel}`)
  assert.equal(receipt.outputSha256, await calculateFileSha256(output))
  assert.equal((await readFile(output)).byteLength, receipt.byteSize)

  assert.throws(() => compileHybridStoryRenderInputs({ storyPlan, artifacts: artifacts.slice(1), renderer: { id: 'remotion', version: '4.0.489', digest: 'a'.repeat(64) }, captionsByBlockId: { hook: 'x', argument: 'x', proof: 'x', broll: 'x', cta: 'x' } }), /exactly match/)
})
