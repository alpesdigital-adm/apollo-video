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
  LayoutSegmentEffects,
  PlanPunchIn
} from '../types/edl'
import type { Scene } from '../types/scene'
import type { SubtitleEntry } from '../types/project'
import { readStylePrefs } from '../style-prefs'
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

const TYPOGRAPHIC_SCENE_TYPES = new Set(['FullScreen', 'Card', 'Number', 'SplitVertical', 'CTA'])
const SFX_MIN_GAP_SECONDS = 0.5
const WHOOSH_VOLUME = 0.5
const IMPACT_VOLUME = 0.6
const RISER_VOLUME = 0.45

interface SfxCandidate {
  fromFrame: number
  toFrame: number
  kind: 'whoosh' | 'impact' | 'riser'
  volume: number
}

/**
 * Candidate SFX triggers, one per visual event: whoosh on ImageInsert scenes
 * and repositioning layout segments (split-50/blur-bg/tweet-card), impact on
 * typographic scenes, and a single riser under the hook headline's entrance.
 * Not yet de-duplicated — see dedupeSfxCandidates.
 */
function buildSfxCandidates(
  scenes: Scene[],
  layoutSegments: LayoutSegment[],
  hookTitle: string | undefined,
  fps: number
): SfxCandidate[] {
  const candidates: SfxCandidate[] = []
  const whooshFrames = Math.max(1, Math.round(fps * 0.5))
  const impactFrames = Math.max(1, Math.round(fps * 0.4))

  if (hookTitle) {
    const riserFrames = Math.round(fps * 1.6)
    candidates.push({ fromFrame: 0, toFrame: riserFrames, kind: 'riser', volume: RISER_VOLUME })
  }

  for (const scene of scenes) {
    const startFrame = scene.startFrame ?? 0
    if (scene.type === 'ImageInsert') {
      candidates.push({
        fromFrame: startFrame,
        toFrame: startFrame + whooshFrames,
        kind: 'whoosh',
        volume: WHOOSH_VOLUME
      })
    } else if (TYPOGRAPHIC_SCENE_TYPES.has(scene.type)) {
      candidates.push({
        fromFrame: startFrame,
        toFrame: startFrame + impactFrames,
        kind: 'impact',
        volume: IMPACT_VOLUME
      })
    }
  }

  for (const segment of layoutSegments) {
    if (segment.layout === 'split-50' || segment.layout === 'blur-bg' || segment.layout === 'tweet-card') {
      candidates.push({
        fromFrame: segment.fromFrame,
        toFrame: segment.fromFrame + whooshFrames,
        kind: 'whoosh',
        volume: WHOOSH_VOLUME
      })
    }
  }

  return candidates
}

/**
 * Anti-machine-gun rule: sort candidates by fromFrame and drop any candidate
 * landing within SFX_MIN_GAP_SECONDS of the last KEPT one (first one wins —
 * this also naturally collapses an ImageInsert scene that also produced a
 * layoutSegment at the same frame down to a single whoosh).
 */
function dedupeSfxCandidates(candidates: SfxCandidate[], fps: number): SfxCandidate[] {
  const minGapFrames = Math.max(1, Math.round(fps * SFX_MIN_GAP_SECONDS))
  const sorted = [...candidates].sort((a, b) => a.fromFrame - b.fromFrame)
  const kept: SfxCandidate[] = []

  for (const candidate of sorted) {
    const last = kept[kept.length - 1]
    if (last && candidate.fromFrame - last.fromFrame < minGapFrames) {
      continue
    }
    kept.push(candidate)
  }

  return kept
}

