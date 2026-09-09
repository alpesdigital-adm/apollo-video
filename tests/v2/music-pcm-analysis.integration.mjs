import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FfmpegMusicSignalAnalyzer } from '../../src/v2/infrastructure/analysis/ffmpeg-music-signal-analyzer.ts'
import { resolveFfmpegBinary } from '../../src/v2/infrastructure/media/ffmpeg-binary.ts'

test('FFmpeg adapter derives versioned energy and beat confidence from decoded PCM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-music-pcm-'))
  try {
    const filePath = join(directory, 'pulse.wav')
    const ffmpeg = resolveFfmpegBinary()
    const sampleRate = 44_100, seconds = 8, dataBytes = sampleRate * seconds * 2
    const wav = Buffer.alloc(44 + dataBytes)
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40)
    for (let index = 0; index < sampleRate * seconds; index += 1) { const t = index / sampleRate; const value = t % .5 < .04 ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 29_000) : 0; wav.writeInt16LE(value, 44 + index * 2) }
    await writeFile(filePath, wav)
    const bytes = await readFile(filePath)
    const result = await new FfmpegMusicSignalAnalyzer({ ffmpegPath: ffmpeg }).analyzeVerifiedFile({ filePath, sourceArtifactId: 'music-artifact', sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceByteSize: bytes.length })
    assert.equal(result.schemaVersion, 'music-analysis/v1')
    assert.ok(result.energyCurve.some((point) => point.value > .5))
    assert.ok(result.beats.length >= 14)
    assert.ok(result.tempo.bpm !== null && Math.abs(result.tempo.bpm - 120) < 3)
    for (let index = 0; index < result.beats.length; index += 1) {
      const nearestExpected = Math.round(result.beats[index].atMs / 500) * 500
      assert.ok(Math.abs(result.beats[index].atMs - nearestExpected) <= 35)
    }
    assert.ok(result.limitations.includes('downbeats-not-inferred-without-independent-meter-evidence'))
    assert.equal(result.beats.some((beat) => beat.kind === 'downbeat-candidate'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
