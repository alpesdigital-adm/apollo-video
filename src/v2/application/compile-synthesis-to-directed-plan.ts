import type { DirectedEditPlan } from '../domain/director-run.ts'
import {
  type EditorialSynthesis,
  type SynthesisJoin,
} from '../domain/editorial-synthesis.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type { DesiredActionInput } from '../domain/desired-action.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'
import type { EditorialCutClip } from './apply-editorial-cut-command.ts'
import type { EditorialSynthesisRepository } from './ports/editorial-synthesis-repository.ts'
import type { RenderSourceRepository } from './ports/render-source-repository.ts'
import type {
  RenderablePlanSnapshotRepository,
  StoredRenderablePlanSnapshot,
} from './ports/renderable-plan-snapshot-repository.ts'
import {
  assembleDirectedEditPlan,
  calculateRenderablePlanHash,
  type RenderablePlanMarker,
  type RenderablePlanSeam,
  type RenderablePlanSource,
} from './renderable-edit-plan.ts'

/**
 * The bridge from a multi-range synthesis to something that renders
 * (F4.016 condition 6).
 *
 * `EditorialSynthesisEditPlan` (`editorial-synthesis.ts:121`) is a *selection*:
 * exact rational frame rate, contiguous clips, lineage per range, and nothing
 * else. It has no `rate`, no transitions, no composition and no audio timeline
 * hash, so no renderer in this repository accepts it — which is why the
 * two-hour-to-two-minute journey could be created, hashed, stored and never
 * turned into a file.
 *
 * Nothing about the cut is decided here. The ranges, their order and the
 * justification for every splice were settled by `createEditorialSynthesis` and
 * are carried through unchanged; this module adds only what the render path
 * demands and refuses anything that would change what the synthesis asserts.
 */

/**
 * One master the ranges were cut from, as the server measured it.
 *
 * Never assembled by a caller in the service path: `compileSynthesisRenderPlanService`
 * resolves every `range.lineage.sourceArtifactId` through `RenderSourceRepository`
 * and builds these itself. The type stays exported because the pure compiler
 * below is also driven directly by the FFmpeg golden, which measures the file it
 * just wrote with ffprobe — that is a server measurement too, taken by the only
 * process that can take it there.
 */
export interface SynthesisRenderSource {
  readonly artifactId: string
  /** The bytes the ranges were selected from. Checked, not trusted. */
  readonly sha256: string
  /** Measured on the file by the server. Never derived from the timeline. */
  readonly durationSeconds: number
}

export interface CompileSynthesisOptions {
  readonly sources: readonly Readonly<SynthesisRenderSource>[]
  readonly projectVersionId: string
  readonly objective: StrategicObjectiveId
  readonly desiredAction?: Readonly<DesiredActionInput>
  readonly createdAt: string
}

/**
 * Compile a stored synthesis into a renderable `DirectedEditPlan`.
 *
 * Two properties are proved rather than assumed:
 *
 * - **Every range survives, once, in output order.** A compiler that dropped a
 *   range would drop the qualifier that makes a claim honest — the exact
 *   failure `assertClaimContextPreserved` exists to prevent — and the plan
 *   would still render cleanly. So the clips are matched against the ranges
 *   one for one, in order, and a mismatch is refused.
 * - **The bytes are the bytes the selection was made from.** A source whose
 *   sha256 no longer matches the range's lineage is not the same footage; a
 *   frame number means something else in it, and rendering would quote a
 *   sentence nobody said.
 */
