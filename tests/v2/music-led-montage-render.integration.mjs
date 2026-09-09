import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const ffprobe = require('ffprobe-static').path
const metadata = { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 }
function compilation() {
  const probe = createMediaColorProbe({ id: 'probe-video', workspaceId: 'workspace-music', artifactId: 'video-source', manifestId: 'manifest-video', detection: { state: 'ready', metadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' }, producer: { provider: 'ffprobe', version: 'v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-09-08T12:00:00.000Z' })
  const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
  return createColorPipelineCompilation({ id: 'color-video', workspaceId: 'workspace-music', projectId: 'project-music', sourceArtifactId: 'video-source', sourceManifestId: 'manifest-video', probe, outputMetadata: metadata, createdByClientId: 'client-music', createdAt: '2026-09-08T12:00:00.000Z', stages: [{ id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: metadata, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) }, { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: metadata, output: metadata, implementation: implementation('apollo-match', { mode: 'bypass' }) }, { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: metadata, output: metadata, implementation: implementation('apollo-lut', { mode: 'none' }) }, { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: metadata, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) }] })
}
function bandVolume(path, frequency) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', `bandpass=f=${frequency}:width_type=h:w=80,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(result.stderr)?.[1] ?? -100)
}
function truePeak(path) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  const matches = [...result.stderr.matchAll(/Peak:\s*(-?[\d.]+) dBFS/g)]
  return Number(matches.at(-1)?.[1] ?? Number.NaN)
}

test('music-led renderer produces a controlled MP4 with source audio and approved music bands', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-music-render-'))
  try {
    const video = join(root, 'video.mp4'), music = join(root, 'music.wav')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], { windowsHide: true, timeout: 60_000 })
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=4', music], { windowsHide: true, timeout: 60_000 })
    const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath: ffmpeg })
    const baseInput = { renderKind: 'proxy', sources: [{ artifactId: 'video-source', path: video, mediaType: 'video', colorPipelineCompilation: compilation() }, { artifactId: 'music-source', path: music, mediaType: 'audio' }], lutPaths: {}, clips: [{ id: 'clip-1', sourceArtifactId: 'video-source', sourceInFrame: 0, sourceOutFrame: 50, timelineInFrame: 0, timelineOutFrame: 50, rate: 1 }, { id: 'clip-2', sourceArtifactId: 'video-source', sourceInFrame: 50, sourceOutFrame: 100, timelineInFrame: 50, timelineOutFrame: 100, rate: 1 }], fps: 25, format: '16:9', transitions: [{ id: 'seam-1', fromClipId: 'clip-1', toClipId: 'clip-2', atFrame: 50, type: 'straight-cut', audioFadeMs: 24, reason: 'confident beat' }] }
    const control = await renderer.render({ ...baseInput, operationId: 'music-render-control' })
    const result = await renderer.render({ ...baseInput, operationId: 'music-render-operation', backgroundMusic: { id: 'music-track', kind: 'background-music', artifactId: 'music-source', analysisId: 'analysis-1', analysisHash: 'a'.repeat(64), rightsSnapshotId: 'rights-1', sourceInFrame: 0, sourceOutFrame: 100, timelineInFrame: 0, timelineOutFrame: 100, gainDb: -18, fadeInFrames: 5, fadeOutFrames: 10 } })
    assert.ok((await stat(result.outputPath)).size > 1_000)
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,sample_rate:format=duration', '-of', 'json', result.outputPath], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }))
    const videoStream = probe.streams.find((stream) => stream.codec_type === 'video')
    const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio')
    assert.deepEqual([videoStream.codec_name, videoStream.width, videoStream.height, videoStream.r_frame_rate, Number(videoStream.nb_read_frames)], ['h264', 960, 540, '25/1', 100])
    assert.equal(audioStream.codec_name, 'aac')
    assert.equal(Number(audioStream.sample_rate), 48_000)
    assert.ok(Math.abs(Number(probe.format.duration) - 4) <= 0.05)
    assert.ok(bandVolume(result.outputPath, 440) > -35, 'source-audio tone was not preserved')
    const mixedMusicBandDb = bandVolume(result.outputPath, 1000)
    const controlMusicBandDb = bandVolume(control.outputPath, 1000)
    assert.ok(mixedMusicBandDb > -50, 'music tone was not mixed audibly')
    assert.ok(mixedMusicBandDb >= controlMusicBandDb + 6, `music band did not rise over control (${mixedMusicBandDb} vs ${controlMusicBandDb} dB)`)
    const peakDb = truePeak(result.outputPath)
    assert.ok(Number.isFinite(peakDb) && peakDb <= -1 && peakDb >= -30, `mixed peak ${peakDb} dB is outside the bounded golden range`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
