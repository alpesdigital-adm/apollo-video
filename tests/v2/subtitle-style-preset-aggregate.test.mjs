import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createProjectSubtitleConfiguration } from '../../src/v2/domain/project-subtitle-configuration.ts'
import {
  materializeRenderInputSubtitles,
  requireRenderInputSubtitleRegistry,
} from '../../src/v2/domain/render-input-subtitles.ts'
import {
  assertSubtitleCadence,
  materializeSubtitlePresetSnapshot,
  readSubtitlePreset,
  requireSubtitlePresetSnapshot,
  resolveSubtitleRenderMetrics,
  SUBTITLE_CASINGS,
  SUBTITLE_PRESET_IDS,
  SUBTITLE_STYLE_ANCHORS,
  SUBTITLE_STYLE_REGISTRY,
  subtitlePresetReference,
  subtitleTextShadowCss,
  subtitleTextTransform,
  validateSubtitlePreset,
} from '../../src/v2/domain/subtitle-system.ts'
import { SUBTITLE_STYLE_REGISTRY_V1 } from '../../src/v2/public-api/subtitle-style-contract.ts'

const codeOf = (error) => error?.code ?? error?.details?.code ?? String(error?.message)

/**
 * Re-seals a preset body so the content address matches again. Every negative case below changes
 * exactly one token and re-seals, so the assertion proves the *rule* rejected it — not that the
 * hash happened to break.
 */
function seal(preset, patch) {
  const { presetHash, ...body } = { ...preset, ...patch }
  return Object.freeze({ ...body, presetHash: calculateCanonicalHash(body) })
}

const KINETIC = readSubtitlePreset('kinetic')
const BOX = readSubtitlePreset('karaoke-box')

test('T-FR-172 the aggregate carries shadow, placement, casing and grouping as first-class tokens', () => {
  for (const presetId of SUBTITLE_PRESET_IDS) {
    const preset = readSubtitlePreset(presetId)
    assert.equal(preset.schemaVersion, 'subtitle-style-preset/v2')
    assert.equal(preset.presetVersion, 1)
    assert.ok(SUBTITLE_CASINGS.includes(preset.casing), `${presetId} casing`)
    // The migrated tokens no longer exist on their old homes: nothing reads a boolean `uppercase`
    // or a `lineBreaking.chunkWords` any more, so a stale consumer fails loudly instead of silently.
    assert.equal(preset.typography.uppercase, undefined)
    assert.equal(preset.lineBreaking.chunkWords, undefined)
    assert.equal(preset.version, undefined)
    assert.equal(typeof preset.shadow.enabled, 'boolean')
    assert.equal(typeof preset.grouping.maxWordsPerGroup, 'number')
    for (const format of ['9:16', '16:9']) {
      assert.ok(SUBTITLE_STYLE_ANCHORS.includes(preset.placement.formats[format].anchor), `${presetId}/${format} anchor`)
      assert.equal(typeof preset.placement.formats[format].safeArea.bottom, 'number')
    }
  }
  // Exactly the casing/shadow split the five canonical presets were authored with.
  assert.equal(readSubtitlePreset('caps-stroke').casing, 'uppercase')
  assert.deepEqual(SUBTITLE_PRESET_IDS.filter((id) => readSubtitlePreset(id).casing !== 'none'), ['caps-stroke'])
  assert.deepEqual(SUBTITLE_PRESET_IDS.filter((id) => readSubtitlePreset(id).shadow.enabled), ['kinetic', 'caps-stroke', 'clean-color'])
  assert.equal(subtitleTextTransform('uppercase'), 'uppercase')
  assert.equal(subtitleTextTransform('title'), 'capitalize')
  assert.equal(subtitleTextShadowCss(KINETIC.shadow), '0px 3px 10px rgba(0,0,0,0.55)')
  assert.equal(subtitleTextShadowCss(BOX.shadow), undefined)
})

test('T-FR-172 the five canonical preset ids survive the shape change and stay pairwise distinct', () => {
  assert.deepEqual([...SUBTITLE_PRESET_IDS], ['kinetic', 'karaoke-box', 'karaoke-pill', 'caps-stroke', 'clean-color'])
  const hashes = SUBTITLE_PRESET_IDS.map((id) => readSubtitlePreset(id).presetHash)
  assert.equal(new Set(hashes).size, 5, 'two presets collapsed onto the same content address')
  assert.equal(new Set(hashes.map((hash) => /^[a-f0-9]{64}$/.test(hash))).size, 1)
  // The registry hash covers every preset: editing one token moves the whole registry address.
  const { registryHash, ...body } = SUBTITLE_STYLE_REGISTRY
  assert.equal(registryHash, calculateCanonicalHash(body))
})

