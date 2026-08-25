import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { runProviderJobWorkerOnce } from '../../src/v2/application/provider-jobs.ts'
import { compileSyntheticPresenterRenderInputs } from '../../src/v2/application/compile-synthetic-presenter-render.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createProviderJob } from '../../src/v2/domain/provider-job.ts'
import { createSyntheticPresenterEditPlan, createSyntheticPresenterProfileSnapshot } from '../../src/v2/domain/synthetic-production.ts'
import { ControlledAsyncMediaProviderAdapter } from '../../src/v2/infrastructure/controlled-async-media-provider.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { RemotionRenderInputRenderer } from '../../src/v2/infrastructure/remotion-render-input-renderer.ts'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegPath = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`)
const ffprobePath = require('ffprobe-static').path
const hash = (character) => character.repeat(64)

async function generateFixture(directory) {
  const audio = path.join(directory, 'narration.wav')
  const avatar = path.join(directory, 'avatar.mp4')
  const broll = path.join(directory, 'broll.png')
  const overlay = path.join(directory, 'overlay.png')
  await execFileAsync(ffmpegPath, ['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:a','pcm_s16le','-y',audio])
  await execFileAsync(ffmpegPath, ['-f','lavfi','-i','color=c=0x1AA36F:s=270x480:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',avatar])
  await execFileAsync(ffmpegPath, ['-f','lavfi','-i','color=c=0x2347D9:s=270x480','-frames:v','1','-y',broll])
  await execFileAsync(ffmpegPath, ['-f','lavfi','-i','color=c=0xFFB800:s=120x80','-frames:v','1','-y',overlay])
  return { audio, avatar, broll, overlay }
}

async function artifact(id, kind, file, key) {
  const metadata = await stat(file)
  return Object.freeze({ id: `asset-${id}`, artifactId: id, artifactKey: key, kind, sha256: await calculateFileSha256(file), byteSize: metadata.size })
}

