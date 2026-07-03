import type {
  CreativeLineage,
  CreativeLineageUnit,
  EditAudioEvent,
  EditCut,
  EditOverlay,
  EditPlan,
  EditRange,
  EditSource,
  LayoutSegment,
  LayoutSegmentEffects
} from '../types/edl'
import type { Scene } from '../types/scene'
import { framesToSeconds, secondsToFrames } from '../utils/timing'
import type { VideoEngine, VideoEngineContext } from './video-engine'
import { assertEnginePlan } from './video-engine'

function sceneToOverlay(scene: Scene, fps: number): EditOverlay {
  const fromFrame = scene.startFrame || 0
  const toFrame = Math.max(scene.endFrame || 0, fromFrame + fps)
  const startTime = framesToSeconds(fromFrame, fps)
  const endTime = framesToSeconds(toFrame, fps)
  const {
    id,
    type,
    startLeg: _startLeg,
    durationInSubtitles: _durationInSubtitles,
    startFrame: _startFrame,
    endFrame: _endFrame,
    ...props
  } = scene as any

  return {
    id,
    kind: 'scene',
    sceneType: type,
    from: startTime,
    to: endTime,
    fromFrame,
    toFrame,
    props
  }
}

function buildSources(context: VideoEngineContext): EditSource[] {
  const sources: EditSource[] = []

  if (context.source.rawPath) {
    sources.push({
      id: 'raw',
      role: 'raw',
      path: context.source.rawPath,
      duration: context.source.duration,
      width: context.source.width || undefined,
      height: context.source.height || undefined,
      fps: context.fps
    })
  }

  sources.push({
    id: 'primary',
    role: 'primary',
    path: context.source.renderPath,
    duration: context.source.duration,
    width: context.source.width || undefined,
    height: context.source.height || undefined,
    fps: context.fps
  })

  return sources
}

function buildNarrativeAudioEvents(cuts: EditCut[], fps: number): EditAudioEvent[] {
  return cuts.flatMap((cut, index) => {
    const pointFrame = Math.max(0, cut.sourceStartFrame)
    const fadeFrames = Math.max(1, Math.round(fps * 0.03))
    const point = framesToSeconds(pointFrame, fps)
    return [
      {
        id: `cut-${index + 1}-fade-out`,
        type: 'fade',
        from: framesToSeconds(Math.max(0, pointFrame - fadeFrames), fps),
        to: point,
        fromFrame: Math.max(0, pointFrame - fadeFrames),
        toFrame: pointFrame,
        props: { curve: 'quick-boundary' }
      },
      {
        id: `cut-${index + 1}-fade-in`,
        type: 'fade',
        from: point,
        to: framesToSeconds(pointFrame + fadeFrames, fps),
        fromFrame: pointFrame,
        toFrame: pointFrame + fadeFrames,
        props: { curve: 'quick-boundary' }
      }
    ]
  })
}

function sceneToLineageUnit(scene: Scene, fps: number): CreativeLineageUnit {
  const startFrame = scene.startFrame || 0
  const endFrame = Math.max(scene.endFrame || 0, startFrame + fps)
  const sourceSubtitleStart = scene.startLeg
  const sourceSubtitleEnd = Math.max(
    sourceSubtitleStart,
    sourceSubtitleStart + Math.max(1, scene.durationInSubtitles || 1) - 1
  )

  if (scene.type === 'ImageInsert') {
    return {
      id: scene.id,
      kind: 'generated-image',
      role: scene.narrativeRole,
      visualRole: scene.visualRole,
      sceneType: scene.type,
      startFrame,
      endFrame,
      sourceSubtitleStart,
      sourceSubtitleEnd,
      assetPath: scene.imagePath,
      prompt: scene.imagePrompt,
      sourceText: scene.sourceText || scene.imageAlt
    }
  }

  return {
    id: scene.id,
    kind: 'overlay',
    sceneType: scene.type,
    startFrame,
    endFrame,
    sourceSubtitleStart,
    sourceSubtitleEnd
  }
}

function normalizeSegmentEffects(value: unknown): LayoutSegmentEffects | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const effects: LayoutSegmentEffects = {}
  if (raw.zoom === 'in' || raw.zoom === 'out') effects.zoom = raw.zoom
  if (raw.bw === true) effects.bw = true
  return effects.zoom || effects.bw ? effects : undefined
}

/**
 * Derive the segment layout track from scenes carrying `segmentLayout`.
 * Each such scene becomes one segment covering its [startFrame, endFrame)
 * window. Scenes without `segmentLayout` stay fullscreen (not materialized).
 * Since scenes never overlap, the derived segments never overlap either.
 */