test('T-FR-172 the v1 registry stays published and still resolves to its original content addresses', () => {
  // The v2 shape is additive: v1 is not withdrawn, it is derived from the same live tokens. These
  // are the literal hashes the v1 registry published before F1.035 (read from the base commit), so
  // a client that pinned registryHash under v1 keeps resolving the byte-identical document. If a
  // future edit changes a shared token, this test fails — which is the correct signal, because the
  // v1 document would genuinely have changed.
  assert.equal(SUBTITLE_STYLE_REGISTRY_V1.schemaVersion, 'subtitle-style-registry/v1')
  assert.equal(SUBTITLE_STYLE_REGISTRY_V1.registryVersion, 1)
  assert.equal(SUBTITLE_STYLE_REGISTRY_V1.registryHash, '32bb33c486bb3d0cc289eb20f189d6ababec3c4a08ea4a62089464bac2739369')
  assert.deepEqual(
    Object.fromEntries(SUBTITLE_PRESET_IDS.map((id) => [id, SUBTITLE_STYLE_REGISTRY_V1.presets[id].presetHash])),
    {
      kinetic: 'be6d5ffb134f3df4ce1d010583b32562a913fc4fd01c30050ce8d3b8e4185f1b',
      'karaoke-box': '8b2e26f7315535796d25b204c1c74e4ed0e67b23858339e7d7587b246640948c',
      'karaoke-pill': '71340893da64451dd04eaddb6f4f3a1f7f329591f0b9e95a276825ffb52d2c19',
      'caps-stroke': '4350b983490cc631817ca031723262414e1d5d1da43e8ab9fd418f0449b69c66',
      'clean-color': '490bc89964beae126d72755b98fb29a64caceba28ad30b79037423a0d21ccea0',
    },
  )
  // The projection is the inverse of the extraction, not a frozen copy: the v1 fields are the very
  // tokens F1.035 pulled out, read back under their original names.
  assert.equal(SUBTITLE_STYLE_REGISTRY_V1.presets['caps-stroke'].typography.uppercase, true)
  assert.equal(SUBTITLE_STYLE_REGISTRY_V1.presets.kinetic.typography.uppercase, false)
  for (const presetId of SUBTITLE_PRESET_IDS) {
    assert.equal(SUBTITLE_STYLE_REGISTRY_V1.presets[presetId].lineBreaking.chunkWords, readSubtitlePreset(presetId).grouping.maxWordsPerGroup)
  }
  // And the two published documents are genuinely different addresses — v2 is not v1 relabelled.
  assert.notEqual(SUBTITLE_STYLE_REGISTRY_V1.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
})

test('T-FR-172 casing, grouping and cadence tokens fail closed one rule at a time', () => {
  assert.throws(() => validateSubtitlePreset(seal(KINETIC, { casing: 'sentence' })), (e) => codeOf(e) === 'INVALID_ARGUMENT')
  assert.throws(() => validateSubtitlePreset(seal(KINETIC, { grouping: { ...KINETIC.grouping, maxWordsPerGroup: 0 } })), (e) => codeOf(e) === 'INVALID_ARGUMENT')
  assert.throws(() => validateSubtitlePreset(seal(KINETIC, { grouping: { ...KINETIC.grouping, maxWordsPerGroup: 9 } })), (e) => codeOf(e) === 'INVALID_ARGUMENT')
  // min >= max is unsatisfiable cadence.
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { grouping: { ...KINETIC.grouping, minOnScreenMs: 5_000, maxOnScreenMs: 5_000 } })),
    /cadence is invalid/,
  )
  // A merge threshold at or above the minimum hold would merge groups it just accepted.
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { grouping: { ...KINETIC.grouping, gapMergeMs: 400 } })),
    /cadence is invalid/,
  )
  // 8 words cannot fit one 26-character line even at 4 cells per word (8×4 = 32 > 26).
  assert.throws(
    () => validateSubtitlePreset(seal(readSubtitlePreset('karaoke-pill'), {
      grouping: { ...readSubtitlePreset('karaoke-pill').grouping, maxWordsPerGroup: 8 },
    })),
    /cannot fit the authored line budget/,
  )
})

