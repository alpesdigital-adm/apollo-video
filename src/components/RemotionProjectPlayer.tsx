'use client'

import { Player } from '@remotion/player'
import { VideoComposition } from '../../remotion/src/VideoComposition'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'
import {
  toRemotionScene,
  prepareRemotionScenes,
  normalizeSubtitleWords,
  type RemotionSceneInput
} from '@/lib/remotion/input-props'

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
  const activeFps = fps || 30
  const inputProps = {
    scenes: prepareRemotionScenes(
      scenes
        .map((scene) => toRemotionScene(scene, activeFps))
        .filter((scene): scene is RemotionSceneInput => Boolean(scene)),
      activeFps
    ),
    subtitles: normalizeSubtitleWords(subtitles),
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