function buildLayoutSegments(scenes: Scene[], fps: number): LayoutSegment[] {
  const segments: LayoutSegment[] = []

  for (const scene of scenes) {
    const rawLayout = (scene as any).segmentLayout
    const effects = normalizeSegmentEffects((scene as any).segmentEffects)
    const hasLayout =
      rawLayout === 'split-50' || rawLayout === 'blur-bg' || rawLayout === 'tweet-card'

    // A scene contributes a segment when it either repositions the base video
    // (segmentLayout) OR only tints/zooms it (segmentEffects on a fullscreen
    // base). Scenes with neither stay implicitly fullscreen (not materialized).
    if (!hasLayout && !effects) {
      continue
    }

    const layout: LayoutSegment['layout'] = hasLayout ? rawLayout : 'fullscreen'
    const fromFrame = scene.startFrame ?? 0
    const toFrame = Math.max(scene.endFrame ?? 0, fromFrame + Math.max(1, Math.round(fps * 0.5)))
    const props: Record<string, unknown> = {}

    if (layout === 'tweet-card') {
      props.text =
        (scene as any).text ||
        (scene as any).sourceText ||
        (scene as any).imageAlt ||
        (scene as any).title ||
        ''
    } else if (scene.type === 'ImageInsert') {
      // split-50 / blur-bg: media comes from the ImageInsert asset.
      props.mediaSrc = (scene as any).imageSrc || (scene as any).imagePath || ''
    }

    segments.push({
      id: `seg-${scene.id}`,
      fromFrame,
      toFrame,
      layout,
      ...(effects ? { effects } : {}),
      props
    })
  }

  return segments.sort((a, b) => a.fromFrame - b.fromFrame)
}

function buildCreativeLineage(context: VideoEngineContext, durationFrames: number): CreativeLineage {
  return {
    projectId: context.projectId,
    strategy: 'recorded-narrative',
    sourceOfTruth: 'uploaded-video',
    stylePreset: context.stylePreset,
    generatedAt: new Date().toISOString(),
    units: [
      {
        id: 'source-video',
        kind: 'source-video',
        startFrame: 0,
        endFrame: durationFrames,
        assetPath: context.source.rawPath || context.source.renderPath,
        sourceText: 'Original uploaded recording remains the source of truth.'
      },
      ...context.scenes.map((scene) => sceneToLineageUnit(scene, context.fps))
    ],
    protectedWorkflow: [
      'The user starts from a real uploaded recording.',
      'Remotion/EditPlan remains the rendering contract.',
      'Narrative roles are internal editorial metadata, not a required user workflow.'
    ],
    futurePorts: [
      'Synthetic presenter/avatar engine can generate a primary source later.',
      'Visual montage engine can replace narrative ranges for non-narrated videos later.'
    ]
  }
}

export const narrativeEngine: VideoEngine = {
  kind: 'narrative',
  name: 'Apollo Narrative Engine',
  version: '0.1.0',

  createPlan(context: VideoEngineContext): EditPlan {
    const duration = context.source.duration
    const durationFrames = secondsToFrames(duration, context.fps)
    const cuts: EditCut[] = context.silences.map((silence, index) => ({
      id: `silence-${index + 1}`,
      sourceStart: silence.startTime,
      sourceEnd: silence.endTime,
      sourceStartFrame: secondsToFrames(silence.startTime, context.fps),
      sourceEndFrame: secondsToFrames(silence.endTime, context.fps),
      removedDuration: silence.duration,
      removedFrames: secondsToFrames(silence.duration, context.fps),
      reason: 'silence'
    }))

    const ranges: EditRange[] = [
      {
        id: 'primary-range-1',
        sourceId: 'primary',
        sourceStart: 0,
        sourceEnd: duration,
        timelineStart: 0,
        timelineEnd: duration,
        sourceStartFrame: 0,
        sourceEndFrame: durationFrames,
        timelineStartFrame: 0,
        timelineEndFrame: durationFrames,
        reason: 'Narrative autocut media after silence removal'
      }
    ]

    const plan: EditPlan = {
      version: 1,
      engine: {
        kind: this.kind,
        name: this.name,
        version: this.version
      },
      format: context.format,
      stylePreset: context.stylePreset,
      fps: context.fps,
      duration,
      durationFrames,
      renderSourceId: 'primary',
      sources: buildSources(context),
      ranges,
      cuts,
      subtitles: context.subtitles,
      overlays: context.scenes.map((scene) => sceneToOverlay(scene, context.fps)),
      audio: buildNarrativeAudioEvents(cuts, context.fps),
      ports: {
        acceptsNarration: true,
        acceptsVisualMontage: false,
        canUseBroll: true,
        canUseMusicDrivenCuts: false
      },
      lineage: buildCreativeLineage(context, durationFrames),
      layoutSegments: buildLayoutSegments(context.scenes, context.fps),
      notes: [
        'Engine optimized for narrated videos with speech-timed subtitles and scene overlays.',
        'Future visual engines should implement the same EditPlan contract and can replace ranges/overlays/audio without changing the renderer.'
      ]
    }

    return assertEnginePlan(plan)
  }
}