export function compileSynthesisToDirectedPlan(
  synthesis: Readonly<EditorialSynthesis>,
  options: CompileSynthesisOptions,
): Readonly<DirectedEditPlan> {
  const track = synthesis.editPlan.videoTracks.find((entry) => entry.kind === 'base-video')
  assertDomain(
    track !== undefined && track.clips.length > 0,
    'INVALID_RENDER_INPUT',
    `synthesis ${synthesis.id} carries no base video track to render`,
  )
  const clips = track!.clips
  assertDomain(
    clips.length === synthesis.ranges.length,
    'INVALID_RENDER_INPUT',
    `synthesis ${synthesis.id} selected ${synthesis.ranges.length} ranges and compiled ${clips.length} clips`,
  )

  const fps = Number(synthesis.editPlan.frameRate.num) / Number(synthesis.editPlan.frameRate.den)
  const frameMs = 1_000 / fps

  const byArtifact = new Map(options.sources.map((source) => [source.artifactId, source]))
  const shaByArtifact = new Map<string, string>()
  const lastReadMsByArtifact = new Map<string, number>()
  for (const range of synthesis.ranges) {
    const previous = shaByArtifact.get(range.lineage.sourceArtifactId)
    // Two ranges of the same artifact naming two digests is a corrupted
    // aggregate, not a choice this compiler gets to make.
    assertDomain(
      previous === undefined || previous === range.lineage.sourceArtifactSha256,
      'PERSISTENCE_CONFLICT',
      `synthesis ${synthesis.id} names two different digests for artifact ${range.lineage.sourceArtifactId}`,
    )
    shaByArtifact.set(range.lineage.sourceArtifactId, range.lineage.sourceArtifactSha256)
    lastReadMsByArtifact.set(
      range.lineage.sourceArtifactId,
      Math.max(lastReadMsByArtifact.get(range.lineage.sourceArtifactId) ?? 0, range.endMs),
    )
  }

  const sources: RenderablePlanSource[] = []
  for (const [artifactId, sha256] of shaByArtifact) {
    const resolved = byArtifact.get(artifactId)
    if (!resolved) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        `synthesis ${synthesis.id} reads from artifact ${artifactId}, which was not resolved`,
        { artifactId },
      )
    }
    if (resolved.sha256 !== sha256) {
      throw new DomainError(
        'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
        `artifact ${artifactId} no longer holds the bytes the synthesis ranges were selected from`,
        { artifactId, selectedSha256: sha256, currentSha256: resolved.sha256 },
      )
    }
    assertDomain(
      Number.isFinite(resolved.durationSeconds) && resolved.durationSeconds > 0,
      'INVALID_RENDER_INPUT',
      `artifact ${artifactId} has no measured duration`,
    )
    // A measurement that is only checked for being a positive number is not
    // checked. Two things make it falsifiable: the file has to be long enough
    // for the ranges the synthesis cut out of it, and — where the whole cut
    // comes from one master — it has to be the master the aggregate declared it
    // measured. Without these, a plan could declare a five-second source while
    // its clips read to the two-hour mark of it, and every later reader would
    // take the five seconds as the provenance of the cut.
    const measuredMs = resolved.durationSeconds * 1_000
    const lastReadMs = lastReadMsByArtifact.get(artifactId) ?? 0
    assertDomain(
      measuredMs + frameMs >= lastReadMs,
      'INVALID_RENDER_INPUT',
      `artifact ${artifactId} measures ${measuredMs.toFixed(0)} ms and synthesis ${synthesis.id} reads to ${lastReadMs} ms of it`,
      { artifactId, measuredMs, lastReadMs },
    )
    if (shaByArtifact.size === 1) {
      assertDomain(
        Math.abs(measuredMs - synthesis.sourceDurationMs) <= frameMs,
        'INVALID_RENDER_INPUT',
        `artifact ${artifactId} measures ${measuredMs.toFixed(0)} ms and synthesis ${synthesis.id} was selected from a master of ${synthesis.sourceDurationMs} ms`,
        { artifactId, measuredMs, declaredMs: synthesis.sourceDurationMs },
      )
    }
    sources.push({
      id: `source-${artifactId}`,
      artifactId,
      kind: 'video' as const,
      durationSeconds: resolved.durationSeconds,
    })
  }

  const cutClips: EditorialCutClip[] = clips.map((clip, index) => {
    const range = synthesis.ranges[index]!
    assertDomain(
      clip.rangeId === range.rangeId,
      'INVALID_RENDER_INPUT',
      `clip ${index} compiles range ${clip.rangeId} where the synthesis put ${range.rangeId}; the output order is part of what the cut asserts`,
    )
    return {
      id: clip.clipId,
      sourceArtifactId: clip.sourceArtifactId,
      sourceInFrame: clip.sourceInFrame,
      sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame,
      timelineOutFrame: clip.timelineOutFrame,
      // A synthesis selects; it never retimes. Anything but 1 here would make
      // the words come out at a speed the speaker did not use.
      rate: 1,
    }
  })

  const seams: RenderablePlanSeam[] = synthesis.joins.map((join) => ({
    reason: seamReason(join),
  }))
  // Only splices get a marker. A contiguous join drops nothing, and a marker
  // over a zero-length source span would put a review flag where there is
  // nothing to review.
  const markers: RenderablePlanMarker[] = synthesis.joins
    .filter((join) => join.kind === 'spliced')
    .map((join) => {
      const before = synthesis.ranges.find((range) => range.rangeId === join.beforeRangeId)!
      const after = synthesis.ranges.find((range) => range.rangeId === join.afterRangeId)!
      // Refused, not defaulted to zero. Frame 0 is a legitimate position — it is
      // the first clip's `timelineInFrame` — so a lookup that missed would be
      // indistinguishable from a marker on the opening frame, and this document
      // is an audit artifact: a reviewer would be sent to the wrong instant with
      // nothing saying so. It is unreachable today only because
      // `editorial-synthesis.ts` happens to mint clip ids as `clip-<rangeId>`.
      const atClip = cutClips.find((clip) => clip.id === `clip-${join.afterRangeId}`)
      if (!atClip) {
        throw new DomainError(
          'INVALID_RENDER_INPUT',
          `synthesis ${synthesis.id} splices before range ${join.afterRangeId}, which compiled to no clip`,
          { joinAfterRangeId: join.afterRangeId, clipIds: cutClips.map((clip) => clip.id) },
        )
      }
      return {
        kind: 'editorial-cut' as const,
        atFrame: atClip.timelineInFrame,
        // The span that was dropped, in the source's own seconds: what an
        // editor has to listen to before defending the join.
        sourceStartSeconds: before.endMs / 1_000,
        sourceEndSeconds: after.startMs / 1_000,
        ruleIds: Object.freeze([
          'synthesis:spliced',
          ...join.continuityRisks.map((risk) => `continuity:${risk}`),
        ]),
      }
    })

  return assembleDirectedEditPlan({
    planId: `${synthesis.editPlan.id}:directed`,
    projectVersionId: options.projectVersionId,
    derivedFrom: {
      origin: 'multi-range-synthesis',
      id: synthesis.id,
      hash: synthesis.synthesisHash,
    },
    // A real StoryPlan: the synthesis was checked against this one's claims.
    storyPlanId: synthesis.storyPlan.id,
    objective: options.objective,
    ...(options.desiredAction ? { desiredAction: options.desiredAction } : {}),
    fps,
    sources,
    clips: cutClips,
    seams,
    markers,
    retainedSourceRanges: synthesis.ranges.map((range) => ({
      sourceStartSeconds: range.startMs / 1_000,
      sourceEndSeconds: range.endMs / 1_000,
    })),
    lineageRefs: [
      ...synthesis.editPlan.lineageRefs,
      `synthesis:${synthesis.id}`,
      `story-plan:${synthesis.storyPlan.id}`,
    ],
    assumptions: [
      `The cut keeps ${synthesis.ranges.length} ranges of the master in output order; ${synthesis.droppedMs} ms were left on the floor.`,
      synthesis.chronologyPreserved
        ? 'The ranges run in source order, so the material asserts the same causes it did in the master.'
        : `The ranges depart from source order: ${synthesis.reorderReason ?? 'declared without a reason'}.`,
      'Materialization is cut-only: this path has no freeze, no picture-in-picture and no retime.',
    ],
    createdAt: options.createdAt,
  })
}

