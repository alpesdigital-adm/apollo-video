import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  createDesiredAction,
  createDesiredActionReference,
  type DesiredActionInput,
  type DesiredActionReference,
} from '../domain/desired-action.ts'
import {
  validateDirectedEditPlan,
  type DirectedEditPlan,
  type DirectedTransition,
} from '../domain/director-run.ts'
import { assertDomain } from '../domain/errors.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'
import type { EditorialCutClip } from './apply-editorial-cut-command.ts'

/**
 * One renderable plan shape for every Wave 20 compiler (F4.015, F4.016 cond. 6).
 *
 * `DirectedEditPlan` is the only plan the render path accepts, and
 * `validateDirectedEditPlan` (`director-run.ts:335`) is the only thing that says
 * a plan is renderable. Both the react playback map and the multi-range
 * synthesis produce cuts that nothing could render before this wave, and both
 * would otherwise have grown a private plan type — two shapes, two validators,
 * and a renderer that has to know which one it was handed. So the assembly
 * lives here once, and the two compilers differ only in the clips and the
 * reasons they hand it.
 *
 * ## What a plan built here is NOT
 *
 * It is not a director run. Nobody planned it, no critic scored it and no
 * rubric approved it — a playback map and a synthesis are their own decisions,
 * already justified in their own aggregates. The three reference fields the
 * validator demands (`storyPlanId`, `treatmentPlanId`, `directorRunId`) are
 * therefore filled with the *derivation* that produced the cut, spelled
 * `<origin>:<id>`, and never with an id shaped like a director run's. Writing a
 * plausible `director-run-…` there would let every later reader — the proxy
 * render repository included — believe a critic passed this plan, which is the
 * one thing this compiler cannot claim.
 *
 * `director.decisions` is empty for the same reason, and the assumptions say so
 * in words rather than leaving a reader to notice the empty array.
 */

export const RENDERABLE_PLAN_ORIGINS = Object.freeze([
  'react-playback',
  'multi-range-synthesis',
] as const)
export type RenderablePlanOrigin = (typeof RENDERABLE_PLAN_ORIGINS)[number]

export const RENDERABLE_PLAN_COMPILER_VERSION = 'renderable-edit-plan/2026-09-05-v1'

/**
 * The edge fade the director puts on every straight cut
 * (`run-project-director.ts:884`), reused rather than re-chosen.
 *
 * A splice that joins words the speaker never said consecutively arguably wants
 * a longer one, but nothing here measured how much longer, and a number picked
 * to sound plausible is a creative decision wearing an engineering face.
 */
export const RENDERABLE_PLAN_AUDIO_FADE_MS = 24

/** Subtitles are not compiled by these paths; the policy still has to be stated. */
const SUBTITLE_MAX_CHARACTERS = 32

export interface RenderablePlanSource {
  readonly id: string
  readonly artifactId: string
  readonly kind: 'video'
  /** Measured on the file. Never derived from the timeline that uses it. */
  readonly durationSeconds: number
}

/**
 * Why one clip gives way to the next.
 *
 * Required, one per seam, because `validateDirectedEditPlan` demands a
 * transition per seam and a transition carries a `reason`. A compiler that had
 * nothing to say here would be cutting for no stated reason.
 */
export interface RenderablePlanSeam {
  readonly reason: string
}

export interface RenderablePlanMarker {
  readonly kind: 'editorial-cut'
  readonly atFrame: number
  readonly sourceStartSeconds: number
  readonly sourceEndSeconds: number
  readonly ruleIds: readonly string[]
}

/**
 * The aggregate whose decision this plan materializes, by identity and by hash.
 *
 * The hash is what makes a stored plan falsifiable later: a map or a synthesis
 * that moved on leaves the plan naming a hash nothing matches, which is how a
 * dependant knows it is stale instead of rendering last week's cut.
 */
export interface RenderablePlanDerivation {
  readonly origin: RenderablePlanOrigin
  readonly id: string
  readonly hash: string
  /** The chain position, where the source aggregate is versioned. */
  readonly version?: number
}

