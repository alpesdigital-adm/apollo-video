import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { createSubtitleCssPreview } from '../../src/v2/public-api/subtitle-style-contract.ts'
import { SUBTITLE_STYLE_REGISTRY } from '../../src/v2/domain/subtitle-system.ts'

test('T-FR-170 public API exposes exact registry and instant content-addressed CSS preview', async () => {
  assert.deepEqual(Object.keys(SUBTITLE_STYLE_REGISTRY.presets), ['kinetic', 'karaoke-box', 'karaoke-pill', 'caps-stroke', 'clean-color'])
  assert.match(SUBTITLE_STYLE_REGISTRY.registryHash, /^[a-f0-9]{64}$/)
  const body = createSubtitleCssPreview({ presetId: 'caps-stroke', text: 'AÇÃO, CORAÇÃO E ÊXITO', format: '16:9', background: 'light' })
  assert.equal(body.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
  assert.equal(body.presetHash, SUBTITLE_STYLE_REGISTRY.presets['caps-stroke'].presetHash)
  assert.match(body.css, /text-transform:uppercase/)
  assert.match(body.previewHash, /^[a-f0-9]{64}$/)
  assert.throws(() => createSubtitleCssPreview({ presetId: 'unknown', text: 'x', format: '9:16', background: 'dark' }), /invalid/)
  const route = await readFile(new URL('../../src/app/v1/subtitle-styles/route.ts', import.meta.url), 'utf8')
  assert.match(route, /readSubtitleStyleRegistry/)
  assert.match(route, /createSubtitleCssPreview/)
})

test('T-FR-170 capability and public schema examples remain in parity', () => {
  for (const id of ['apollo.subtitle-styles.list', 'apollo.subtitle-styles.preview']) {
    assert.ok(FOUNDATION_CAPABILITIES.some((capability) => capability.id === id))
  }
  assert.equal(publicSchemaExamples(getPublicSchema('apollo://schemas/subtitle-style-registry/v2')).length, 1)
  assert.equal(publicSchemaExamples(getPublicSchema('apollo://schemas/subtitle-css-preview/v1')).length, 1)
})
