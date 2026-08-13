import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  createOutputSpec,
  OUTPUT_ASPECT_RATIOS,
  OUTPUT_PRESETS,
  type NormalizedBounds,
  type OutputAspectRatio,
  type OutputSpec,
} from './output-spec.ts'

export const OUTPUT_PLATFORMS = [
  'generic', 'instagram-reels', 'instagram-feed', 'youtube',
  'youtube-shorts', 'tiktok', 'linkedin',
] as const
export type OutputPlatform = (typeof OUTPUT_PLATFORMS)[number]

export interface OutputFormatPresetV1 {
  schemaVersion: 'output-format-preset/v1'
  version: 1
  spec: Readonly<OutputSpec>
  subtitleBounds: Readonly<NormalizedBounds>
  exportDefaults: Readonly<{
    proxy: Readonly<{ width: number; height: number; codec: 'h264'; audioCodec: 'aac'; container: 'mp4'; pixelFormat: 'yuv420p'; videoBitrateKbps: number; audioBitrateKbps: number }>
    final: Readonly<{ codec: 'h264'; audioCodec: 'aac'; container: 'mp4'; pixelFormat: 'yuv420p'; videoBitrateKbps: number; audioBitrateKbps: number }>
  }>
  compatiblePlatforms: readonly OutputPlatform[]
  presetHash: string
}

export interface OutputFormatRegistryV1 {
  schemaVersion: 'output-format-registry/v1'
  registryVersion: 1
  presets: Readonly<Record<OutputAspectRatio, Readonly<OutputFormatPresetV1>>>
  registryHash: string
}

const PRESET_POLICY = Object.freeze({
  '9:16': Object.freeze({ subtitleBounds: { x: 0.08, y: 0.78, width: 0.84, height: 0.15 }, proxy: [540, 960], platforms: ['generic', 'instagram-reels', 'youtube-shorts', 'tiktok'] }),
  '16:9': Object.freeze({ subtitleBounds: { x: 0.08, y: 0.74, width: 0.84, height: 0.19 }, proxy: [960, 540], platforms: ['generic', 'youtube', 'linkedin'] }),
  '4:5': Object.freeze({ subtitleBounds: { x: 0.08, y: 0.76, width: 0.84, height: 0.17 }, proxy: [640, 800], platforms: ['generic', 'instagram-feed', 'linkedin'] }),
  '1:1': Object.freeze({ subtitleBounds: { x: 0.09, y: 0.74, width: 0.82, height: 0.19 }, proxy: [720, 720], platforms: ['generic', 'instagram-feed', 'linkedin'] }),
  '21:9': Object.freeze({ subtitleBounds: { x: 0.12, y: 0.7, width: 0.76, height: 0.23 }, proxy: [1050, 450], platforms: ['generic', 'youtube'] }),
} satisfies Record<OutputAspectRatio, { subtitleBounds: NormalizedBounds; proxy: readonly [number, number]; platforms: readonly OutputPlatform[] }>)

function createOutputFormatPreset(aspectRatio: OutputAspectRatio): Readonly<OutputFormatPresetV1> {
  const policy = PRESET_POLICY[aspectRatio]
  const spec = createOutputSpec(OUTPUT_PRESETS[aspectRatio])
  const bounds = policy.subtitleBounds
  assertDomain(
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
      bounds.x >= spec.safeArea.left && bounds.y >= spec.safeArea.top &&
      bounds.width > 0 && bounds.height > 0 &&
      bounds.x + bounds.width <= 1 - spec.safeArea.right &&
      bounds.y + bounds.height <= 1 - spec.safeArea.bottom,
    'INVALID_OUTPUT_SPEC', 'Subtitle bounds must remain inside the preset safe area',
    { aspectRatio, bounds, safeArea: spec.safeArea },
  )
  const exportDefaults = Object.freeze({
    proxy: Object.freeze({ width: policy.proxy[0], height: policy.proxy[1], codec: 'h264' as const, audioCodec: 'aac' as const, container: 'mp4' as const, pixelFormat: 'yuv420p' as const, videoBitrateKbps: 4_000, audioBitrateKbps: 160 }),
    final: Object.freeze({ codec: 'h264' as const, audioCodec: 'aac' as const, container: 'mp4' as const, pixelFormat: 'yuv420p' as const, videoBitrateKbps: aspectRatio === '21:9' ? 16_000 : 12_000, audioBitrateKbps: 192 }),
  })
  const body = Object.freeze({ schemaVersion: 'output-format-preset/v1' as const, version: 1 as const, spec, subtitleBounds: Object.freeze({ ...bounds }), exportDefaults, compatiblePlatforms: Object.freeze([...policy.platforms]) as readonly OutputPlatform[] })
  return Object.freeze({ ...body, presetHash: calculateCanonicalHash(body) })
}

const FORMAT_PRESETS = Object.freeze(Object.fromEntries(
  OUTPUT_ASPECT_RATIOS.map((ratio) => [ratio, createOutputFormatPreset(ratio)]),
) as unknown as Record<OutputAspectRatio, Readonly<OutputFormatPresetV1>>)
const REGISTRY_BODY = Object.freeze({ schemaVersion: 'output-format-registry/v1' as const, registryVersion: 1 as const, presets: FORMAT_PRESETS })

export const OUTPUT_FORMAT_REGISTRY: Readonly<OutputFormatRegistryV1> =
  Object.freeze({ ...REGISTRY_BODY, registryHash: calculateCanonicalHash(REGISTRY_BODY) })

export function readOutputFormatPreset(aspectRatio: OutputAspectRatio): Readonly<OutputFormatPresetV1> {
  const preset = OUTPUT_FORMAT_REGISTRY.presets[aspectRatio]
  assertDomain(preset, 'INVALID_OUTPUT_SPEC', 'Output format preset is not registered', { aspectRatio })
  return preset
}

export function customizeOutputFormatPreset(aspectRatio: OutputAspectRatio, input: Partial<Pick<OutputSpec, 'width' | 'height' | 'fps' | 'safeArea'>>): Readonly<OutputFormatPresetV1> {
  const preset = readOutputFormatPreset(aspectRatio)
  const spec = createOutputSpec({ ...preset.spec, ...input, id: `${preset.spec.id}-custom`, aspectRatio, safeArea: input.safeArea ?? preset.spec.safeArea })
  const body = Object.freeze({ schemaVersion: preset.schemaVersion, version: preset.version, spec, subtitleBounds: preset.subtitleBounds, exportDefaults: preset.exportDefaults, compatiblePlatforms: preset.compatiblePlatforms })
  return Object.freeze({ ...body, presetHash: calculateCanonicalHash(body) })
}

export function validateOutputCompatibility(input: { aspectRatio: OutputAspectRatio; platform: OutputPlatform; codec: string; audioCodec: string; container: string; pixelFormat?: string }): void {
  const preset = readOutputFormatPreset(input.aspectRatio)
  assertDomain(preset.compatiblePlatforms.includes(input.platform), 'INVALID_OUTPUT_SPEC', 'Output format is not compatible with the target platform', { aspectRatio: input.aspectRatio, platform: input.platform })
  assertDomain(input.codec === 'h264' && input.audioCodec === 'aac' && input.container === 'mp4' && (input.pixelFormat === undefined || input.pixelFormat === 'yuv420p'), 'INVALID_OUTPUT_SPEC', 'Output codec, audio codec, container or pixel format is unsupported', { codec: input.codec, audioCodec: input.audioCodec, container: input.container, pixelFormat: input.pixelFormat })
}