function seamReason(join: Readonly<SynthesisJoin>): string {
  if (join.kind === 'contiguous') {
    return 'Contiguous in the source: the next range begins on the millisecond the previous one ended.'
  }
  const risks = join.continuityRisks.length > 0
    ? ` Continuity risks: ${[...join.continuityRisks].sort().join(', ')}.`
    : ''
  return `Spliced over ${join.droppedMs} ms of dropped source. ${join.justification}${risks}`
}

/**
 * Compile a stored synthesis and keep the result.
 *
 * The snapshot is what makes the bridge auditable: it names the synthesis, the
 * synthesis hash it was compiled from, and the hash of the cut it produced. A
 * synthesis that later moves leaves its snapshot naming a hash nothing matches,
 * which is how a reader learns the plan is stale instead of rendering it.
 *
 * Recompiling the same synthesis is a replay: the same bytes under the same
 * key, returned without a second write.
 *
 * The caller brings ids and nothing else. It used to hand over the sources —
 * their artifact ids, their digests and their durations — which made the
 * identity check above ceremonial: "the bytes are the bytes the selection was
 * made from" compared the caller's digest against the aggregate's, so anyone who
 * could read the lineage could satisfy it by quoting it back. The sources are
 * now resolved from the project's own media-asset links, which is both where the
 * measurements live and the lookup the renderer performs.
 */
