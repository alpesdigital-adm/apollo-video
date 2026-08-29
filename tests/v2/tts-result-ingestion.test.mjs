import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { PersistedTtsResultCritic, VerifiedTtsResultIngestor } from '../../src/v2/infrastructure/provider-result-ingestion.ts'
import { probeAudioDurationSeconds } from '../../src/v2/infrastructure/media/video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const hash = (character) => character.repeat(64)

const SCRIPT = 'Olá mundo'
const SCRIPT_HASH = createHash('sha256').update(SCRIPT, 'utf8').digest('hex')

function alignment() {
  const characters = [...SCRIPT]
  return {
    characters,
    startTimesSeconds: characters.map((_, index) => index * 0.2),
    endTimesSeconds: characters.map((_, index) => (index + 1) * 0.2),
  }
}

function job(overrides = {}) {
  return {
    id: 'tts-job-one', workspaceId: 'workspace-tts', projectId: 'project-tts', providerJobId: 'elevenlabs_request_123',
    operation: 'tts', adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0',
    input: { text: SCRIPT, scriptHash: SCRIPT_HASH, locale: 'pt-BR' }, inputHash: hash('1'),
    authorization: { authorizationHash: hash('2'), profileSnapshotHash: hash('3'), artifactDecisions: [] },
    ...overrides,
  }
}

