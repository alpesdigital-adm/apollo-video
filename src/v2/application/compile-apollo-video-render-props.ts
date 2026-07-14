import { assertDomain } from '../domain/errors.ts'
import type {
  MaterializedRenderInputAsset,
  MaterializedRenderInputV1,
} from '../domain/render-input.ts'

const SCENE_TYPES = [
  'fullscreen',
  'lower-third',
  'split',
  'split-vertical',
  'card',
  'message',
  'number',
  'flow',
  'cta',
  'stick-figures',
  'image-insert',
  'asset-card',
] as const
const SUBTITLE_STYLES = [
  'kinetic',
  'karaoke-box',
  'karaoke-pill',
  'caps-stroke',
  'clean-color',
] as const
const GRADE_PRESETS = ['natural', 'cinema', 'quente', 'frio', 'off'] as const
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

type SceneType = (typeof SCENE_TYPES)[number]
type SubtitleStyle = (typeof SUBTITLE_STYLES)[number]
type GradePreset = (typeof GRADE_PRESETS)[number]

interface CompiledScene {
  type: SceneType
  from: number
  to: number
  fromFrame: number
  toFrame: number
  props: Record<string, unknown>
}

interface CompiledSubtitle {
  text: string
  startTime: number
  endTime: number
  startFrame: number
  endFrame: number
  anchor?: 'top' | 'bottom'
}

export interface ApolloVideoRenderPropsV1 extends Record<string, unknown> {
  scenes: readonly CompiledScene[]
  subtitles: readonly CompiledSubtitle[]
  videoSrc: string
  format: '9:16' | '16:9'
  palette: Readonly<{
    primary: string
    secondary: string
    accent: string
    text: string
    background: string
  }>
  stylePreset?: string
  subtitleStyle?: SubtitleStyle
  gradePreset?: GradePreset
  hookTitle?: string
}

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_RENDER_INPUT',
    `${field} must be an object`,
  )
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  const keys = new Set(allowed)
  assertDomain(
    Object.keys(value).every((key) => keys.has(key)),
    'INVALID_RENDER_INPUT',
    `${field} contains unsupported properties`,
  )
}

function token(value: unknown, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_RENDER_INPUT', `${field} must be a string`)
  const normalized = value.trim().toLowerCase()
  assertDomain(TOKEN_PATTERN.test(normalized), 'INVALID_RENDER_INPUT', `${field} is invalid`)
  return normalized
}

function text(value: unknown, field: string, maximum: number): string {
  assertDomain(typeof value === 'string', 'INVALID_RENDER_INPUT', `${field} must be a string`)
  const normalized = value.trim()
  assertDomain(
    normalized.length > 0 && normalized.length <= maximum,
    'INVALID_RENDER_INPUT',
    `${field} must contain 1 to ${maximum} characters`,
  )
  return normalized
}

function frame(value: unknown, field: string, maximum: number): number {
  assertDomain(
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum,
    'INVALID_RENDER_INPUT',
    `${field} is outside the render timeline`,
  )
  return Number(value)
}

function resolveAsset(
  assets: ReadonlyMap<string, MaterializedRenderInputAsset>,
  assetId: unknown,
  expectedKinds: readonly MaterializedRenderInputAsset['kind'][],
  field: string,
): MaterializedRenderInputAsset {
  const id = token(assetId, field)
  const asset = assets.get(id)
  assertDomain(
    asset !== undefined && expectedKinds.includes(asset.kind),
    'INVALID_RENDER_INPUT',
    `${field} does not reference a compatible materialized asset`,
  )
  return asset
}

function compilePalette(value: unknown): ApolloVideoRenderPropsV1['palette'] {
  const palette = record(value, 'props.palette')
  exactKeys(palette, ['primary', 'secondary', 'accent', 'text', 'background'], 'props.palette')
  const entries = Object.fromEntries(
    ['primary', 'secondary', 'accent', 'text', 'background'].map((key) => {
      const color = palette[key]
      assertDomain(
        typeof color === 'string' && COLOR_PATTERN.test(color),
        'INVALID_RENDER_INPUT',
        `props.palette.${key} must be a six-digit hex color`,
      )
      return [key, color.toUpperCase()]
    }),
  ) as ApolloVideoRenderPropsV1['palette']
  return Object.freeze(entries)
}

function compileScene(
  value: unknown,
  index: number,
  input: MaterializedRenderInputV1,
  assets: ReadonlyMap<string, MaterializedRenderInputAsset>,
): CompiledScene {
  const scene = record(value, `props.scenes[${index}]`)
  exactKeys(scene, ['type', 'fromFrame', 'toFrame', 'props'], `props.scenes[${index}]`)
  assertDomain(
    typeof scene.type === 'string' && SCENE_TYPES.includes(scene.type as SceneType),
    'INVALID_RENDER_INPUT',
    `props.scenes[${index}].type is invalid`,
  )
  const fromFrame = frame(
    scene.fromFrame,
    `props.scenes[${index}].fromFrame`,
    input.output.durationInFrames,
  )
  const toFrame = frame(
    scene.toFrame,
    `props.scenes[${index}].toFrame`,
    input.output.durationInFrames,
  )
  assertDomain(
    toFrame > fromFrame,
    'INVALID_RENDER_INPUT',
    `props.scenes[${index}] must have a positive duration`,
  )
  const sourceProps = record(scene.props, `props.scenes[${index}].props`)
  assertDomain(
    !['imageSrc', 'imagePath', 'videoSrc'].some((key) => key in sourceProps),
    'INVALID_RENDER_INPUT',
    `props.scenes[${index}].props cannot contain storage locations`,
  )
  const compiledProps: Record<string, unknown> = { ...sourceProps }
  if ('imageAssetId' in compiledProps) {
    compiledProps.imageSrc = resolveAsset(
      assets,
      compiledProps.imageAssetId,
      ['image'],
      `props.scenes[${index}].props.imageAssetId`,
    ).uri
    delete compiledProps.imageAssetId
  }
  if ('videoAssetId' in compiledProps) {
    compiledProps.videoSrc = resolveAsset(
      assets,
      compiledProps.videoAssetId,
      ['video'],
      `props.scenes[${index}].props.videoAssetId`,
    ).uri
    delete compiledProps.videoAssetId
  }
  if (scene.type === 'image-insert' || scene.type === 'asset-card') {
    assertDomain(
      typeof compiledProps.imageSrc === 'string' || typeof compiledProps.videoSrc === 'string',
      'INVALID_RENDER_INPUT',
      `props.scenes[${index}] requires a materialized media asset`,
    )
  }
  return Object.freeze({
    type: scene.type as SceneType,
    from: fromFrame / input.output.fps,
    to: toFrame / input.output.fps,
    fromFrame,
    toFrame,
    props: Object.freeze(compiledProps),
  })
}