export interface AssembleDirectedEditPlanInput {
  readonly planId: string
  readonly projectVersionId: string
  readonly derivedFrom: Readonly<RenderablePlanDerivation>
  /** A real StoryPlan id when one exists; otherwise the derivation names itself. */
  readonly storyPlanId?: string
  readonly objective: StrategicObjectiveId
  readonly desiredAction?: Readonly<DesiredActionInput>
  readonly fps: number
  readonly sources: readonly Readonly<RenderablePlanSource>[]
  readonly clips: readonly Readonly<EditorialCutClip>[]
  readonly seams: readonly Readonly<RenderablePlanSeam>[]
  readonly markers?: readonly Readonly<RenderablePlanMarker>[]
  /** Source spans this cut kept, in the source's own seconds. */
  readonly retainedSourceRanges?: readonly Readonly<{ sourceStartSeconds: number; sourceEndSeconds: number }>[]
  readonly lineageRefs: readonly string[]
  readonly assumptions: readonly string[]
  readonly createdAt: string
}

/**
 * Assemble clips into a plan the renderer accepts, or refuse.
 *
 * Everything the validator checks is derived here — the duration from the last
 * clip, the audio timeline hash from the clips themselves, the transitions from
 * the seams — so a caller cannot declare a duration the clips do not add up to.
 */
export function assembleDirectedEditPlan(
  input: AssembleDirectedEditPlanInput,
): Readonly<DirectedEditPlan> {
  assertDomain(
    RENDERABLE_PLAN_ORIGINS.includes(input.derivedFrom.origin),
    'INVALID_ARGUMENT',
    'a renderable plan must name a known derivation origin',
  )
  assertDomain(
    Number.isFinite(input.fps) && input.fps > 0,
    'INVALID_RENDER_INPUT',
    'a renderable plan needs a positive frame rate',
  )
  assertDomain(input.clips.length > 0, 'INVALID_RENDER_INPUT', 'a renderable plan needs at least one clip')
  assertDomain(
    input.seams.length === input.clips.length - 1,
    'INVALID_RENDER_INPUT',
    `a plan of ${input.clips.length} clips has ${input.clips.length - 1} seams; ${input.seams.length} reasons were given`,
  )

  // Every artifact a clip reads from — picture and sound — has to be declared as
  // a source, because the render input resolver materializes exactly the
  // declared sources. A clip whose audio comes from an undeclared artifact
  // renders silent, and nothing downstream would say why.
  const declared = new Set(input.sources.map((source) => source.artifactId))
  for (const clip of input.clips) {
    assertDomain(
      declared.has(clip.sourceArtifactId),
      'INVALID_RENDER_INPUT',
      `clip ${clip.id} reads from ${clip.sourceArtifactId}, which the plan does not declare as a source`,
    )
    assertDomain(
      clip.audioSourceArtifactId === undefined || declared.has(clip.audioSourceArtifactId),
      'INVALID_RENDER_INPUT',
      `clip ${clip.id} takes audio from ${String(clip.audioSourceArtifactId)}, which the plan does not declare as a source`,
    )
  }

  const durationFrames = input.clips[input.clips.length - 1]!.timelineOutFrame
  const provenanceRef = `${input.derivedFrom.origin}:${input.derivedFrom.id}`
  const desiredAction = createDesiredAction({
    objective: input.objective,
    ...(input.desiredAction ? { desiredAction: input.desiredAction } : {}),
  })
  const desiredActionRef: Readonly<DesiredActionReference> = createDesiredActionReference(desiredAction)

  const transitions: readonly Readonly<DirectedTransition>[] = Object.freeze(
    input.seams.map((seam, index) => {
      assertDomain(
        seam.reason.trim().length > 0,
        'INVALID_RENDER_INPUT',
        `seam ${index} joins two clips and must say why`,
      )
      const before = input.clips[index]!
      return Object.freeze({
        id: `transition-${index + 1}`,
        fromClipId: before.id,
        toClipId: input.clips[index + 1]!.id,
        atFrame: before.timelineOutFrame,
        type: 'straight-cut' as const,
        audioFadeMs: RENDERABLE_PLAN_AUDIO_FADE_MS,
        reason: seam.reason.trim(),
      })
    }),
  )

  const plan: DirectedEditPlan = {
    schemaVersion: 2,
    state: 'compiled',
    id: input.planId,
    projectVersionId: input.projectVersionId,
    // See the module comment: these three name the derivation, not a director.
    storyPlanId: input.storyPlanId ?? provenanceRef,
    treatmentPlanId: provenanceRef,
    directorRunId: provenanceRef,
    fps: input.fps,
    durationFrames,
    sources: Object.freeze(input.sources.map((source) => Object.freeze({ ...source }))),
    videoTracks: Object.freeze([Object.freeze({
      id: 'track-base-video',
      kind: 'base-video' as const,
      clips: Object.freeze(input.clips.map((clip) => Object.freeze({ ...clip }))),
    })]),
    audioTimelineHash: createEditorialAudioTimelineHash({ fps: input.fps, clips: input.clips }),
    desiredActionRef,
    // No CTA overlay and no captions: neither compiler has copy to place, and an
    // empty overlay is the honest counterpart of a caption nobody wrote.
    overlayTracks: Object.freeze([]),
    subtitleTracks: Object.freeze([]),
    audioTracks: Object.freeze([]),
    effectTracks: Object.freeze([]),
    transitions,
    markers: Object.freeze((input.markers ?? []).map((marker) => Object.freeze({
      ...marker,
      ruleIds: Object.freeze([...marker.ruleIds]),
    }))),
    protectedElements: Object.freeze([]),
    localeVariantRefs: Object.freeze([]),
    formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze([...new Set([
      ...input.lineageRefs,
      `${input.derivedFrom.origin}:${input.derivedFrom.id}:${input.derivedFrom.hash}`,
    ])].sort()),
    editorial: Object.freeze({
      // Nothing was removed by a spoken-content rule: both compilers select
      // material rather than excluding phrases from it.
      commandType: 'source-ingest' as const,
      exclusions: Object.freeze([]),
      retainedSourceRanges: Object.freeze(
        (input.retainedSourceRanges ?? []).map((range) => Object.freeze({ ...range })),
      ),
    }),
    // No word was retimed. The empty list is the measurement; the id names the
    // absence rather than pointing at a transcript this plan never read.
    retimedTranscript: Object.freeze({ sourceTranscriptId: 'not-retimed', words: Object.freeze([]) }),
    movementPolicy: Object.freeze({
      automaticZoom: false as const,
      protectedOpeningFrames: Math.round(input.fps * 4),
    }),
    subtitlePolicy: Object.freeze({
      faceProtection: true as const,
      anchor: 'bottom' as const,
      maxCharactersPerBlock: SUBTITLE_MAX_CHARACTERS,
    }),
    composition: Object.freeze({
      layout: 'landscape-inset' as const,
      background: 'blurred-source' as const,
      foregroundScale: 1 as const,
      verticalPosition: 0.5 as const,
      faceSafeFallback: Object.freeze([0.14, 0.08, 0.72, 0.56] as const),
      subtitleSafeRegion: Object.freeze([0.08, 0.7, 0.84, 0.24] as const),
    }),
    director: Object.freeze({
      plannerVersion: RENDERABLE_PLAN_COMPILER_VERSION,
      decisions: Object.freeze([]),
      assumptions: Object.freeze([...new Set(input.assumptions)]),
    }),
    createdAt: input.createdAt,
  }
  return validateDirectedEditPlan(plan)
}

