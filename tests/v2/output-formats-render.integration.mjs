import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { OUTPUT_FORMAT_REGISTRY } from '../../src/v2/domain/output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/output-spec.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const sourceArtifactId = 'artifact-format-smoke-source'

function colorCompilation() {
  const metadata = { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 }
  const probe = createMediaColorProbe({
    id: 'probe-format-smoke', workspaceId: 'workspace-format-smoke', artifactId: sourceArtifactId,
    manifestId: 'manifest-format-smoke-source', detection: { state: 'ready', metadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-08-13T20:00:00.000Z',
  })
  const implementation = (kind, mode) => ({ provider: kind, version: 'v1', parameters: { mode }, parametersHash: calculateCanonicalHash({ mode }) })
  return createColorPipelineCompilation({
    id: 'compilation-format-smoke', workspaceId: probe.workspaceId, projectId: 'project-format-smoke',
    sourceArtifactId, sourceManifestId: 'manifest-format-smoke-source', probe, outputMetadata: metadata,
    createdByClientId: 'client-format-smoke', createdAt: '2026-08-13T20:01:00.000Z',
    stages: [
      { id: 'technical-format', kind: 'technical', version: 'v1', enabled: true, input: metadata, output: metadata, implementation: implementation('ffmpeg-zscale', 'identity') },
      { id: 'match-format', kind: 'match', version: 'v1', enabled: false, input: metadata, output: metadata, implementation: implementation('apollo-match', 'bypass') },
      { id: 'creative-format', kind: 'creative-lut', version: 'v1', enabled: false, input: metadata, output: metadata, implementation: implementation('apollo-lut', 'none') },
      { id: 'output-format', kind: 'output', version: 'v1', enabled: true, input: metadata, output: metadata, implementation: implementation('ffmpeg-zscale', 'identity') },
    ],
  })
}

test('T-FR-160 real FFmpeg smoke renders and manifests all five required formats', { timeout: 5 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-output-formats-'))
  const sourcePath = join(root, 'source.mp4')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', sourcePath,
    ], { windowsHide: true })
    const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'work'), ffmpegPath })
    const compilation = colorCompilation()
    const manifests = []
    for (const ratio of OUTPUT_ASPECT_RATIOS) {
      const preset = OUTPUT_FORMAT_REGISTRY.presets[ratio]
      const result = await renderer.render({
        operationId: `format-smoke-${ratio.replace(':', 'x')}`, renderKind: 'proxy',
        sources: [{ artifactId: sourceArtifactId, path: sourcePath, mediaType: 'video', colorPipelineCompilation: compilation }],
        lutPaths: {}, clips: [{ id: `clip-${ratio.replace(':', 'x')}`, sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 }],
        fps: 30, format: ratio,
        subtitleCues: [{ id: `subtitle-${ratio.replace(':', 'x')}`, startFrame: 0, endFrame: 30, text: 'Formato seguro', anchor: 'bottom' }],
      })
      const streams = JSON.parse(execFileSync(ffprobePath, [
        '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,duration', '-of', 'json', result.outputPath,
      ], { encoding: 'utf8', windowsHide: true })).streams
      const video = streams.find((stream) => stream.codec_type === 'video')
      const audio = streams.find((stream) => stream.codec_type === 'audio')
      assert.deepEqual([video.width, video.height], [preset.exportDefaults.proxy.width, preset.exportDefaults.proxy.height])
      assert.equal(Number(video.nb_read_frames), 30)
      assert.equal(video.codec_name, 'h264')
      assert.equal(audio.codec_name, 'aac')
      assert.ok(Math.abs(Number(video.duration) - Number(audio.duration)) <= 1 / 30)

      const raw = execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', result.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      let minX = video.width; let minY = video.height; let maxX = -1; let maxY = -1
      for (let pixel = 0; pixel < video.width * video.height; pixel += 1) {
        const offset = pixel * 3
        if (raw[offset] > 190 && raw[offset + 1] > 190 && raw[offset + 2] > 190) {
          const x = pixel % video.width; const y = Math.floor(pixel / video.width)
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
      }
      assert.ok(maxX >= minX && maxY >= minY, `${ratio} subtitle must be visible`)
      const bounds = preset.subtitleBounds
      assert.ok(minX >= Math.floor(bounds.x * video.width) && maxX <= Math.ceil((bounds.x + bounds.width) * video.width), `${ratio} subtitle horizontal bounds`)
      assert.ok(minY >= Math.floor(bounds.y * video.height) && maxY <= Math.ceil((bounds.y + bounds.height) * video.height), `${ratio} subtitle vertical bounds`)

      const metadata = await stat(result.outputPath)
      const manifest = createMediaArtifactManifestV2({
        artifactKey: `workspaces/format-smoke/${ratio.replace(':', 'x')}.mp4`, artifactSha256: result.sha256,
        byteSize: metadata.size, mediaType: 'video', container: 'mp4',
        recipe: { id: 'output-format-smoke', version: '1.0.0', parameters: { registryHash: OUTPUT_FORMAT_REGISTRY.registryHash, presetHash: preset.presetHash, ratio } },
        probe: { width: result.probe.width, height: result.probe.height, duration: result.probe.duration, fps: result.probe.fps },
      })
      assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/)
      manifests.push(manifest)
      await renderer.cleanup(`format-smoke-${ratio.replace(':', 'x')}`)
    }
    assert.equal(manifests.length, 5)
    assert.equal(new Set(manifests.map((manifest) => manifest.recipe.parametersHash)).size, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
