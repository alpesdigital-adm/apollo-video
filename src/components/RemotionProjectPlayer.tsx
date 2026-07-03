'use client'

import { useEffect, useRef, useState } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { VideoComposition } from '../../remotion/src/VideoComposition'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'
import {
  toRemotionScene,
  prepareRemotionScenes,
  normalizeSubtitleWords,
  resolveLayoutSegments,
  resolvePunchIns,
  type AudioInputProps,
  type RemotionCreator,
  type RemotionSceneInput,
  type SubtitleStyle
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
  editPlan?: { layoutSegments?: unknown; hookTitle?: unknown; punchIns?: unknown; audio?: unknown } | null
  musicPick?: { src: string; volume: number } | null
  // Optional: parent gets a handle to seek the player to a frame (beat panel).
  seekRef?: React.MutableRefObject<{ seekTo: (frame: number) => void } | null>
  // Optional: notified (throttled) with the current playback frame, for the beat panel highlight.
  onFrameUpdate?: (frame: number) => void
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
  palette,
  editPlan,
  musicPick,
  seekRef,
  onFrameUpdate
}: RemotionProjectPlayerProps) {
  const compositionWidth = format === '9:16' ? 1080 : 1920
  const compositionHeight = format === '9:16' ? 1920 : 1080
  const activeFps = fps || 30
  const [creator, setCreator] = useState<RemotionCreator | undefined>(undefined)
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>('kinetic')
  const playerRef = useRef<PlayerRef>(null)

  // Expose a minimal seek handle to the parent (used by the beat panel).
  useEffect(() => {
    if (!seekRef) return
    seekRef.current = {
      seekTo: (frame: number) => {
        playerRef.current?.seekTo(Math.max(0, Math.floor(frame)))
      }
    }
    return () => {
      seekRef.current = null
    }
  }, [seekRef])

  // Keep a live ref to the callback so the listener effect below doesn't need to
  // re-subscribe every time the parent passes a new function identity.
  const onFrameUpdateRef = useRef(onFrameUpdate)
  useEffect(() => {
    onFrameUpdateRef.current = onFrameUpdate
  }, [onFrameUpdate])

  // Emit the current playback frame (throttled to ~4x/second) for the beat panel highlight.
  useEffect(() => {
    const player = playerRef.current
    if (!player) return

    const THROTTLE_MS = 250
    let lastEmit = 0

    const handleFrameUpdate = (event: { detail: { frame: number } }) => {
      const now = Date.now()
      if (now - lastEmit < THROTTLE_MS) return
      lastEmit = now
      onFrameUpdateRef.current?.(event.detail.frame)
    }

    player.addEventListener('frameupdate', handleFrameUpdate)
    return () => {
      player.removeEventListener('frameupdate', handleFrameUpdate)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetch('/api/settings/profile')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data || !data.name || !data.handle) return
        setCreator({ name: data.name, handle: data.handle, avatarUrl: data.avatarUrl || null })
      })
      .catch((error) => console.error('Failed to load creator profile:', error))

    fetch('/api/settings/style')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data.subtitleStyle !== 'string') return
        setSubtitleStyle(data.subtitleStyle as SubtitleStyle)
      })
      .catch((error) => console.error('Failed to load subtitle style:', error))

    return () => {
      cancelled = true
    }
  }, [])

  const hookTitle =
    editPlan && typeof editPlan.hookTitle === 'string' && editPlan.hookTitle.trim()
      ? (editPlan.hookTitle as string)
      : undefined

  // SFX removidos por decisão de produto (2026-07-03) — só trilha de fundo.
  const audio: AudioInputProps | undefined = musicPick
    ? { events: [], music: musicPick }
    : undefined

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
    videoSrc: `/api/video/${projectId}?source=preview`,
    format,
    stylePreset,
    subtitleStyle,
    ...(hookTitle ? { hookTitle } : {}),
    creator,
    layoutSegments: resolveLayoutSegments(editPlan),
    punchIns: resolvePunchIns(editPlan),
    ...(audio ? { audio } : {})
  }

  return (
    <Player
      ref={playerRef}
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