test('T-FR-172 shadow tokens must agree with the state they declare', () => {
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { shadow: { ...KINETIC.shadow, enabled: false } })),
    /shadow tokens disagree/,
  )
  assert.throws(
    () => validateSubtitlePreset(seal(BOX, { shadow: { ...BOX.shadow, enabled: true } })),
    /shadow tokens disagree/,
  )
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { shadow: { ...KINETIC.shadow, color: '#00ff00' } })),
    /shadow tokens disagree/,
  )
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { shadow: { ...KINETIC.shadow, blurPx: 128 } })),
    /shadow tokens disagree/,
  )
})

test('T-FR-172 placement bounds and safe area fail closed per format', () => {
  const anchorless = seal(KINETIC, {
    placement: { formats: { ...KINETIC.placement.formats, '9:16': { ...KINETIC.placement.formats['9:16'], anchor: 'sky-high' } } },
  })
  assert.throws(() => validateSubtitlePreset(anchorless), /placement anchor is not registered/)

  // maxWidth .86 cannot fit inside a safe area that reserves 10% on each side.
  const tooWide = seal(KINETIC, {
    placement: { formats: { ...KINETIC.placement.formats, '9:16': { anchor: 'bottom', safeArea: { top: .10, bottom: .06, horizontal: .10 } } } },
  })
  assert.throws(() => validateSubtitlePreset(tooWide), /wider than the safe area/)

  // A bottom offset of .12 sits under a 20% bottom reserve — the block would land on the UI bar.
  const belowSafeArea = seal(KINETIC, {
    placement: { formats: { ...KINETIC.placement.formats, '9:16': { anchor: 'bottom', safeArea: { top: .10, bottom: .20, horizontal: .05 } } } },
  })
  assert.throws(() => validateSubtitlePreset(belowSafeArea), /leaves the safe area/)

  // A `top` anchor at offset .12 puts the block head at 1690/1920 of the canvas; a 20% top reserve
  // ends at 1536, so the block would sit inside the reserved band and the preset is refused.
  const aboveSafeArea = seal(KINETIC, {
    placement: { formats: { ...KINETIC.placement.formats, '9:16': { anchor: 'top', safeArea: { top: .20, bottom: .06, horizontal: .05 } } } },
  })
  assert.throws(() => validateSubtitlePreset(aboveSafeArea), /leaves the safe area/)

  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, {
      placement: { formats: { ...KINETIC.placement.formats, '16:9': { anchor: 'bottom', safeArea: { top: .4, bottom: .05, horizontal: .04 } } } },
    })),
    /safe area is invalid/,
  )
})

test('T-FR-172 incompatible token combinations are refused instead of arbitrated by the renderer', () => {
  assert.throws(
    () => validateSubtitlePreset(seal(BOX, { stroke: { widthEm: .1, color: '#000000' } })),
    /cannot combine an opaque container with a stroke/,
  )
  assert.throws(
    () => validateSubtitlePreset(seal(BOX, { highlight: { mode: 'none', color: '#F7C948', inactiveColor: '#FFFFFF' } })),
    /Karaoke animation requires a highlight mode/,
  )
  // The licence/coverage gate the aggregate inherited still holds on the new shape.
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { typography: { ...KINETIC.typography, licenseSpdx: 'MIT' } })),
    /OFL-1.1 licensed/,
  )
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { typography: { ...KINETIC.typography, glyphCoverage: 'latin' } })),
    /latin-ext coverage/,
  )
  assert.throws(
    () => validateSubtitlePreset(seal(KINETIC, { typography: { ...KINETIC.typography, fallback: [] } })),
    /fallback/,
  )
})