async function decodedFrame(file, seconds) {
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-v','error','-ss',String(seconds),'-i',file,'-frames:v','1',
    '-f','rawvideo','-pix_fmt','rgb24','pipe:1',
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

test('T-FR-092 controlled provider output becomes a person-free real MP4 with disclosure, captions, B-roll and overlay', { timeout: 480_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-synthetic-presenter-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputRoot = path.join(directory, 'outputs')
  await mkdir(outputRoot, { recursive: true })
  const fixture = await generateFixture(directory)
  const audio = await artifact('synthetic-audio-real', 'audio', fixture.audio, 'synthetic/audio.wav')
  const avatar = await artifact('synthetic-avatar-real', 'video', fixture.avatar, 'synthetic/avatar.mp4')
  const broll = await artifact('synthetic-broll-real', 'image', fixture.broll, 'synthetic/broll.png')
  const overlay = await artifact('synthetic-overlay-real', 'image', fixture.overlay, 'synthetic/overlay.png')

  const profile = createSyntheticPresenterProfileSnapshot({
    id: 'presenter-controlled-real', version: 1, actorIdentityId: 'identity-controlled-real',
    avatar: { adapterId: 'controlled-avatar', adapterVersion: 'version-1', identityRef: 'identity-ref-controlled-real' },
    voice: { id: 'voice-controlled-real', version: 1, adapterId: 'controlled-tts', adapterVersion: 'version-1' },
    defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
    consent: {
      id: 'consent-controlled-real', evidenceArtifactId: 'consent-evidence-controlled-real', evidenceSha256: hash('a'), granted: true,
      allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'], allowedOperations: ['tts','audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
    },
  })
  const authorizationBody = {
    id: 'provider-authorization-controlled-real', profileSnapshotId: profile.id, profileSnapshotHash: profile.snapshotHash,
    artifactDecisions: [{ artifactId: audio.artifactId, rightsSnapshotId: 'rights-audio-controlled-real', rightsSnapshotHash: hash('b'), validUntil: '2030-01-01T00:00:00.000Z' }],
    evaluatedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const planned = createProviderJob({
    id: 'provider-job-controlled-real', workspaceId: 'workspace-controlled-real', projectId: 'project-controlled-real', originProjectVersionId: 'version-controlled-real',
    operation: 'audio-avatar', adapterId: 'controlled-avatar', adapterVersion: 'version-1',
    providerInput: { audioArtifactId: audio.artifactId, durationMs: 2_000, locale: 'pt-BR' }, idempotencyKey: 'controlled-real-provider-key',
    authorization: { ...authorizationBody, authorizationHash: calculateCanonicalHash(authorizationBody) }, createdAt: '2029-01-01T00:00:00.000Z',
  })
  let stored = { job: planned, requestFingerprint: hash('c') }
  let lease
  const jobs = {
    async claimNext(input) {
      if (lease || ['approved','rejected','failed'].includes(stored.job.status)) return null
      lease = { owner: input.workerId, token: input.leaseToken, expiresAt: input.leaseExpiresAt.toISOString() }
      return { ...stored, lease }
    },
    async advance(input) { assert.equal(input.current.job.jobHash, stored.job.jobHash); stored = { ...stored, job: input.next }; lease = undefined; return stored },
  }
  const provider = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
    capabilities: { operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], locales: ['pt-BR'], duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: true, supportsIdempotency: true, completion: 'polling', fetchedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' },
    estimate: { currency: 'USD', costMinorUnits: 10, estimatedLatencyMs: 2_000 }, statuses: ['queued','processing','completed'], result: { file: fixture.avatar },
  })
  let tick = 0
  const runOnce = runProviderJobWorkerOnce({
    jobs, adapters: { get: () => provider },
    ingestor: { async ingest({ providerResult }) { assert.equal(providerResult.file, fixture.avatar); return { artifactId: avatar.artifactId, artifactSha256: avatar.sha256, mediaType: 'video', byteSize: avatar.byteSize } } },
    critic: { async evaluate({ artifact: result }) { assert.equal(result.artifactSha256, avatar.sha256); return { approved: true, resultHash: hash('d') } } },
    clock: () => new Date(Date.parse('2029-01-01T00:00:00.000Z') + (++tick * 1_000)), createLeaseToken: () => `controlled-real-lease-${tick}`, createTransitionId: () => `controlled-real-transition-${tick}`,
  })
  for (let stage = 0; stage < 7; stage += 1) await runOnce('controlled-real-worker')
  assert.equal(stored.job.status, 'approved')

  const planArtifacts = [audio, avatar, broll, overlay]
  const editAuthorization = {
    id: 'edit-authorization-controlled-real', authorizationHash: hash('e'), outcome: 'allowed', use: 'ads', market: 'BRA', locale: 'pt-BR', syntheticOperations: ['tts','audio-avatar'],
    artifactIds: planArtifacts.map((item) => item.artifactId),
    decisions: planArtifacts.map((item, index) => ({ artifactId: item.artifactId, rightsSnapshotId: `rights-plan-${index}`, rightsSnapshotHash: hash(String((index + 3) % 10)), validUntil: '2030-01-01T00:00:00.000Z' })),
    evaluatedAt: '2029-01-01T00:00:08.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const plan = createSyntheticPresenterEditPlan({
    id: 'synthetic-edit-plan-controlled-real', workspaceId: 'workspace-controlled-real', projectId: 'project-controlled-real', projectVersionId: 'version-controlled-real', profile,
    audio: { ...audio, durationMs: 2_000, locale: 'pt-BR', scriptHash: hash('f'), alignment: [{ text: 'Olá', startMs: 0, endMs: 900 }, { text: 'mundo', startMs: 900, endMs: 2_000 }] },
    blocks: [{ id: 'synthetic-block-controlled-real', text: 'Olá mundo', rangeMs: [0,2_000], cacheKey: hash('1'), providerJobId: stored.job.id, audioSha256: audio.sha256, artifact: avatar, critic: { id: 'critic-controlled-real', resultHash: stored.job.criticResultHash, status: 'approved' } }],
    bRoll: [{ id: 'broll-controlled-real', rangeMs: [1_000,2_000], artifact: broll, role: 'b-roll' }],
    overlays: [{ id: 'overlay-controlled-real', rangeMs: [0,2_000], artifact: overlay, role: 'overlay' }],
    captions: true, use: 'ads', market: 'BRA', authorization: editAuthorization, createdAt: '2029-01-01T00:00:09.000Z',
  })
  const compiled = compileSyntheticPresenterRenderInputs({ plan, renderer: { id: 'remotion', version: '4.0.489', digest: hash('2') } })
  const fileByKey = new Map([[audio.artifactKey, fixture.audio], [avatar.artifactKey, fixture.avatar], [broll.artifactKey, fixture.broll], [overlay.artifactKey, fixture.overlay]])
  const materialized = { ...compiled.proxy, schemaVersion: 'materialized-render-input/v1', assets: compiled.proxy.assets.map((item) => ({ ...item, uri: pathToFileURL(fileByKey.get(item.artifactKey)).href })) }
  const renderer = new RemotionRenderInputRenderer({ projectRoot: process.cwd(), outputRoot, timeoutMs: 60_000, createId: () => 'synthetic-controlled-stage', clock: () => new Date('2029-01-01T00:00:10.000Z') })
  const outputKey = 'synthetic/controlled-presenter.mp4'
  const staged = await renderer.stage(materialized, { outputKey })
  const receipt = await staged.commit()
  const output = path.join(outputRoot, ...outputKey.split('/'))
  const { stdout } = await execFileAsync(ffprobePath, ['-v','error','-count_frames','-show_entries','stream=codec_type,codec_name,width,height,nb_read_frames','-of','json',output])
  const streams = JSON.parse(stdout).streams
  const video = streams.find((stream) => stream.codec_type === 'video')
  const renderedAudio = streams.find((stream) => stream.codec_type === 'audio')
  assert.deepEqual([compiled.proxy.output.width, compiled.proxy.output.height], [540,960])
  assert.deepEqual([video.codec_name, video.width, video.height, Number(video.nb_read_frames)], ['h264',540,960,60])
  assert.equal(renderedAudio.codec_name, 'aac')
  const avatarFrame = await decodedFrame(output, 0.5)
  const brollFrame = await decodedFrame(output, 1.5)
  assert.equal(avatarFrame.equals(brollFrame), false, 'the declared B-roll must change decoded pixels')
  let lightPixels = 0
  for (let index = 0; index < avatarFrame.length; index += 3) {
    if (avatarFrame[index] > 230 && avatarFrame[index + 1] > 230 && avatarFrame[index + 2] > 230) lightPixels += 1
  }
  assert.ok(lightPixels > 100, `captions and disclosure must be visible, measured ${lightPixels} light pixels`)
  assert.equal(compiled.proxy.props.subtitles[0].text, 'Conteúdo gerado com IA')
  assert.equal(compiled.proxy.props.scenes.length, 3)
  assert.equal(receipt.inputHash, compiled.proxy.inputHash)
  assert.equal(receipt.outputSha256, await calculateFileSha256(output))
})