test('T-FR-101 TTS ingestor persists audio and alignment artifacts with provenance and survives replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-tts-ingest-'))
  try {
    const sourceAudio = join(root, 'speech.mp3')
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-c:a', 'libmp3lame', sourceAudio], { windowsHide: true })
    const audioBytes = await readFile(sourceAudio)
    const audioSha256 = createHash('sha256').update(audioBytes).digest('hex')
    const providerResult = {
      requestId: 'elevenlabs_request_123', modelId: 'eleven_multilingual_v2', adapterConfigHash: hash('4'),
      scriptHash: SCRIPT_HASH, audioBytes: new Uint8Array(audioBytes), audioSha256,
      audioByteSize: audioBytes.byteLength, audioContainer: 'mp3', mediaType: 'audio', alignment: alignment(),
    }
    const persistedBundles = []
    const ledgerCalls = []
    const storedRoot = join(root, 'stored')
    await mkdir(storedRoot, { recursive: true })
    const ingestor = new VerifiedTtsResultIngestor({
      workRoot: join(root, 'work'),
      storage: {
        async promoteDerived(input) {
          const key = `${input.prefix}/${input.sha256}.${input.extension}`
          const path = join(storedRoot, `${input.sha256}.${input.extension}`)
          await copyFile(input.sourcePath, path)
          const bytes = await readFile(path)
          return { key, path, byteSize: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
        },
      },
      artifacts: { async persistOrReplay(bundle) { persistedBundles.push(bundle); return { artifactId: bundle.artifactId, manifestId: bundle.manifestId, replayed: false } } },
      artifactQuery: { async findById() { return null } },
      resultArtifacts: {
        async persistOrReplay(input) { ledgerCalls.push(input.records); return { records: input.records, replayed: false } },
        async listByJob() { return ledgerCalls.at(-1) ?? [] },
      },
      audioProber: { probeDurationSeconds: (path, options) => probeAudioDurationSeconds(path, options) },
      clock: () => new Date('2029-01-01T00:00:10.000Z'),
    })
    const artifact = await ingestor.ingest({ job: job(), providerResult })
    assert.equal(artifact.mediaType, 'audio')
    assert.equal(artifact.artifactSha256, audioSha256)
    assert.equal(persistedBundles.length, 2)
    const [audioBundle, alignmentBundle] = persistedBundles
    assert.equal(audioBundle.manifest.artifact.mediaType, 'audio')
    assert.equal(audioBundle.manifest.artifact.container, 'mp3')
    assert.equal(audioBundle.manifest.recipe.id, 'synthetic-tts-result')
    assert.equal(alignmentBundle.manifest.artifact.mediaType, 'data')
    assert.equal(alignmentBundle.manifest.sources[0].role, 'tts-primary-audio')
    assert.equal(alignmentBundle.manifest.sources[0].execution.model.id, 'eleven_multilingual_v2')
    assert.equal(ledgerCalls.length, 1)
    const [records] = ledgerCalls
    assert.deepEqual(records.map(({ role }) => role), ['primary-audio', 'alignment-evidence'])
    assert.equal(records[0].artifactSha256, audioSha256)
    assert.equal(records[0].providerJobRef, 'elevenlabs_request_123')
    assert.equal(records[0].adapterConfigHash, hash('4'))
    assert.equal(records[0].scriptHash, SCRIPT_HASH)
    assert.equal(records[1].mediaType, 'data')
    const alignmentStored = await readFile(join(storedRoot, basename(`${records[1].artifactSha256}.json`)), 'utf8')
    const evidence = JSON.parse(alignmentStored)
    assert.equal(evidence.schemaVersion, 'tts-alignment-evidence/v1')
    assert.equal(evidence.characters.join(''), SCRIPT)
    assert.equal(evidence.audioSha256, audioSha256)

    const critic = new PersistedTtsResultCritic(
      { async findById(_workspace, artifactId) { return artifactId === artifact.artifactId ? { sha256: artifact.artifactSha256, byteSize: BigInt(artifact.byteSize), mediaType: 'audio', manifests: [{ probe: { width: 0, height: 0, duration: 2, fps: 0 } }] } : null } },
      { async listByJob() { return records }, async persistOrReplay() { throw new Error('unreachable') } },
    )
    const verdict = await critic.evaluate({ job: job(), artifact })
    assert.equal(verdict.approved, true)
    assert.match(verdict.resultHash, /^[a-f0-9]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-101 TTS ingestor fails closed on identity drift, tampered bytes and script mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-tts-ingest-fail-'))
  try {
    const audioBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 5)])
    const base = {
      requestId: 'elevenlabs_request_123', modelId: 'eleven_multilingual_v2', adapterConfigHash: hash('4'),
      scriptHash: SCRIPT_HASH, audioBytes: new Uint8Array(audioBytes),
      audioSha256: createHash('sha256').update(audioBytes).digest('hex'),
      audioByteSize: audioBytes.byteLength, audioContainer: 'mp3', mediaType: 'audio', alignment: alignment(),
    }
    const ingestor = new VerifiedTtsResultIngestor({
      workRoot: join(root, 'work'),
      storage: { async promoteDerived() { throw new Error('unreachable') } },
      artifacts: { async persistOrReplay() { throw new Error('unreachable') } },
      artifactQuery: { async findById() { return null } },
      resultArtifacts: { async persistOrReplay() { throw new Error('unreachable') }, async listByJob() { return [] } },
      audioProber: { async probeDurationSeconds() { throw new Error('unreachable') } },
    })
    await assert.rejects(() => ingestor.ingest({ job: job({ providerJobId: 'other_request' }), providerResult: base }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    await assert.rejects(() => ingestor.ingest({ job: job(), providerResult: { ...base, audioSha256: hash('9') } }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    await assert.rejects(() => ingestor.ingest({ job: job(), providerResult: { ...base, scriptHash: hash('8') } }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    await assert.rejects(() => ingestor.ingest({ job: job(), providerResult: { ...base, alignment: null } }), (error) => error.code === 'RENDER_OUTPUT_INVALID')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-101 TTS critic rejects a job whose alignment ledger entry is missing', async () => {
  const artifact = { artifactId: 'tts-audio-x', artifactSha256: hash('5'), mediaType: 'audio', byteSize: 100 }
  const critic = new PersistedTtsResultCritic(
    { async findById() { return { sha256: hash('5'), byteSize: 100n, mediaType: 'audio', manifests: [{ probe: { width: 0, height: 0, duration: 2, fps: 0 } }] } } },
    { async listByJob() { return [{ role: 'primary-audio', artifactId: 'tts-audio-x', artifactSha256: hash('5') }] }, async persistOrReplay() { throw new Error('unreachable') } },
  )
  await assert.rejects(() => critic.evaluate({ job: job(), artifact }), (error) => error.code === 'PERSISTENCE_CONFLICT')
})