test('T-FR-172 render metrics resolve the authored anchor and hold every canonical preset inside the safe area', () => {
  const canvases = { '9:16': [960, 1920], '16:9': [540, 1080] }
  const measured = []
  for (const presetId of SUBTITLE_PRESET_IDS) {
    const preset = readSubtitlePreset(presetId)
    for (const format of ['9:16', '16:9']) for (const height of canvases[format]) {
      const metrics = resolveSubtitleRenderMetrics(preset, format, height)
      measured.push({ presetId, format, height, ...metrics })
      assert.equal(metrics.anchor, preset.placement.formats[format].anchor)
      assert.ok(metrics.bottomPx >= Math.floor(height * metrics.safeArea.bottom), `${presetId}/${format}@${height} bottom`)
      assert.ok(metrics.bottomPx + metrics.blockPx <= Math.ceil(height * (1 - metrics.safeArea.top)), `${presetId}/${format}@${height} top`)
      // Anchor 'bottom' keeps the F1.033 geometry byte-for-byte: the offset IS the authored bottom.
      assert.equal(metrics.bottomPx, Math.round(height * preset.responsive.formats[format].bottom))
    }
  }
  assert.equal(measured.length, 20)
  console.log('T-FR-172 resolved geometry (20 preset × format × canvas combinations):')
  for (const item of measured) {
    console.log(`  ${item.presetId.padEnd(13)} ${item.format.padEnd(5)} h=${String(item.height).padStart(4)} anchor=${item.anchor.padEnd(6)} fontPx=${String(item.fontPx).padStart(3)} bottomPx=${String(item.bottomPx).padStart(4)} blockPx=${String(item.blockPx).padStart(3)}`)
  }

  // A moved anchor moves the block: placement is a real geometric token, not a label.
  const centered = seal(KINETIC, {
    placement: { formats: { ...KINETIC.placement.formats, '9:16': { ...KINETIC.placement.formats['9:16'], anchor: 'center' } } },
  })
  const base = resolveSubtitleRenderMetrics(KINETIC, '9:16', 1920)
  const moved = resolveSubtitleRenderMetrics(validateSubtitlePreset(centered), '9:16', 1920)
  assert.equal(base.bottomPx, 230)
  assert.equal(moved.bottomPx, 892)
  assert.ok(moved.bottomPx - base.bottomPx > 600, 'a center anchor must displace the block by hundreds of pixels')
})

test('T-FR-172 cadence is enforced against the cues that will actually be drawn', () => {
  const cues = [{ startMs: 0, endMs: 1_200 }, { startMs: 1_400, endMs: 2_600 }]
  assert.doesNotThrow(() => assertSubtitleCadence(KINETIC, cues))
  // Under minOnScreenMs (400).
  assert.throws(() => assertSubtitleCadence(KINETIC, [{ startMs: 0, endMs: 200 }]), /outside the preset cadence/)
  // Over maxOnScreenMs (5000).
  assert.throws(() => assertSubtitleCadence(KINETIC, [{ startMs: 0, endMs: 6_000 }]), /outside the preset cadence/)
  // A 40 ms hole below gapMergeMs (120) should have been merged upstream, never drawn as a flicker.
  assert.throws(
    () => assertSubtitleCadence(KINETIC, [{ startMs: 0, endMs: 1_000 }, { startMs: 1_040, endMs: 2_040 }]),
    /gap-merge threshold/,
  )
  // Back-to-back cues (zero gap) are a continuous read, not a flicker, and are allowed.
  assert.doesNotThrow(() => assertSubtitleCadence(KINETIC, [{ startMs: 0, endMs: 1_000 }, { startMs: 1_000, endMs: 2_000 }]))
})

// ---------------------------------------------------------------------------
// Reproducibility: a render input materialized today must keep drawing with the
// tokens it was materialized from, even after the registry evolves.
// ---------------------------------------------------------------------------

const TRANSCRIPT_HASH = 'a'.repeat(64)
const configurationFor = (presetId) => createProjectSubtitleConfiguration({
  id: `subtitle-config-${presetId}`, workspaceId: 'workspace-1', projectId: 'project-1',
  baseVersionId: 'version-1', resultVersionId: 'version-2', commandId: 'command-1',
  variantId: '9:16', action: 'set', previousConfigurationId: null,
  requested: presetId === null ? { mode: 'none' } : { mode: 'manual', presetId, presetVersion: 1 },
  resolved: presetId === null ? { enabled: false } : { enabled: true, ...subtitlePresetReference(presetId) },
  origin: presetId === null ? 'disabled' : 'project',
  transcriptHash: TRANSCRIPT_HASH, createdAt: '2026-08-21T10:00:00.000Z',
})