export function compileSynthesisRenderPlanService(dependencies: {
  syntheses: EditorialSynthesisRepository
  sources: RenderSourceRepository
  snapshots: RenderablePlanSnapshotRepository
  clock: () => Date
}) {
  return async (input: {
    workspaceId: string
    projectId: string
    synthesisId: string
    projectVersionId: string
    objective: StrategicObjectiveId
    desiredAction?: Readonly<DesiredActionInput>
  }): Promise<Readonly<{
    plan: Readonly<DirectedEditPlan>
    planHash: string
    replayed: boolean
    /**
     * The stored row, as the repository read it back. Carried out of the
     * service so the published surface presents what PostgreSQL holds rather
     * than a projection a route composed beside it.
     */
    snapshot: Readonly<StoredRenderablePlanSnapshot>
  }>> => {
    const stored = await dependencies.syntheses.read({
      workspaceId: input.workspaceId,
      synthesisId: input.synthesisId,
    })
    if (!stored) {
      throw new DomainError(
        'EDITORIAL_SYNTHESIS_NOT_FOUND',
        `Editorial synthesis ${input.synthesisId} does not exist`,
      )
    }
    assertDomain(
      stored.synthesis.projectId === input.projectId,
      'INVALID_ARGUMENT',
      `Editorial synthesis ${input.synthesisId} belongs to project ${stored.synthesis.projectId}`,
    )
    const artifactIds = [...new Set(
      stored.synthesis.ranges.map((range) => range.lineage.sourceArtifactId),
    )]
    const resolved = await dependencies.sources.resolveForProject({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      artifactIds,
    })
    const byArtifactId = new Map(resolved.map((source) => [source.artifactId, source] as const))
    const sources: SynthesisRenderSource[] = artifactIds.map((artifactId) => {
      const source = byArtifactId.get(artifactId)
      if (!source) {
        throw new DomainError(
          'MEDIA_ARTIFACT_NOT_FOUND',
          `synthesis ${input.synthesisId} reads from artifact ${artifactId}, which project ${input.projectId} cannot render from`,
          { artifactId, projectId: input.projectId },
        )
      }
      assertDomain(
        source.durationSeconds !== null,
        'INVALID_RENDER_INPUT',
        `artifact ${artifactId} carries no measured duration; a plan cannot declare a source nobody probed`,
        { artifactId },
      )
      return {
        artifactId: source.artifactId,
        sha256: source.sha256,
        durationSeconds: source.durationSeconds,
      }
    })

    const createdAt = dependencies.clock().toISOString()
    const plan = compileSynthesisToDirectedPlan(stored.synthesis, {
      sources,
      projectVersionId: input.projectVersionId,
      objective: input.objective,
      ...(input.desiredAction ? { desiredAction: input.desiredAction } : {}),
      createdAt,
    })
    const persisted = await dependencies.snapshots.persist({
      snapshot: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        planId: plan.id,
        origin: 'multi-range-synthesis',
        sourceId: stored.synthesis.id,
        sourceHash: stored.synthesis.synthesisHash,
        sourceVersion: null,
        fps: plan.fps,
        durationFrames: plan.durationFrames,
        clipCount: plan.videoTracks[0]?.clips.length ?? 0,
        plan,
        planHash: calculateRenderablePlanHash(plan),
      },
      createdAt,
    })
    return Object.freeze({
      plan: persisted.snapshot.plan,
      planHash: persisted.snapshot.planHash,
      replayed: persisted.replayed,
      snapshot: persisted.snapshot,
    })
  }
}