function compileSubtitle(
  value: unknown,
  index: number,
  input: MaterializedRenderInputV1,
): CompiledSubtitle {
  const subtitle = record(value, `props.subtitles[${index}]`)
  exactKeys(subtitle, ['text', 'fromFrame', 'toFrame', 'anchor'], `props.subtitles[${index}]`)
  const fromFrame = frame(
    subtitle.fromFrame,
    `props.subtitles[${index}].fromFrame`,
    input.output.durationInFrames,
  )
  const toFrame = frame(
    subtitle.toFrame,
    `props.subtitles[${index}].toFrame`,
    input.output.durationInFrames,
  )
  assertDomain(
    toFrame > fromFrame,
    'INVALID_RENDER_INPUT',
    `props.subtitles[${index}] must have a positive duration`,
  )
  assertDomain(
    subtitle.anchor === undefined || subtitle.anchor === 'top' || subtitle.anchor === 'bottom',
    'INVALID_RENDER_INPUT',
    `props.subtitles[${index}].anchor is invalid`,
  )
  return Object.freeze({
    text: text(subtitle.text, `props.subtitles[${index}].text`, 1_000),
    startTime: fromFrame / input.output.fps,
    endTime: toFrame / input.output.fps,
    startFrame: fromFrame,
    endFrame: toFrame,
    ...(subtitle.anchor ? { anchor: subtitle.anchor as 'top' | 'bottom' } : {}),
  })
}

export function compileApolloVideoRenderProps(
  input: MaterializedRenderInputV1,
): ApolloVideoRenderPropsV1 {
  assertDomain(
    input.composition.id === 'apollo-video' &&
      input.composition.version === 'v1' &&
      input.composition.propsSchemaRef === 'apollo://render-props/apollo-video/v1',
    'INVALID_RENDER_INPUT',
    'RenderInput does not target the Apollo Video v1 composition',
  )
  assertDomain(
    input.output.aspectRatio === '9:16' || input.output.aspectRatio === '16:9',
    'INVALID_RENDER_INPUT',
    'Apollo Video v1 renderer currently supports 9:16 and 16:9 outputs',
  )
  const props = record(input.props, 'props')
  exactKeys(
    props,
    [
      'primaryVideoAssetId',
      'scenes',
      'subtitles',
      'palette',
      'stylePreset',
      'subtitleStyle',
      'gradePreset',
      'hookTitle',
    ],
    'props',
  )
  assertDomain(Array.isArray(props.scenes), 'INVALID_RENDER_INPUT', 'props.scenes must be an array')
  assertDomain(
    props.scenes.length <= 4_096,
    'INVALID_RENDER_INPUT',
    'props.scenes cannot exceed 4096 items',
  )
  assertDomain(
    Array.isArray(props.subtitles),
    'INVALID_RENDER_INPUT',
    'props.subtitles must be an array',
  )
  assertDomain(
    props.subtitles.length <= 10_000,
    'INVALID_RENDER_INPUT',
    'props.subtitles cannot exceed 10000 items',
  )
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]))
  const videoSrc = resolveAsset(
    assets,
    props.primaryVideoAssetId,
    ['video'],
    'props.primaryVideoAssetId',
  ).uri
  const scenes = Object.freeze(
    props.scenes.map((scene, index) => compileScene(scene, index, input, assets)),
  )
  const subtitles = Object.freeze(
    props.subtitles.map((subtitle, index) => compileSubtitle(subtitle, index, input)),
  )
  const compiled: ApolloVideoRenderPropsV1 = {
    scenes,
    subtitles,
    videoSrc,
    format: input.output.aspectRatio,
    palette: compilePalette(props.palette),
  }
  if (props.stylePreset !== undefined) {
    compiled.stylePreset = token(props.stylePreset, 'props.stylePreset')
  }
  if (props.subtitleStyle !== undefined) {
    assertDomain(
      typeof props.subtitleStyle === 'string' &&
        SUBTITLE_STYLES.includes(props.subtitleStyle as SubtitleStyle),
      'INVALID_RENDER_INPUT',
      'props.subtitleStyle is invalid',
    )
    compiled.subtitleStyle = props.subtitleStyle as SubtitleStyle
  }
  if (props.gradePreset !== undefined) {
    assertDomain(
      typeof props.gradePreset === 'string' &&
        GRADE_PRESETS.includes(props.gradePreset as GradePreset),
      'INVALID_RENDER_INPUT',
      'props.gradePreset is invalid',
    )
    compiled.gradePreset = props.gradePreset as GradePreset
  }
  if (props.hookTitle !== undefined) {
    compiled.hookTitle = text(props.hookTitle, 'props.hookTitle', 240)
  }
  return Object.freeze(compiled)
}