test('T-FR-172 the render input carries the resolved preset content-addressed', () => {
  const cues = Object.freeze([Object.freeze({ text: 'Ação com clareza', startMs: 0, endMs: 1_500 })])
  const section = materializeRenderInputSubtitles({ configuration: configurationFor('caps-stroke'), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues })

  assert.equal(section.schemaVersion, 'render-input-subtitles/v3')
  assert.equal(section.presetSnapshot.presetId, 'caps-stroke')
  assert.equal(section.presetSnapshot.presetHash, readSubtitlePreset('caps-stroke').presetHash)
  // The tokens travel, not just the name: casing/shadow/placement are readable without the registry.
  assert.equal(section.presetSnapshot.tokens.casing, 'uppercase')
  assert.equal(section.presetSnapshot.tokens.placement.formats['9:16'].anchor, 'bottom')
  assert.doesNotThrow(() => requireRenderInputSubtitleRegistry(section))

  // Tampering with the materialized tokens is caught by the snapshot's own content address.
  const tamperedTokens = { ...section.presetSnapshot, tokens: { ...section.presetSnapshot.tokens, casing: 'none' } }
  assert.throws(() => requireSubtitlePresetSnapshot(tamperedTokens), (e) => codeOf(e) === 'PERSISTENCE_CONFLICT')
  // …including when the tamperer re-seals the preset but not the snapshot.
  const resealed = { ...section.presetSnapshot, tokens: seal(section.presetSnapshot.tokens, { casing: 'none' }) }
  assert.throws(() => requireSubtitlePresetSnapshot(resealed), (e) => codeOf(e) === 'PERSISTENCE_CONFLICT')

  // A disabled resolution carries no snapshot at all.
  const disabled = materializeRenderInputSubtitles({
    configuration: configurationFor(null), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues,
  })
  assert.equal(disabled.presetSnapshot, null)
  assert.doesNotThrow(() => requireRenderInputSubtitleRegistry(disabled))
})

test('T-FR-172 a section materialized against an older registry still replays from its own snapshot', () => {
  const cues = Object.freeze([Object.freeze({ text: 'Ação com clareza', startMs: 0, endMs: 1_500 })])
  const section = materializeRenderInputSubtitles({ configuration: configurationFor('kinetic'), variantId: '9:16', transcriptHash: TRANSCRIPT_HASH, cues })
  assert.equal(section.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)

  // Simulate the registry evolving under a persisted render: the section keeps naming the registry
  // revision it was compiled against, and its snapshot keeps the tokens of that revision. Nothing
  // here reads the live registry — that is exactly what makes the old render reproducible.
  const olderRegistryHash = 'b'.repeat(64)
  const olderSnapshot = { ...section.presetSnapshot, registryHash: olderRegistryHash }
  const replayBody = {
    ...section,
    registryHash: olderRegistryHash,
    presetSnapshot: { ...olderSnapshot, snapshotHash: calculateCanonicalHash({ ...olderSnapshot, snapshotHash: undefined }) },
    sectionHash: undefined,
  }
  delete replayBody.sectionHash
  const replay = { ...replayBody, sectionHash: calculateCanonicalHash(replayBody) }

  assert.notEqual(replay.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
  assert.doesNotThrow(() => requireRenderInputSubtitleRegistry(replay), 'an old render must remain reproducible')
  assert.deepEqual(replay.presetSnapshot.tokens, readSubtitlePreset('kinetic'))

  // But a section that CLAIMS the current registry while carrying a foreign preset hash is drift.
  const drifted = { ...section, presetHash: 'c'.repeat(64) }
  assert.throws(() => requireRenderInputSubtitleRegistry({ ...drifted, sectionHash: calculateCanonicalHash({ ...drifted, sectionHash: undefined }) }), (e) => codeOf(e) === 'INVALID_RENDER_INPUT')
})

test('T-FR-172 a snapshot is only accepted when its identity, tokens and address all agree', () => {
  const snapshot = materializeSubtitlePresetSnapshot('clean-color')
  assert.doesNotThrow(() => requireSubtitlePresetSnapshot(snapshot))
  assert.throws(() => requireSubtitlePresetSnapshot({ ...snapshot, schemaVersion: 'subtitle-preset-snapshot/v9' }), /schema is unsupported/)
  assert.throws(() => requireSubtitlePresetSnapshot({ ...snapshot, presetId: 'kinetic' }), /identity does not match/)
  assert.throws(() => requireSubtitlePresetSnapshot({ ...snapshot, snapshotHash: 'd'.repeat(64) }), /snapshot hash is invalid/)
})
