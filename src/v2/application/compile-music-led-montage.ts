import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { compileMusicLedMontage, createMusicAnalysis, critiqueMusicMontage, type MusicAnalysisV1, type ProtectedSpeechRange } from '../domain/music-led-montage.ts'
import { assembleDirectedEditPlan, renderablePlanSnapshotOf } from './renderable-edit-plan.ts'
import type { MusicMontageRun, MusicMontageRunRepository } from './ports/music-led-montage.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'

export interface MusicMontageVisualSegment {
  readonly id: string
  readonly sourceId: string
  readonly sourceArtifactId: string
  readonly sourceRangeMs: readonly [number, number]
  /** Semantic duration before grid snapping; sourceRangeMs may include approved handles. */
  readonly preferredDurationMs: number
}

export function compileMusicLedMontageService(dependencies: { runs: MusicMontageRunRepository; authority: import('./ports/music-led-montage.ts').MusicMontagePlanningAuthority; clock?: () => Date }) {
  return async (input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    runId: string
    planId: string
    analysisId: string
    fps: number
    objective: StrategicObjectiveId
    locale: string
    market?: string
    sources: readonly Readonly<{ id: string; artifactId: string; durationSeconds: number }>[]
    visualSegments: readonly MusicMontageVisualSegment[]
    minimumConfidence?: number
    maximumSnapDistanceMs?: number
    minimumCutSpacingMs?: number
    maximumCutsPer10s?: number
    actorClientId: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{ run: MusicMontageRun; replayed: boolean }>> => {
    if (input.authenticationAudit.workspaceId !== input.workspaceId || input.authenticationAudit.clientId !== input.actorClientId) throw new DomainError('AUTH_INVALID', 'Music montage audit does not match its actor and workspace')
    const requestFingerprint = calculateCanonicalHash({
      workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId,
      analysisId: input.analysisId, fps: input.fps, objective: input.objective, locale: input.locale,
      market: input.market ?? null, sources: input.sources, visualSegments: input.visualSegments,
      minimumConfidence: input.minimumConfidence ?? null, maximumSnapDistanceMs: input.maximumSnapDistanceMs ?? null,
      minimumCutSpacingMs: input.minimumCutSpacingMs ?? null, maximumCutsPer10s: input.maximumCutsPer10s ?? null,
    })
    const replay = await dependencies.runs.findRequestReplay({ workspaceId: input.workspaceId, actorClientId: input.actorClientId, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey, requestFingerprint })
    if (replay) return Object.freeze({ run: replay, replayed: true })
    if (input.visualSegments.length === 0) throw new DomainError('INVALID_ARGUMENT', 'Music montage requires visual segments')
    const authority = await dependencies.authority.resolveCurrent({ workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, analysisId: input.analysisId, visualArtifactIds: [...new Set(input.visualSegments.map((segment) => segment.sourceArtifactId))], locale: input.locale, ...(input.market ? { market: input.market } : {}), at: (dependencies.clock ?? (() => new Date()))().toISOString() })
    const persistedAnalysis = authority.analysis
    if (authority.musicArtifactId !== persistedAnalysis.sourceArtifactId) throw new DomainError('PERSISTENCE_CONFLICT', 'Music analysis and authorized artifact identities differ')
    if (calculateCanonicalHash(authority.visualSources) !== calculateCanonicalHash(input.sources)) throw new DomainError('PERSISTENCE_CONFLICT', 'Visual montage sources are not the current authorized project assets')
    const requestedCuts = input.visualSegments.slice(0, -1).reduce<number[]>((cuts, segment) => {
      if (!Number.isFinite(segment.preferredDurationMs) || segment.preferredDurationMs <= 0 || segment.preferredDurationMs > segment.sourceRangeMs[1] - segment.sourceRangeMs[0]) throw new DomainError('INVALID_ARGUMENT', `Visual segment ${segment.id} has invalid approved handles`)
      cuts.push((cuts.at(-1) ?? 0) + segment.preferredDurationMs)
      return cuts
    }, [])
    const { schemaVersion: _schemaVersion, analysisHash: _analysisHash, ...analysisBody } = persistedAnalysis
    const rehydrated = createMusicAnalysis(analysisBody)
    if (rehydrated.analysisHash !== persistedAnalysis.analysisHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored music analysis hash is inconsistent')
    const protectedSpeechRanges: ProtectedSpeechRange[] = []
    let semanticTimelineStartMs = 0
    for (const segment of input.visualSegments) {
      // Clips play at rate 1. Approved sourceRange may include handles, so
      // scaling the whole handle range into preferredDuration moves words away
      // from their real cut boundary and can approve a cut through speech.
      const semanticSourceEndMs = segment.sourceRangeMs[0] + segment.preferredDurationMs
      for (const protectedRange of authority.protectedSpeechRanges) {
        if (protectedRange.sourceArtifactId !== segment.sourceArtifactId) continue
        const intersectionStart = Math.max(segment.sourceRangeMs[0], protectedRange.rangeMs[0])
        const intersectionEnd = Math.min(semanticSourceEndMs, protectedRange.rangeMs[1])
        if (intersectionEnd <= intersectionStart) continue
        protectedSpeechRanges.push(Object.freeze({ id: `${segment.id}:${protectedRange.id}`, reason: protectedRange.reason, rangeMs: Object.freeze([semanticTimelineStartMs + intersectionStart - segment.sourceRangeMs[0], semanticTimelineStartMs + intersectionEnd - segment.sourceRangeMs[0]] as [number, number]) }))
      }
      semanticTimelineStartMs += segment.preferredDurationMs
    }
    const montagePlan = compileMusicLedMontage({ analysis: persistedAnalysis, semanticCutCandidatesMs: requestedCuts, protectedSpeechRanges, minimumConfidence: input.minimumConfidence, maximumSnapDistanceMs: input.maximumSnapDistanceMs, fps: input.fps })
    const boundaries = [0, ...montagePlan.cutDecisions.map((decision) => decision.atMs)]
    const toFrame = (ms: number) => Math.round(ms * input.fps / 1000)
    const clips = input.visualSegments.map((segment, index) => {
      const timelineInFrame = toFrame(boundaries[index]!)
      const timelineOutMs = index < montagePlan.cutDecisions.length ? boundaries[index + 1]! : persistedAnalysis.durationMs
      const sourceInFrame = toFrame(segment.sourceRangeMs[0])
      const sourceOutFrame = sourceInFrame + (toFrame(timelineOutMs) - timelineInFrame)
      if (sourceOutFrame > toFrame(segment.sourceRangeMs[1])) throw new DomainError('INVALID_RENDER_INPUT', `Beat snap would extend visual segment ${segment.id} past its approved source range`)
      const sourceOutMs = sourceOutFrame * 1000 / input.fps
      const sourceInMs = sourceInFrame * 1000 / input.fps
      const truncated = authority.protectedSpeechRanges.find(range => range.sourceArtifactId === segment.sourceArtifactId && ((sourceOutMs > range.rangeMs[0] && sourceOutMs < range.rangeMs[1]) || (sourceInMs > range.rangeMs[0] && sourceInMs < range.rangeMs[1])))
      if (truncated) throw new DomainError('INVALID_RENDER_INPUT', `Beat snap would truncate protected ${truncated.reason} ${truncated.id} in visual segment ${segment.id}`)
      return Object.freeze({ id: segment.id, sourceArtifactId: segment.sourceArtifactId, sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame: toFrame(timelineOutMs), rate: 1 })
    })
    const editPlan = assembleDirectedEditPlan({ planId: input.planId, projectVersionId: input.projectVersionId, derivedFrom: { origin: 'music-led-montage', id: input.runId, hash: montagePlan.planHash }, objective: input.objective, fps: input.fps, sources: input.sources.map((source) => ({ ...source, kind: 'video' as const })), clips, seams: montagePlan.cutDecisions.map((decision) => ({ reason: decision.reason })), backgroundMusic: { id: `music-${input.runId}`, kind: 'background-music', artifactId: authority.musicArtifactId, analysisId: persistedAnalysis.id, analysisHash: persistedAnalysis.analysisHash, rightsSnapshotId: authority.rightsSnapshotId, sourceInFrame: 0, sourceOutFrame: toFrame(persistedAnalysis.durationMs), timelineInFrame: 0, timelineOutFrame: toFrame(persistedAnalysis.durationMs), gainDb: -18, fadeInFrames: Math.round(input.fps * .2), fadeOutFrames: Math.round(input.fps * .4) }, lineageRefs: [persistedAnalysis.analysisHash, authority.rightsSnapshotId], assumptions: [...persistedAnalysis.limitations, ...montagePlan.fallbackReasons], createdAt: (dependencies.clock ?? (() => new Date()))().toISOString() })
    const durationMs = Math.round(editPlan.durationFrames * 1000 / input.fps)
    const critic = critiqueMusicMontage({ plan: montagePlan, durationMs, minimumCutSpacingMs: input.minimumCutSpacingMs, maximumCutsPer10s: input.maximumCutsPer10s })
    if (!critic.eligibleForAutomaticRender) throw new DomainError('INVALID_RENDER_INPUT', 'Music montage crosses protected speech and cannot be rendered automatically', { issues: critic.issues })
    const createdAt = (dependencies.clock ?? (() => new Date()))().toISOString()
    const unhashed = Object.freeze({ id: input.runId, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, locale: input.locale, ...(input.market ? { market: input.market } : {}), rightsSnapshotId: authority.rightsSnapshotId, musicAnalysis: persistedAnalysis, montagePlan, editPlan, critic, createdAt })
    const run = Object.freeze({ ...unhashed, runHash: calculateCanonicalHash(unhashed) })
    const renderablePlan = renderablePlanSnapshotOf({ workspaceId: input.workspaceId, projectId: input.projectId, origin: 'music-led-montage', sourceId: input.runId, sourceHash: montagePlan.planHash, sourceVersion: 1, plan: editPlan })
    return dependencies.runs.saveWithRenderablePlan({ run, renderablePlan, requestFingerprint, idempotencyKey: input.idempotencyKey, actorClientId: input.actorClientId, authenticationAudit: input.authenticationAudit })
  }
}
