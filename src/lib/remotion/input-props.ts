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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemotionSceneInput {
  type: string
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

export interface RemotionInputProps {
  scenes: RemotionSceneInput[]
  subtitles: SubtitleEntry[]
  transcription: Transcription
  palette: ColorPalette
  videoSrc: string
  format: '9:16' | '16:9'
  stylePreset?: string
  creator?: RemotionCreator
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

const TYPE_MAP: Record<string, string> = {
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
  ImageInsert: 'image-insert'
}

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
    if (!adaptedProps.imageSrc) return null
    adaptedProps.layout = normalizeImageInsertLayout(adaptedProps.layout)
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
 *  2. Clamp toFrame so duration >= minDurationFrames — WITHOUT moving fromFrame.
 *
 * FORBIDDEN: cursor accumulation, gap between scenes, shifting fromFrame.
 * The startFrame produced by resolveSceneTiming() is the source of truth.
 * Residual overlap between consecutive scenes is acceptable.
 */
export function prepareRemotionScenes(
  scenes: RemotionSceneInput[],
  fps: number
): RemotionSceneInput[] {
  const minDurationFrames = Math.round(fps * MIN_SCENE_SECONDS)

  return [...scenes]
    .sort((a, b) => a.fromFrame - b.fromFrame)
    .map((scene) => {
      const toFrame = Math.max(scene.toFrame, scene.fromFrame + minDurationFrames)
      return {
        ...scene,
        toFrame,
        to: toFrame / fps
        // fromFrame and from are intentionally unchanged
      }
    })
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
