import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRequire } from 'node:module'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import {
  buildFfmpegColorPipelineFilter,
  FfmpegColorPipelineProcessor,
} from '../../src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts'
import { FfmpegLutPreviewGenerator } from '../../src/v2/infrastructure/media/ffmpeg-lut-preview-generator.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const run = promisify(execFile)
const sourceMetadata = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709',
  matrix: 'bt709', range: 'limited', bitDepth: 10,
})
const outputMetadata = Object.freeze({ ...sourceMetadata, bitDepth: 8 })

function implementation(provider, parameters) {
  return Object.freeze({
    provider, version: 'v1', parameters: Object.freeze(parameters),
    parametersHash: calculateCanonicalHash(parameters),
  })
}

function compilation(sourceId, createdAt, creativeLut) {
  const probe = createMediaColorProbe({
    id: `probe-${sourceId}`,
    workspaceId: 'workspace-color-golden',
    artifactId: sourceId,
    manifestId: `manifest-${sourceId}`,
    detection: {
      state: 'ready', metadata: sourceMetadata,
      pixelFormat: 'yuv420p10le', hdrMode: 'sdr',
    },
    producer: {
      provider: 'ffprobe', version: 'json-v1',
      binaryDigest: '9'.repeat(64),
    },
    createdAt,
  })
  const stages = [
    { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: sourceMetadata, output: sourceMetadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    { id: 'match-source', kind: 'match', version: 'v1', enabled: false, input: sourceMetadata, output: sourceMetadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
    creativeLut
      ? { id: 'creative-selected', kind: 'creative-lut', version: 'v1', enabled: true, input: sourceMetadata, output: sourceMetadata, implementation: implementation('apollo-lut', { mode: 'lut3d', intensity: creativeLut.intensity }), lut: { artifactId: creativeLut.artifactId, sha256: creativeLut.sha256 } }
      : { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: sourceMetadata, output: sourceMetadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
    { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: sourceMetadata, output: outputMetadata, implementation: implementation('ffmpeg-zscale', { dither: true }) },
  ]
  return createColorPipelineCompilation({
    id: `compilation-${sourceId}`,
    workspaceId: probe.workspaceId,
    projectId: 'project-color-golden',
    sourceArtifactId: sourceId,
    sourceManifestId: probe.manifestId,
    probe,
    outputMetadata,
    stages,
    createdByClientId: 'client-color-golden',
    createdAt,
  })
}

async function generate(path, source) {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', source,
    '-vf', 'format=yuv420p10le',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-colorspace', 'bt709', '-color_range', 'tv', path,
  ], { windowsHide: true, timeout: 60_000 })
}

async function sampleRgb(path) {
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-frames:v', '1', '-vf', 'scale=64:36',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { windowsHide: true, timeout: 60_000, encoding: 'buffer', maxBuffer: 1024 * 1024 })
  return Buffer.from(stdout)
}

test('T-FR-180 applies technical, match, creative and output stages to real SDR fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-color-pipeline-'))
  try {
    const fixtures = [
      ['rec709-camera-a', 'testsrc2=s=320x180:r=24:d=1'],
      ['rec709-camera-b', 'smptebars=s=320x180:r=24:d=1'],
      ['rec709-clipping-ramp', "nullsrc=s=320x180:r=24:d=1,geq=lum='16+219*X/W':cb=128:cr=128"],
    ]
    const processor = new FfmpegColorPipelineProcessor({ ffmpegPath: ffmpeg })
    const results = []
    for (const [id, source] of fixtures) {
      const sourcePath = join(root, `${id}-source.mp4`)
      const outputPath = join(root, `${id}-output.mp4`)
      await generate(sourcePath, source)
      const plan = compilation(id, '2026-07-31T04:00:00.000Z')
      const compiled = buildFfmpegColorPipelineFilter({ compilation: plan })
      assert.ok(compiled.filter.indexOf('zscale=') < compiled.filter.indexOf('null'))
      assert.ok(compiled.filter.lastIndexOf('zscale=') > compiled.filter.indexOf('null'))
      results.push(await processor.process({ sourcePath, outputPath, compilation: plan }))
    }
    assert.equal(new Set(results.map((result) => result.sha256)).size, 3)
    for (const result of results) {
      assert.equal(result.probe.color.state, 'ready')
      assert.deepEqual(result.probe.color.metadata, outputMetadata)
      assert.equal(result.probe.color.pixelFormat, 'yuv420p')
    }
    const ramp = await sampleRgb(results[2].outputPath)
    const levels = new Set()
    for (let index = 0; index < ramp.length; index += 3) levels.add(ramp[index])
    assert.ok(levels.size >= 40, `expected preserved ramp detail, received ${levels.size} levels`)
    assert.ok(Math.min(...levels) <= 8)
    assert.ok(Math.max(...levels) >= 245)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-181 generates a real immutable PNG preview from a valid unicode .cube', async () => {
  const cube = `TITLE "Coração 🎞️"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n`
  const preview = await new FfmpegLutPreviewGenerator({ ffmpegPath: ffmpeg }).generate({ canonicalCube: cube })
  assert.equal(preview.width, 512)
  assert.equal(preview.height, 288)
  assert.ok(preview.png.byteLength > 1000)
  assert.deepEqual([...preview.png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(createHash('sha256').update(preview.png).digest('hex'), preview.sha256)
})

test('T-FR-181 applies only a pre-materialized selected LUT path in the real color processor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-color-selected-lut-'))
  try {
    const sourcePath = join(root, 'source.mp4'); const outputPath = join(root, 'selected.mp4'); const lutPath = join(root, 'selected.cube')
    const cube = `LUT_3D_SIZE 2\n1 0 0\n1 0 0\n1 0 0\n1 0 0\n1 0 0\n1 0 0\n1 0 0\n1 0 0\n`
    await Promise.all([generate(sourcePath, 'testsrc2=s=320x180:r=24:d=1'), writeFile(lutPath, cube, 'utf8')])
    const selected = compilation('selected-lut-source', '2026-07-31T17:30:00.000Z', { artifactId: 'selected-lut-version', sha256: 'a'.repeat(64), intensity: 0.5 })
    const processor = new FfmpegColorPipelineProcessor({ ffmpegPath: ffmpeg })
    assert.match(buildFfmpegColorPipelineFilter({ compilation: selected, lutPaths: { 'selected-lut-version': lutPath } }).filter, /lut3d=/)
    await assert.rejects(processor.process({ sourcePath, outputPath, compilation: selected }), /not materialized/)
    const result = await processor.process({ sourcePath, outputPath, compilation: selected, lutPaths: { 'selected-lut-version': lutPath } })
    assert.equal(result.probe.color.state, 'ready')
    assert.ok(result.byteSize > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
