'use client'

import { Player } from '@remotion/player'
import { VideoComposition } from '../../remotion/src/VideoComposition'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'

interface RemotionProjectPlayerProps {
  projectId: string
  format: '9:16' | '16:9'
  fps: number
  durationFrames: number
  scenes: Scene[]
  subtitles: SubtitleEntry[]
  transcription: Transcription | null
  stylePreset: string
  palette: any
}

type RemotionSceneInput = {
  type: string
  from: number
  to: number
  fromFrame: number
  toFrame: number
  props: Record<string, any>
}

function normalizeImageInsertLayout(value: unknown): 'full' | 'split-bottom' | 'top-image-compact' {
  return value === 'split-bottom' || value === 'top-image-compact' ? value : 'full'
}

function normalizeRemotionScenes(scenes: RemotionSceneInput[], fps: number): RemotionSceneInput[] {
  const gapFrames = Math.max(6, Math.round(fps * 0.35))
  const minDurationFrames = Math.max(1, Math.round(fps * 2.8))
  let cursorFrame = 0

  return [...scenes]
    .sort((a, b) => a.fromFrame - b.fromFrame)
    .map((scene) => {
      const durationFrames = Math.max(scene.toFrame - scene.fromFrame, minDurationFrames)
      const fromFrame = Math.max(scene.fromFrame, cursorFrame)
      const toFrame = fromFrame + durationFrames
      cursorFrame = toFrame + gapFrames

      return {
        ...scene,
        from: fromFrame / fps,
        to: toFrame / fps,
        fromFrame,
        toFrame
      }
    })
}

function toRemotionScene(scene: Scene, fps: number): RemotionSceneInput | null {
  const startFrame = scene.startFrame || 0
  const endFrame = Math.max(scene.endFrame || 0, startFrame + Math.round(fps * 2.8))
  const {
    id: _id,
    type,
    startLeg: _startLeg,
    durationInSubtitles: _durationInSubtitles,
    startFrame: _startFrame,
    endFrame: _endFrame,
    ...props
  } = scene as any

  const typeMap: Record<string, string> = {
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
    adaptedProps.imageSrc = adaptedProps.imageSrc || adaptedProps.imagePath || ''
    if (!adaptedProps.imageSrc) {
      return null
    }
    adaptedProps.layout = normalizeImageInsertLayout(adaptedProps.layout)
  }

  return {
    type: typeMap[type] || 'fullscreen',
    from: startFrame / fps,
    to: endFrame / fps,
    fromFrame: startFrame,
    toFrame: endFrame,
    props: adaptedProps
  }
}

export function RemotionProjectPlayer({
  projectId,
  format,
  fps,
  durationFrames,
  scenes,
  subtitles,
  transcription,
  stylePreset,
  palette
}: RemotionProjectPlayerProps) {
  const compositionWidth = format === '9:16' ? 1080 : 1920
  const compositionHeight = format === '9:16' ? 1920 : 1080
  const inputProps = {
    scenes: normalizeRemotionScenes(
      scenes
        .map((scene) => toRemotionScene(scene, fps || 30))
        .filter((scene): scene is RemotionSceneInput => Boolean(scene)),
      fps || 30
    ),
    subtitles: subtitles.map((subtitle) => {
      const words = subtitle.words
        ?.map((word: any) => {
          if (typeof word === 'string') {
            return word
          }

          return {
            word: String(word.word || '').trim(),
            start: Number(word.start),
            end: Number(word.end)
          }
        })
        .filter((word: any) => (
          typeof word === 'string'
            ? Boolean(word)
            : Boolean(word.word) && Number.isFinite(word.start) && Number.isFinite(word.end)
        ))

      return {
        ...subtitle,
        words: words && words.length > 0 ? words : subtitle.text.split(/\s+/).filter(Boolean)
      }
    }),
    transcription: transcription || { text: '', language: 'pt', segments: [] },
    palette,
    videoSrc: `/api/video/${projectId}?source=primary`,
    format,
    stylePreset
  }

  return (
    <Player
      component={VideoComposition}
      inputProps={inputProps}
      acknowledgeRemotionLicense
      durationInFrames={Math.max(1, durationFrames)}
      compositionWidth={compositionWidth}
      compositionHeight={compositionHeight}
      fps={fps || 30}
      controls
      style={{
        width: '100%',
        backgroundColor: '#000'
      }}
    />
  )
}
