import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { ElevenLabsTtsProviderAdapter } from '../../src/v2/infrastructure/elevenlabs-tts-provider.ts'
import { HeyGenV3AsyncMediaProviderAdapter } from '../../src/v2/infrastructure/heygen-v3-provider.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const enabled = process.env.APOLLO_V2_PROVIDER_LIVE_SMOKE === '1'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function required(name) {
  const value = process.env[name]?.trim()
  assert.ok(value, `${name} is required for the live provider gate`)
  return value
}

async function json(url, apiKey, header) {
  const response = await fetch(url, { headers: { [header]: apiKey }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  assert.equal(response.ok, true, `${new URL(url).pathname} returned ${response.status}`)
  return response.json()
}

function probe(path) {
  return JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height', '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true }))
}

async function poll(adapter, providerJobId, deadline) {
  const states = []
  while (Date.now() < deadline) {
    const status = await adapter.getStatus(providerJobId)
    states.push(status)
    if (status === 'completed') return states
    assert.notEqual(status, 'failed', `HeyGen job ${providerJobId} failed`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))
  }
  assert.fail(`HeyGen job ${providerJobId} did not complete before the owned deadline`)
}

async function renderAvatar({ adapter, avatarId, audioBytes, audioContainer, durationMs, label, runId, root }) {
  const submitted = await adapter.submit({
    avatarId,
    audioBytes: new Uint8Array(audioBytes),
    audioSha256: sha256(audioBytes),
    audioByteSize: audioBytes.byteLength,
    audioContainer,
    durationMs,
    aspectRatio: '9:16',
  }, {
    workspaceId: `live-gate-${runId}`,
    projectVersionId: `live-version-${runId}`,
    operationId: `live-${label}-${runId}`,
    idempotencyKey: `live:${label}:${runId}`,
  })
  assert.equal(submitted.kind, 'accepted')
  const states = await poll(adapter, submitted.providerJobId, Date.now() + 20 * 60_000)
  const result = await adapter.retrieve(submitted.providerJobId)
  const response = await fetch(result.downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  assert.equal(response.ok, true, `HeyGen result download returned ${response.status}`)
  const video = Buffer.from(await response.arrayBuffer())
  const path = join(root, `${label}.mp4`)
  await writeFile(path, video)
  const mediaProbe = probe(path)
  const videoStream = mediaProbe.streams.find((stream) => stream.codec_type === 'video')
  const audioStream = mediaProbe.streams.find((stream) => stream.codec_type === 'audio')
  assert.equal(videoStream?.codec_name, 'h264')
  assert.equal(audioStream?.codec_name, 'aac')
  assert.ok(Number(mediaProbe.format.duration) >= 1)
  return {
    label,
    providerJobId: submitted.providerJobId,
    states,
    sha256: sha256(video),
    byteSize: video.byteLength,
    probe: mediaProbe,
  }
}

test('T-FR-101 live ElevenLabs alignment and HeyGen ready/generated audio contract', {
  skip: !enabled && 'APOLLO_V2_PROVIDER_LIVE_SMOKE=1 is required',
  timeout: 45 * 60_000,
}, async () => {
  const elevenLabsKey = required('APOLLO_V2_ELEVENLABS_API_KEY')
  const heyGenKey = required('APOLLO_V2_HEYGEN_API_KEY')
  const runId = required('APOLLO_V2_PROVIDER_LIVE_RUN_ID')
  assert.match(runId, /^[A-Za-z0-9_-]{8,80}$/)
  const evidenceRoot = resolve(required('APOLLO_V2_PROVIDER_LIVE_EVIDENCE_ROOT'))
  const root = await mkdtemp(join(tmpdir(), `apollo-provider-live-${runId}-`))
  await mkdir(evidenceRoot, { recursive: true })

  try {
    const voiceCatalog = await json('https://api.elevenlabs.io/v2/voices?page_size=20', elevenLabsKey, 'xi-api-key')
    const voiceId = process.env.APOLLO_V2_PROVIDER_LIVE_VOICE_ID?.trim() || voiceCatalog.voices?.[0]?.voice_id
    assert.match(voiceId, /^[A-Za-z0-9_-]{3,256}$/)
    const lookCatalog = await json('https://api.heygen.com/v3/avatars/looks?ownership=public&limit=20', heyGenKey, 'x-api-key')
    const publicLook = lookCatalog.data?.find((look) =>
      look.status === 'completed' && Array.isArray(look.supported_api_engines) && look.supported_api_engines.includes('avatar_iv'))
    const avatarId = process.env.APOLLO_V2_PROVIDER_LIVE_AVATAR_ID?.trim() || publicLook?.id
    assert.match(avatarId, /^[A-Za-z0-9_-]{3,256}$/)

    const script = 'Olá. Este é o teste real do Apollo.'
    const tts = new ElevenLabsTtsProviderAdapter({
      apiKey: elevenLabsKey,
      costMinorUnitsPerThousandCharacters: 0,
      requestTimeoutMs: 120_000,
    })
    const ttsResult = await tts.submit({
      text: script,
      scriptHash: sha256(Buffer.from(script, 'utf8')),
      voiceId,
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'mp3',
      seed: 19092026,
    }, {
      workspaceId: `live-gate-${runId}`,
      projectVersionId: `live-version-${runId}`,
      operationId: `live-tts-${runId}`,
      idempotencyKey: `live:tts:${runId}`,
    })
    assert.equal(ttsResult.kind, 'completed')
    assert.equal(ttsResult.bundle.result.alignment.characters.join(''), script)
    assert.equal(ttsResult.bundle.result.alignment.characters.length, [...script].length)
    const generatedAudio = Buffer.from(ttsResult.bundle.result.audioBytes)
    const generatedAudioPath = join(root, 'generated.mp3')
    await writeFile(generatedAudioPath, generatedAudio)
    const generatedProbe = probe(generatedAudioPath)
    const generatedDurationMs = Math.round(Number(generatedProbe.format.duration) * 1_000)
    assert.ok(generatedDurationMs >= 1_000)

    const readyAudioPath = join(root, 'ready.mp3')
    execFileSync(ffmpegPath, [
      '-v', 'error', '-y', '-i', resolve('tests/fixtures/source-deconstruction/reel-published-golden.mp4'),
      '-t', '2.4', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', readyAudioPath,
    ], { windowsHide: true })
    const readyAudio = await readFile(readyAudioPath)
    const readyProbe = probe(readyAudioPath)
    const readyDurationMs = Math.round(Number(readyProbe.format.duration) * 1_000)
    assert.ok(readyDurationMs >= 1_000)

    const heyGen = new HeyGenV3AsyncMediaProviderAdapter({
      apiKey: heyGenKey,
      costMinorUnitsPerMinute: 0,
      requestTimeoutMs: 120_000,
    })
    assert.equal((await heyGen.getCapabilities()).supportsIdempotency, true)
    const generatedAvatar = await renderAvatar({
      adapter: heyGen, avatarId, audioBytes: generatedAudio, audioContainer: 'mp3',
      durationMs: generatedDurationMs, label: 'generated-audio-avatar', runId, root,
    })
    const readyAvatar = await renderAvatar({
      adapter: heyGen, avatarId, audioBytes: readyAudio, audioContainer: 'mp3',
      durationMs: readyDurationMs, label: 'ready-audio-avatar', runId, root,
    })

    const evidence = {
      schemaVersion: 'provider-live-contract-evidence/v1',
      runId,
      executedAt: new Date().toISOString(),
      providers: {
        elevenLabs: {
          adapterId: tts.id,
          adapterVersion: tts.adapterVersion,
          requestId: ttsResult.bundle.providerJobRef,
          voiceId,
          scriptHash: ttsResult.bundle.result.scriptHash,
          audioSha256: ttsResult.bundle.result.audioSha256,
          audioByteSize: generatedAudio.byteLength,
          characterCount: [...script].length,
          alignmentCount: ttsResult.bundle.result.alignment.characters.length,
          durationMs: generatedDurationMs,
        },
        heyGen: {
          adapterId: heyGen.id,
          adapterVersion: heyGen.adapterVersion,
          avatarId,
          generatedAvatar,
          readyAvatar,
        },
      },
    }
    await writeFile(join(evidenceRoot, `provider-live-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
    await writeFile(join(evidenceRoot, `provider-live-${runId}-generated.mp3`), generatedAudio)
    await writeFile(join(evidenceRoot, `provider-live-${runId}-generated.mp4`), await readFile(join(root, 'generated-audio-avatar.mp4')))
    await writeFile(join(evidenceRoot, `provider-live-${runId}-ready.mp4`), await readFile(join(root, 'ready-audio-avatar.mp4')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
