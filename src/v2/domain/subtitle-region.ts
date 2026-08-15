import { assertDomain } from './errors.ts'
import type { NormalizedBounds, OutputSpec } from './output-spec.ts'
import {
  readSubtitlePreset,
  resolveSubtitleMvpFormat,
  resolveSubtitleRenderMetrics,
  SUBTITLE_STYLE_REGISTRY,
  type SubtitleMvpFormat,
  type SubtitlePresetId,
} from './subtitle-system.ts'

/**
 * The subtitle region is **derived**, never authored: it is the F1.033 preset's own responsive
 * limits (`fontPx`, `maxWidth`, `bottom`, authored at `referenceHeight`) projected onto the
 * OutputSpec of the variant being solved. There is no shared hardcoded rectangle anywhere — a
 * 16:9 delivery and a 9:16 delivery reach different numbers because the registry says so, and a
 * preset edit moves the region through `registryHash`/`presetHash` instead of silently.
 */
export interface SubtitleRegionV1 {
  schemaVersion: 'subtitle-region/v1'
  presetId: SubtitlePresetId
  presetVersion: 1
  presetHash: string
  registryHash: string
  subtitleFormat: SubtitleMvpFormat
  outputSpecId: string
  bounds: Readonly<NormalizedBounds>
}

/** Matches the line-height the CSS preview and the Remotion overlay both use. */
const SUBTITLE_LINE_HEIGHT = 1.1
const EPSILON = 1e-9

export function deriveSubtitleRegion(input: Readonly<{
  spec: Readonly<OutputSpec>
  presetId: SubtitlePresetId
  presetHash?: string
  registryHash?: string
}>): Readonly<SubtitleRegionV1> {
  const style = readSubtitlePreset(input.presetId)
  assertDomain(
    input.presetHash === undefined || input.presetHash === style.presetHash,
    'INVALID_RENDER_INPUT', 'Subtitle region preset hash drifted from the registry',
  )
  assertDomain(
    input.registryHash === undefined || input.registryHash === SUBTITLE_STYLE_REGISTRY.registryHash,
    'INVALID_RENDER_INPUT', 'Subtitle region registry hash drifted from the registry',
  )
  const subtitleFormat = resolveSubtitleMvpFormat(input.spec.aspectRatio)
  const metrics = resolveSubtitleRenderMetrics(style, subtitleFormat, input.spec.height)
  const safe = Object.freeze({
    x: input.spec.safeArea.left,
    y: input.spec.safeArea.top,
    width: 1 - input.spec.safeArea.left - input.spec.safeArea.right,
    height: 1 - input.spec.safeArea.top - input.spec.safeArea.bottom,
  })
  const heightPx = metrics.fontPx * SUBTITLE_LINE_HEIGHT * style.lineBreaking.maxLines +
    2 * style.background.paddingYEm * metrics.fontPx + 2 * metrics.strokePx
  const width = Math.min(metrics.limits.maxWidth, safe.width)
  const height = Math.min(heightPx / input.spec.height, safe.height)
  assertDomain(width > 0 && height > 0, 'INVALID_RENDER_INPUT', 'Subtitle region has no usable area')
  // `bottom` is the canvas fraction between the canvas bottom and the box bottom.
  const bottomAnchored = 1 - metrics.limits.bottom - height
  const y = Math.min(Math.max(bottomAnchored, safe.y), safe.y + safe.height - height)
  const bounds = Object.freeze({ x: safe.x + (safe.width - width) / 2, y, width, height })
  assertDomain(
    bounds.x >= safe.x - EPSILON && bounds.y >= safe.y - EPSILON &&
    bounds.x + bounds.width <= safe.x + safe.width + EPSILON &&
    bounds.y + bounds.height <= safe.y + safe.height + EPSILON,
    'INVALID_RENDER_INPUT', 'Subtitle region escapes the output safe area',
  )
  return Object.freeze({
    schemaVersion: 'subtitle-region/v1' as const,
    presetId: input.presetId,
    presetVersion: 1 as const,
    presetHash: style.presetHash,
    registryHash: SUBTITLE_STYLE_REGISTRY.registryHash,
    subtitleFormat,
    outputSpecId: input.spec.id,
    bounds,
  })
}
