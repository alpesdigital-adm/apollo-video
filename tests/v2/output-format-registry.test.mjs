import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  customizeOutputFormatPreset,
  OUTPUT_FORMAT_REGISTRY,
  readOutputFormatPreset,
  validateOutputCompatibility,
} from '../../src/v2/domain/output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/output-spec.ts'
import { PROXY_OUTPUT_SPECS } from '../../src/v2/application/render-workflow.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

test('T-FR-160 registry v1 owns five content-addressed format presets and renderer defaults', () => {
  assert.equal(OUTPUT_FORMAT_REGISTRY.schemaVersion, 'output-format-registry/v1')
  assert.equal(OUTPUT_FORMAT_REGISTRY.registryVersion, 1)
  assert.deepEqual(Object.keys(OUTPUT_FORMAT_REGISTRY.presets), [...OUTPUT_ASPECT_RATIOS])
  const { registryHash: _registryHash, ...registryBody } = OUTPUT_FORMAT_REGISTRY
  assert.equal(OUTPUT_FORMAT_REGISTRY.registryHash, calculateCanonicalHash(registryBody))

  for (const ratio of OUTPUT_ASPECT_RATIOS) {
    const preset = readOutputFormatPreset(ratio)
    const { presetHash: _presetHash, ...presetBody } = preset
    assert.equal(preset.presetHash, calculateCanonicalHash(presetBody))
    assert.equal(preset.spec.aspectRatio, ratio)
    assert.equal(preset.spec.fps, 30)
    assert.equal(preset.exportDefaults.final.codec, 'h264')
    assert.equal(preset.exportDefaults.final.audioCodec, 'aac')
    assert.equal(preset.exportDefaults.final.container, 'mp4')
    assert.deepEqual(
      [PROXY_OUTPUT_SPECS[ratio].width, PROXY_OUTPUT_SPECS[ratio].height],
      [preset.exportDefaults.proxy.width, preset.exportDefaults.proxy.height],
    )
    const bounds = preset.subtitleBounds
    assert.ok(bounds.x >= preset.spec.safeArea.left)
    assert.ok(bounds.y >= preset.spec.safeArea.top)
    assert.ok(bounds.x + bounds.width <= 1 - preset.spec.safeArea.right)
    assert.ok(bounds.y + bounds.height <= 1 - preset.spec.safeArea.bottom)
  }
})

test('T-FR-160 customization preserves nominal ratio and produces a new content identity', () => {
  const square = customizeOutputFormatPreset('1:1', { width: 720, height: 720, fps: 60 })
  assert.equal(square.spec.aspectRatio, '1:1')
  assert.equal(square.spec.fps, 60)
  assert.notEqual(square.presetHash, readOutputFormatPreset('1:1').presetHash)
  assert.throws(
    () => customizeOutputFormatPreset('9:16', { width: 1000, height: 1000 }),
    (error) => error instanceof DomainError && error.code === 'INVALID_OUTPUT_SPEC',
  )
})

test('T-FR-160 compatibility fails closed for platform and media profile mismatches', () => {
  assert.doesNotThrow(() => validateOutputCompatibility({
    aspectRatio: '9:16', platform: 'instagram-reels',
    codec: 'h264', audioCodec: 'aac', container: 'mp4', pixelFormat: 'yuv420p',
  }))
  for (const input of [
    { aspectRatio: '21:9', platform: 'instagram-reels', codec: 'h264', audioCodec: 'aac', container: 'mp4' },
    { aspectRatio: '16:9', platform: 'youtube', codec: 'hevc', audioCodec: 'aac', container: 'mp4' },
    { aspectRatio: '16:9', platform: 'youtube', codec: 'h264', audioCodec: 'opus', container: 'webm' },
  ]) assert.throws(
    () => validateOutputCompatibility(input),
    (error) => error instanceof DomainError && error.code === 'INVALID_OUTPUT_SPEC',
  )
})

test('T-FR-160 public schema publishes preset and registry v1 contracts', () => {
  assert.equal(getPublicSchema('apollo://schemas/output-format-preset/v1').version, 1)
  const registry = getPublicSchema('apollo://schemas/output-format-registry/v1')
  assert.deepEqual(registry.schema.properties.presets.required, [...OUTPUT_ASPECT_RATIOS])
  assert.equal(registry.schema.properties.registryHash.pattern, '^[a-f0-9]{64}$')
})