/**
 * The identity of a compiled plan: what it cuts, from what, in what order.
 *
 * Deliberately not the plan object's own hash of everything — `createdAt` and
 * the plan id would make the same cut hash differently on two days, and the
 * question this answers is "have we already compiled this exact cut from this
 * exact derivation".
 */
export function calculateRenderablePlanHash(plan: Readonly<DirectedEditPlan>): string {
  const clips = plan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  return calculateCanonicalHash({
    schemaVersion: 'renderable-edit-plan/v1',
    compilerVersion: RENDERABLE_PLAN_COMPILER_VERSION,
    id: plan.id,
    // In, because the same cut belonging to two project versions is two plans:
    // leaving it out let a recompile under a newer version replay the older
    // plan's row and hand back a plan pointing at a version nobody asked for.
    projectVersionId: plan.projectVersionId,
    storyPlanId: plan.storyPlanId,
    treatmentPlanId: plan.treatmentPlanId,
    directorRunId: plan.directorRunId,
    fps: Number(plan.fps.toFixed(6)),
    durationFrames: plan.durationFrames,
    audioTimelineHash: plan.audioTimelineHash,
    desiredActionHash: plan.desiredActionRef.actionHash,
    sources: plan.sources.map((source) => ({ ...source })),
    clips: clips.map((clip) => ({ ...clip })),
    transitions: plan.transitions.map((transition) => ({ ...transition })),
    markers: plan.markers.map((marker) => ({ ...marker, ruleIds: [...marker.ruleIds] })),
    lineageRefs: [...plan.lineageRefs],
    retainedSourceRanges: plan.editorial.retainedSourceRanges.map((range) => ({ ...range })),
  })
}