function buildSfxAudioEvents(
  scenes: Scene[],
  layoutSegments: LayoutSegment[],
  hookTitle: string | undefined,
  fps: number
): EditAudioEvent[] {
  const candidates = dedupeSfxCandidates(
    buildSfxCandidates(scenes, layoutSegments, hookTitle, fps),
    fps
  )

  return candidates.map((candidate, index) => ({
    id: `sfx-${index + 1}-${candidate.kind}`,
    type: 'sfx',
    from: framesToSeconds(candidate.fromFrame, fps),
    to: framesToSeconds(candidate.toFrame, fps),
    fromFrame: candidate.fromFrame,
    toFrame: candidate.toFrame,
    props: { kind: candidate.kind, volume: candidate.volume }
  }))
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
      // split-50 / blur-bg: media comes from the ImageInsert asset. Prefer the
      // animated/stock clip (Pacote 3) when present, else the still.
      props.mediaSrc =
        (scene as any).videoSrc ||
        (scene as any).imageSrc ||
        (scene as any).imagePath ||
        ''
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

/**
 * Jump-cut punch-in track (Pacote 5). Each interval BETWEEN two consecutive
 * silence cuts gets a base-video scale that alternates 1.0 / 1.06 (starting at
 * 1.0). Intervals shorter than 0.8s inherit the previous interval's scale so the
 * frame doesn't flicker. Only intervals that actually scale (1.06) are emitted —
 * VideoComposition keeps the base video at 1.0 wherever no punch-in is active.
 */
function buildPunchIns(
  cuts: EditCut[],
  durationFrames: number,
  fps: number,
  subtitles: SubtitleEntry[] = []
): PlanPunchIn[] {
  const rawPoints = cuts
    .map((cut) => Math.max(0, Math.min(cut.sourceStartFrame, durationFrames)))
    .filter((frame) => Number.isFinite(frame))

  // FIX 5: a narrator with almost no pauses yields <4 boundaries, so the punch-in
  // track comes out empty and the jump cuts aren't disguised. When silence cuts
  // give fewer than 4 boundaries, complement with synthetic boundaries derived
  // from the subtitles — the end of every 2nd subtitle, kept only if ≥1.6s from
  // the previous synthetic boundary — until the timeline is covered.
  if (new Set(rawPoints).size < 4 && subtitles.length > 0) {
    const minSpacingFrames = Math.max(1, Math.round(fps * 1.6))
    let lastSynthetic = -Infinity
    for (let i = 1; i < subtitles.length; i += 2) {
      const frame = Math.max(0, Math.min(subtitles[i].endFrame ?? 0, durationFrames))
      if (!Number.isFinite(frame)) continue
      if (frame - lastSynthetic >= minSpacingFrames) {
        rawPoints.push(frame)
        lastSynthetic = frame
      }
    }
  }

  const points = Array.from(new Set(rawPoints)).sort((a, b) => a - b)

  if (points.length < 2) return []

  const shortFrames = Math.max(1, Math.round(fps * 0.8))
  const punchIns: PlanPunchIn[] = []
  let nextBig = 1.0
  let prevAssigned = 1.0

  for (let i = 0; i < points.length - 1; i += 1) {
    const fromFrame = points[i]
    const toFrame = points[i + 1]
    if (toFrame <= fromFrame) continue

    let scale: number
    if (toFrame - fromFrame < shortFrames) {
      scale = prevAssigned
    } else {
      scale = nextBig
      nextBig = nextBig === 1.0 ? 1.06 : 1.0
    }
    prevAssigned = scale

    if (scale !== 1.0) {
      punchIns.push({ fromFrame, toFrame, scale })
    }
  }

  return punchIns
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

    const layoutSegments = buildLayoutSegments(context.scenes, context.fps)
    const punchIns = readStylePrefs().jumpCutPunchIns
      ? buildPunchIns(cuts, durationFrames, context.fps, context.subtitles)
      : []
    const hookTitle =
      typeof context.hookTitle === 'string' && context.hookTitle.trim()
        ? context.hookTitle.trim()
        : undefined

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
      audio: [
        ...buildNarrativeAudioEvents(cuts, context.fps),
        ...buildSfxAudioEvents(context.scenes, layoutSegments, hookTitle, context.fps)
      ],
      ports: {
        acceptsNarration: true,
        acceptsVisualMontage: false,
        canUseBroll: true,
        canUseMusicDrivenCuts: false
      },
      lineage: buildCreativeLineage(context, durationFrames),
      layoutSegments,
      ...(hookTitle ? { hookTitle } : {}),
      ...(punchIns.length > 0 ? { punchIns } : {}),
      notes: [
        'Engine optimized for narrated videos with speech-timed subtitles and scene overlays.',
        'Future visual engines should implement the same EditPlan contract and can replace ranges/overlays/audio without changing the renderer.'
      ]
    }

    return assertEnginePlan(plan)
  }
}
