/**
 * Shared Remotion input-props utilities.
 *
 * Single source of truth for:
 *  - RemotionInputProps type
 *  - DEFAULT_PALETTE
 *  - toRemotionScene()        – Scene → RemotionSceneInput (URL handling parametrised)
 *  - prepareRemotionScenes()  – sort + defensive duration clamp (NO cursor, NO gap)
 *  - normalizeSubtitleWords() – word-level subtitle normalisation
 */

import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'
import { MIN_SCENE_SECONDS } from '@/lib/utils/timing'
import { clampColdOpenWindow } from '@/lib/cold-open'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const REMOTION_SCENE_TYPES = [
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
  'asset-card'
] as const

export type RemotionSceneType = (typeof REMOTION_SCENE_TYPES)[number]

export interface RemotionSceneInput {
  type: RemotionSceneType
  from: number
  to: number
  fromFrame: number
  toFrame: number
  props: Record<string, any>
}

export interface RemotionCreator {
  name: string
  handle: string
  avatarUrl: string | null
}

export interface RemotionLayoutSegment {
  id: string
  fromFrame: number
  toFrame: number
  layout: 'fullscreen' | 'split-50' | 'blur-bg' | 'tweet-card'
  effects?: { zoom?: 'in' | 'out'; bw?: boolean }
  props?: Record<string, any>
}

export interface RemotionPunchIn {
  fromFrame: number
  toFrame: number
  scale: number
}

// COLD OPEN (Fase 3): janela FONTE resolvida + comprimento (frames) do teaser
// que é prependido no início. Todas as outras camadas são deslocadas por `len`.
export interface RemotionColdOpen {
  fromFrame: number
  toFrame: number
  len: number
}

export interface AudioSfxEventInput {
  kind: string
  src: string
  fromFrame: number
  volume: number
}

export interface AudioMusicInput {
  src: string
  volume: number
}

export interface AudioInputProps {
  events: AudioSfxEventInput[]
  music?: AudioMusicInput
}

export type SubtitleStyle =
  | 'kinetic'
  | 'karaoke-box'
  | 'karaoke-pill'
  | 'caps-stroke'
  | 'clean-color'

// Mirrors remotion/src/lib/grade.ts's GradePreset. 'natural' is the default.
export type GradePreset = 'natural' | 'cinema' | 'quente' | 'frio' | 'off'

export interface RemotionInputProps {
  scenes: RemotionSceneInput[]
  subtitles: SubtitleEntry[]
  transcription: Transcription
  palette: ColorPalette
  videoSrc: string
  format: '9:16' | '16:9'
  stylePreset?: string
  subtitleStyle?: SubtitleStyle
  gradePreset?: GradePreset
  hookTitle?: string
  creator?: RemotionCreator
  layoutSegments?: RemotionLayoutSegment[]
  punchIns?: RemotionPunchIn[]
  audio?: AudioInputProps
  // COLD OPEN: presente quando o plano tem `coldOpen`. A composição renderiza um
  // teaser em [0, len) e o fluxo normal a partir de len (já deslocado nas props).
  coldOpen?: RemotionColdOpen
}

