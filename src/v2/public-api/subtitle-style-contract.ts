import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import {
  quickSubtitlePreview,
  SUBTITLE_PRESET_IDS,
  SUBTITLE_STYLE_REGISTRY,
  type SubtitleMvpFormat,
  type SubtitlePresetId,
  type SubtitleStylePreset,
} from '../domain/subtitle-system.ts'

const PRESETS = new Set<SubtitlePresetId>(SUBTITLE_PRESET_IDS)

/** The content-addressed registry is itself the published contract — no persistence is involved. */
export function readSubtitleStyleRegistry() {
  return SUBTITLE_STYLE_REGISTRY
}

/**
 * The v1 projection of the registry, still published (FR-172 evolved the aggregate additively).
 *
 * F1.035 gave `SubtitleStylePreset` its own `casing`, `grouping`, `shadow` and `placement` tokens,
 * which is a new document shape — `subtitle-style-registry/v2`. The v1 document is not withdrawn:
 * every token it ever carried still exists in the aggregate, so the older shape is derived from the
 * live tokens rather than frozen as a copy. `uppercase` is `casing === 'uppercase'` and
 * `chunkWords` is `grouping.maxWordsPerGroup` — the exact fields those tokens were extracted from.
 *
 * Because the projection is a faithful inverse, its content addresses are the *original* v1 hashes,
 * not new ones: a client that pinned `registryHash` under v1 keeps resolving the same document.
 * `tests/v2/subtitle-style-preset-aggregate.test.mjs` asserts those literal hashes.
 */
function projectPresetToV1(preset: Readonly<SubtitleStylePreset>) {
  const body = {
    schemaVersion: 'subtitle-style-preset/v1' as const,
    id: preset.id,
    version: 1 as const,
    typography: Object.freeze({ ...preset.typography, uppercase: preset.casing === 'uppercase' }),
    lineBreaking: Object.freeze({ ...preset.lineBreaking, chunkWords: preset.grouping.maxWordsPerGroup }),
    highlight: preset.highlight,
    background: preset.background,
    stroke: preset.stroke,
    animation: preset.animation,
    margins: preset.margins,
    responsive: preset.responsive,
  }
  return Object.freeze({ ...body, presetHash: calculateCanonicalHash(body) })
}

const SUBTITLE_STYLE_REGISTRY_V1_BODY = Object.freeze({
  schemaVersion: 'subtitle-style-registry/v1' as const,
  registryVersion: 1 as const,
  presets: Object.freeze(Object.fromEntries(
    SUBTITLE_PRESET_IDS.map((presetId) => [presetId, projectPresetToV1(SUBTITLE_STYLE_REGISTRY.presets[presetId])]),
  )) as Readonly<Record<SubtitlePresetId, ReturnType<typeof projectPresetToV1>>>,
  formatByAspectRatio: SUBTITLE_STYLE_REGISTRY.formatByAspectRatio,
})

export const SUBTITLE_STYLE_REGISTRY_V1 = Object.freeze({
  ...SUBTITLE_STYLE_REGISTRY_V1_BODY,
  registryHash: calculateCanonicalHash(SUBTITLE_STYLE_REGISTRY_V1_BODY),
})

export interface SubtitlePreviewRequest {
  presetId: SubtitlePresetId
  text: string
  format: SubtitleMvpFormat
  background: 'light' | 'dark'
}

export function parseSubtitlePreviewRequest(value: unknown): SubtitlePreviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', 'Subtitle preview body is invalid')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['presetId', 'text', 'format', 'background'].includes(key)) ||
      !PRESETS.has(input.presetId as SubtitlePresetId) || typeof input.text !== 'string' ||
      (input.format !== '9:16' && input.format !== '16:9') ||
      (input.background !== 'light' && input.background !== 'dark')) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle preview body is invalid')
  }
  return { presetId: input.presetId as SubtitlePresetId, text: input.text, format: input.format, background: input.background }
}

export function createSubtitleCssPreview(value: unknown) {
  const input = parseSubtitlePreviewRequest(value)
  return quickSubtitlePreview(input.presetId, input)
}
