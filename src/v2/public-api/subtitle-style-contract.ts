import { DomainError } from '../domain/errors.ts'
import {
  quickSubtitlePreview,
  SUBTITLE_PRESET_IDS,
  SUBTITLE_STYLE_REGISTRY,
  type SubtitleMvpFormat,
  type SubtitlePresetId,
} from '../domain/subtitle-system.ts'

const PRESETS = new Set<SubtitlePresetId>(SUBTITLE_PRESET_IDS)

/** The content-addressed registry is itself the published contract — no persistence is involved. */
export function readSubtitleStyleRegistry() {
  return SUBTITLE_STYLE_REGISTRY
}

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