export interface ColorPalette {
  primary: string
  secondary: string
  accent: string
  background: string
  text: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PALETTE: ColorPalette = {
  primary: '#FFB800',
  secondary: '#20202A',
  accent: '#FF6B35',
  background: '#050508',
  text: '#FFFFFF'
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeImageInsertLayout(value: unknown): 'full' | 'split-bottom' | 'top-image-compact' {
  return value === 'split-bottom' || value === 'top-image-compact' ? value : 'full'
}

const TYPE_MAP: Record<string, RemotionSceneType> = {
  FullScreen: 'fullscreen',
  LowerThird: 'lower-third',
  Split: 'split',
  SplitVertical: 'split-vertical',
  Card: 'card',
  Message: 'message',
  Number: 'number',
  Flow: 'flow',
  CTA: 'cta',
  StickFigures: 'stick-figures',
  ImageInsert: 'image-insert',
  AssetCard: 'asset-card'
}

const VALID_ASSET_CARD_STYLES = ['credibility', 'meme', 'news'] as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToRemotionSceneOptions {
  /**
   * When provided (server/render context), relative `/…` paths are prefixed
   * with this base URL to produce absolute URLs that Node can fetch.
   * When omitted (browser/player context), paths are kept as-is.
   */
  baseUrl?: string
}

function resolveImageSrc(value: string | undefined, baseUrl?: string): string {
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (baseUrl && value.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${value}`
  return value
}

/**
 * Convert a domain Scene into a RemotionSceneInput.
 * Returns null for ImageInsert scenes with no resolvable image.
 */
export function toRemotionScene(
  scene: Scene,
  fps: number,
  opts: ToRemotionSceneOptions = {}
): RemotionSceneInput | null {
  const startFrame = scene.startFrame ?? 0
  // endFrame fallback: startFrame + 1 frame (prepareRemotionScenes applies min clamp later)
  const endFrame = scene.endFrame ?? startFrame + 1

  const {
    id: _id,
    type,
    startLeg: _startLeg,
    durationInSubtitles: _durationInSubtitles,
    startFrame: _startFrame,
    endFrame: _endFrame,
    ...props
  } = scene as any

  const adaptedProps = { ...props }

  if (type === 'FullScreen' && !adaptedProps.title) {
    adaptedProps.title = adaptedProps.text || 'Highlight'
  }
  if (type === 'Split') {
    adaptedProps.title = adaptedProps.title || adaptedProps.topText || 'Context'
    adaptedProps.content = adaptedProps.content || adaptedProps.bottomText || ''
  }
  if (type === 'SplitVertical') {
    adaptedProps.leftContent = adaptedProps.leftContent || adaptedProps.leftText || ''
    adaptedProps.rightContent = adaptedProps.rightContent || adaptedProps.rightText || ''
    adaptedProps.leftLabel = adaptedProps.leftLabel || 'Antes'
    adaptedProps.rightLabel = adaptedProps.rightLabel || 'Depois'
  }
  if (type === 'Message') {
    adaptedProps.senderName = adaptedProps.senderName || adaptedProps.sender || 'Mensagem'
    adaptedProps.messageText = adaptedProps.messageText || adaptedProps.message || ''
  }
  if (type === 'Flow' && Array.isArray(adaptedProps.steps)) {
    adaptedProps.steps = adaptedProps.steps.map((step: any, index: number) =>
      typeof step === 'string' ? { number: index + 1, text: step } : step
    )
  }
  if (type === 'CTA') {
    adaptedProps.highlightWord = adaptedProps.highlightWord || adaptedProps.highlight
  }
  if (type === 'StickFigures') {
    adaptedProps.leftCaption = adaptedProps.leftCaption || adaptedProps.situation || ''
    adaptedProps.rightCaption = adaptedProps.rightCaption || adaptedProps.caption || ''
  }
  if (type === 'ImageInsert') {
    adaptedProps.imageSrc = resolveImageSrc(
      adaptedProps.imageSrc || adaptedProps.imagePath,
      opts.baseUrl
    )
    // Pacote 3: an animated/stock clip. Resolved with the same base-URL rule as
    // the still; when present the scene renders as video instead of the image.
    const resolvedVideo = resolveImageSrc(adaptedProps.videoSrc, opts.baseUrl)
    if (resolvedVideo) {
      adaptedProps.videoSrc = resolvedVideo
    } else {
      delete adaptedProps.videoSrc
    }
    // A stock scene can have a video with no still — keep it as long as some media exists.
    if (!adaptedProps.imageSrc && !adaptedProps.videoSrc) return null
    // Stutter só faz sentido em mídia EM MOVIMENTO: numa imagem parada os 5
    // saltos viram tremedeira (reprovado em produção). Se o clipe de motion
    // não materializou (fallback para still), o stutter cai junto.
    if (!adaptedProps.videoSrc) {
      delete adaptedProps.stutter
    }
    adaptedProps.layout = normalizeImageInsertLayout(adaptedProps.layout)
  }
  if (type === 'AssetCard') {
    // The asset media was already resolved to imageSrc/videoSrc server-side; here
    // we only apply the same base-URL rule (absolute for render, relative in the
    // browser player) and drop the scene when no media survived.
    adaptedProps.imageSrc = resolveImageSrc(adaptedProps.imageSrc, opts.baseUrl)
    const resolvedAssetVideo = resolveImageSrc(adaptedProps.videoSrc, opts.baseUrl)
    if (resolvedAssetVideo) {
      adaptedProps.videoSrc = resolvedAssetVideo
    } else {
      delete adaptedProps.videoSrc
    }
    if (!adaptedProps.imageSrc && !adaptedProps.videoSrc) return null
    adaptedProps.style = VALID_ASSET_CARD_STYLES.includes(adaptedProps.style)
      ? adaptedProps.style
      : 'credibility'
  }

  return {
    type: TYPE_MAP[type] || 'fullscreen',
    from: startFrame / fps,
    to: endFrame / fps,
    fromFrame: startFrame,
    toFrame: endFrame,
    props: adaptedProps
  }
}

/**
 * Prepare scenes for Remotion:
 *  1. Sort by fromFrame (ascending).
 *  2. Clamp toFrame so duration >= minDurationFrames — WITHOUT moving fromFrame —
 *     but NEVER past the next scene's fromFrame (scenes are full-canvas layers;
 *     two visible at once bleed into each other).
 *  3. Drop scenes whose remaining window is an unreadable flash.
 *
 * FORBIDDEN: cursor accumulation, gap between scenes, shifting fromFrame.
 * The startFrame produced by resolveSceneTiming() is the source of truth.
 */
export function prepareRemotionScenes(
  scenes: RemotionSceneInput[],
  fps: number
): RemotionSceneInput[] {
  const minDurationFrames = Math.round(fps * MIN_SCENE_SECONDS)
  const minVisibleFrames = Math.max(2, Math.round(fps * 0.35))

  const sorted = [...scenes].sort((a, b) => a.fromFrame - b.fromFrame)

  return sorted
    .map((scene, index) => {
      const next = sorted[index + 1]
      let toFrame = Math.max(scene.toFrame, scene.fromFrame + minDurationFrames)
      if (next) {
        toFrame = Math.min(toFrame, Math.max(next.fromFrame, scene.fromFrame))
      }
      return {
        ...scene,
        toFrame,
        to: toFrame / fps
        // fromFrame and from are intentionally unchanged
      }
    })
    .filter((scene) => scene.toFrame - scene.fromFrame >= minVisibleFrames)
}

export interface CreatorProfileLike {
  name: string
  handle: string
  avatarPath: string | null
}

/**
 * Resolve a stored creator profile into RemotionCreator props, applying an
 * absolute base URL to the avatar path when rendering server-side (same
 * pattern as resolveImageSrc / ImageInsert).
 */
export function resolveCreatorForProps(
  profile: CreatorProfileLike | null | undefined,
  baseUrl?: string
): RemotionCreator | undefined {
  if (!profile || !profile.name || !profile.handle) return undefined

  return {
    name: profile.name,
    handle: profile.handle,
    avatarUrl: resolveImageSrc(profile.avatarPath || undefined, baseUrl) || null
  }
}

const VALID_SEGMENT_LAYOUTS = ['fullscreen', 'split-50', 'blur-bg', 'tweet-card'] as const

/**
 * Resolve the plan's `layoutSegments` into RemotionLayoutSegment props.
 * Resolves each segment's `props.mediaSrc` through the same base-URL rule as
 * ImageInsert (absolute for the render, relative for the browser player).
 * Returns [] for old plans without the field (→ everything stays fullscreen).
 */
export function resolveLayoutSegments(
  plan: { layoutSegments?: unknown } | null | undefined,
  opts: ToRemotionSceneOptions = {}
): RemotionLayoutSegment[] {
  const segments = plan?.layoutSegments
  if (!Array.isArray(segments)) return []

  return segments
    .map((raw: any): RemotionLayoutSegment | null => {
      if (!raw || typeof raw !== 'object') return null
      const layout = raw.layout
      if (!VALID_SEGMENT_LAYOUTS.includes(layout)) return null

      const fromFrame = Number(raw.fromFrame)
      const toFrame = Number(raw.toFrame)
      if (!Number.isFinite(fromFrame) || !Number.isFinite(toFrame) || toFrame <= fromFrame) {
        return null
      }

      const props: Record<string, any> = { ...(raw.props || {}) }
      if (typeof props.mediaSrc === 'string') {
        props.mediaSrc = resolveImageSrc(props.mediaSrc, opts.baseUrl)
      }

      const effects =
        raw.effects && typeof raw.effects === 'object'
          ? {
              ...(raw.effects.zoom === 'in' || raw.effects.zoom === 'out'
                ? { zoom: raw.effects.zoom }
                : {}),
              ...(raw.effects.bw === true ? { bw: true } : {})
            }
          : undefined

      return {
        id: String(raw.id ?? `${fromFrame}-${toFrame}`),
        fromFrame,
        toFrame,
        layout,
        ...(effects && (effects.zoom || effects.bw) ? { effects } : {}),
        props
      }
    })
    .filter((seg): seg is RemotionLayoutSegment => seg !== null)
}

/**
 * Resolve the plan's `punchIns` into RemotionPunchIn props (pure — no URLs).
 * Each entry needs a finite [fromFrame, toFrame) window and a numeric scale.
 * Returns [] for old plans without the field (→ base video keeps scale 1.0).
 */
export function resolvePunchIns(
  plan: { punchIns?: unknown } | null | undefined
): RemotionPunchIn[] {
  const punchIns = plan?.punchIns
  if (!Array.isArray(punchIns)) return []

  return punchIns
    .map((raw: any): RemotionPunchIn | null => {
      if (!raw || typeof raw !== 'object') return null
      const fromFrame = Number(raw.fromFrame)
      const toFrame = Number(raw.toFrame)
      const scale = Number(raw.scale)
      if (!Number.isFinite(fromFrame) || !Number.isFinite(toFrame) || toFrame <= fromFrame) {
        return null
      }
      if (!Number.isFinite(scale) || scale <= 0) return null
      return { fromFrame, toFrame, scale }
    })
    .filter((entry): entry is RemotionPunchIn => entry !== null)
}

// ---------------------------------------------------------------------------
// COLD OPEN (Fase 3)
// ---------------------------------------------------------------------------

/**
 * Resolve `plan.coldOpen` into { fromFrame, toFrame, len } (3-8s clamped), or
 * null when absent/invalid. `durationFrames` is the SOURCE timeline length
 * (plan.durationFrames — WITHOUT the cold-open offset) so the clamp stays inside
 * the real footage.
 */
export function resolveColdOpen(
  plan: { coldOpen?: unknown } | null | undefined,
  fps: number,
  durationFrames?: number
): RemotionColdOpen | null {
  const co = (plan as any)?.coldOpen
  if (!co || typeof co !== 'object') return null
  const window = clampColdOpenWindow(co.fromFrame, co.toFrame, fps, durationFrames)
  if (!window) return null
  return {
    fromFrame: window.fromFrame,
    toFrame: window.toFrame,
    len: window.toFrame - window.fromFrame
  }
}

/** Shift resolved scenes forward by `len` frames (from/to seconds + frames). */
export function offsetScenesForColdOpen(
  scenes: RemotionSceneInput[],
  len: number,
  fps: number
): RemotionSceneInput[] {
  if (len <= 0) return scenes
  const secOff = len / fps
  return scenes.map((scene) => ({
    ...scene,
    from: scene.from + secOff,
    to: scene.to + secOff,
    fromFrame: scene.fromFrame + len,
    toFrame: scene.toFrame + len
  }))
}

/** Shift layout segments forward by `len` frames. */
export function offsetLayoutSegmentsForColdOpen(
  segments: RemotionLayoutSegment[],
  len: number
): RemotionLayoutSegment[] {
  if (len <= 0) return segments
  return segments.map((seg) => ({
    ...seg,
    fromFrame: seg.fromFrame + len,
    toFrame: seg.toFrame + len
  }))
}

/** Shift punch-ins forward by `len` frames. */
export function offsetPunchInsForColdOpen(
  punchIns: RemotionPunchIn[],
  len: number
): RemotionPunchIn[] {
  if (len <= 0) return punchIns
  return punchIns.map((p) => ({
    ...p,
    fromFrame: p.fromFrame + len,
    toFrame: p.toFrame + len
  }))
}

function shiftWords(words: SubtitleEntry['words'], secOff: number): SubtitleEntry['words'] {
  if (!Array.isArray(words)) return words
  return words.map((word: any) => {
    if (typeof word === 'string') return word
    return {
      ...word,
      start: Number(word.start) + secOff,
      end: Number(word.end) + secOff
    }
  }) as SubtitleEntry['words']
}

function remapWords(
  words: SubtitleEntry['words'],
  secFrom: number,
  maxSec: number
): SubtitleEntry['words'] {
  if (!Array.isArray(words)) return words
  return words.map((word: any) => {
    if (typeof word === 'string') return word
    return {
      ...word,
      start: Math.max(0, Math.min(maxSec, Number(word.start) - secFrom)),
      end: Math.max(0, Math.min(maxSec, Number(word.end) - secFrom))
    }
  }) as SubtitleEntry['words']
}

function subtitleStartFrame(sub: SubtitleEntry, fps: number): number {
  return typeof (sub as any).startFrame === 'number'
    ? (sub as any).startFrame
    : Math.round(sub.startTime * fps)
}
function subtitleEndFrame(sub: SubtitleEntry, fps: number): number {
  return typeof (sub as any).endFrame === 'number'
    ? (sub as any).endFrame
    : Math.round(sub.endTime * fps)
}

/**
 * Build the cold-open subtitle track:
 *  - EVERY subtitle shifted forward by `len` (times + frames + word times), and
 *  - PREPENDED remapped copies of the subtitles intersecting the cold-open window
 *    [fromFrame, fromFrame+len): times/frames minus fromFrame (clamped to [0,len)),
 *    words remapped the same way, `anchor` preserved.
 * The prepended copies come first so SubtitleOverlay's `.find` picks them during
 * the teaser; the shifted track starts at `len`, so there is no frame overlap.
 */
export function buildColdOpenSubtitles(
  subtitles: SubtitleEntry[],
  coldOpen: RemotionColdOpen,
  fps: number
): SubtitleEntry[] {
  const { fromFrame, len } = coldOpen
  const toFrame = fromFrame + len
  const secOff = len / fps
  const secFrom = fromFrame / fps
  const maxSec = len / fps

  const shifted = subtitles.map((sub) => ({
    ...sub,
    startTime: sub.startTime + secOff,
    endTime: sub.endTime + secOff,
    ...(typeof (sub as any).startFrame === 'number'
      ? { startFrame: (sub as any).startFrame + len }
      : {}),
    ...(typeof (sub as any).endFrame === 'number'
      ? { endFrame: (sub as any).endFrame + len }
      : {}),
    words: shiftWords(sub.words, secOff)
  })) as SubtitleEntry[]

  const remapped: SubtitleEntry[] = []
  for (const sub of subtitles) {
    const sF = subtitleStartFrame(sub, fps)
    const eF = subtitleEndFrame(sub, fps)
    if (eF > fromFrame && sF < toFrame) {
      const startFrame = Math.max(0, Math.min(len, sF - fromFrame))
      const endFrame = Math.max(0, Math.min(len, eF - fromFrame))
      // Descarta lascas: cópia recortada a <0.35s na borda da janela é
      // ilegível e (antes do guard no componente) gerava range não-monotônico
      // no interpolate do fade — exceção que matava o vídeo no fim do hook.
      if (endFrame - startFrame < Math.round(fps * 0.35)) continue
      remapped.push({
        ...sub,
        startTime: Math.max(0, Math.min(maxSec, sub.startTime - secFrom)),
        endTime: Math.max(0, Math.min(maxSec, sub.endTime - secFrom)),
        startFrame,
        endFrame,
        words: remapWords(sub.words, secFrom, maxSec)
      } as SubtitleEntry)
    }
  }

  return [...remapped, ...shifted]
}

export interface ResolveAudioSfxOptions extends ToRemotionSceneOptions {
  /**
   * Server-only existence check (fs.existsSync-backed) for the resolved SFX
   * asset. When provided, events whose asset file is missing are dropped.
   * Omitted in the browser/player context, where fs isn't available — the
   * plan is already the source of truth for which kinds were emitted.
   */
  assetExists?: (kind: string) => boolean
}

const DEFAULT_SFX_VOLUME = 0.5

/**
 * Resolve the plan's `audio` track into playable SFX events: only entries
 * with type === 'sfx' are kept, each mapped to /audio/sfx/<kind>.wav
 * (absolute when `baseUrl` is given, relative otherwise — same convention as
 * resolveImageSrc / resolveLayoutSegments). Pure by default (no fs) — pass
 * `assetExists` from the server-only audio-assets.ts to additionally filter
 * out events whose asset file doesn't exist.
 */
export function resolveAudioSfxEvents(
  plan: { audio?: unknown } | null | undefined,
  opts: ResolveAudioSfxOptions = {}
): AudioSfxEventInput[] {
  const events = plan?.audio
  if (!Array.isArray(events)) return []

  return events
    .map((raw: any): AudioSfxEventInput | null => {
      if (!raw || typeof raw !== 'object' || raw.type !== 'sfx') return null
      const kind = raw.props && typeof raw.props.kind === 'string' ? raw.props.kind : null
      const fromFrame = Number(raw.fromFrame)
      if (!kind || !Number.isFinite(fromFrame)) return null
      if (opts.assetExists && !opts.assetExists(kind)) return null

      const volume =
        raw.props && typeof raw.props.volume === 'number' ? raw.props.volume : DEFAULT_SFX_VOLUME

      return {
        kind,
        src: resolveImageSrc(`/audio/sfx/${kind}.wav`, opts.baseUrl),
        fromFrame,
        volume
      }
    })
    .filter((event): event is AudioSfxEventInput => event !== null)
}

/**
 * Normalise the `words` array on each subtitle entry.
 * Accepts both string words and {word, start, end} objects.
 * Falls back to splitting subtitle.text by whitespace when no valid words remain.
 */
export function normalizeSubtitleWords(subtitles: SubtitleEntry[]): SubtitleEntry[] {
  return subtitles.map((subtitle) => {
    const words = subtitle.words
      ?.map((word: any) => {
        if (typeof word === 'string') return word
        return {
          word: String(word.word || '').trim(),
          start: Number(word.start),
          end: Number(word.end)
        }
      })
      .filter((word: any) =>
        typeof word === 'string'
          ? Boolean(word)
          : Boolean(word.word) && Number.isFinite(word.start) && Number.isFinite(word.end)
      )

    return {
      ...subtitle,
      words: words && words.length > 0 ? words : subtitle.text.split(/\s+/).filter(Boolean)
    }
  }) as SubtitleEntry[]
}
