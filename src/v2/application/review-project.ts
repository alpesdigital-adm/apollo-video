import { calculateVersionHash } from './version-hash.ts'
import type {
  PersistedReviewAnnotation,
  ReviewAnnotationRepository,
} from './ports/review-annotation-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  createReviewAnnotation,
  resolveReviewScope,
  type ReviewAnnotationScope,
  type ReviewScope,
  type ReviewScopeKind,
} from '../domain/review-system.ts'

const SCREENSHOT_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/

export function readProjectReviewService(dependencies: {
  repository: ReviewAnnotationRepository
}) {
  return async function read(input: { workspaceId: string; projectId: string; projectVersionId?: string; limit?: number }) {
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    const limit = input.limit ?? 50
    assertDomain(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workspaceId) &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(projectId) &&
        (input.projectVersionId === undefined || /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.projectVersionId.trim())) &&
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'Review query is invalid',
    )
    const context = await dependencies.repository.readPreviewContext({
      workspaceId,
      projectId,
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId.trim() } : {}),
    })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project review context was not found')
    const annotations = await dependencies.repository.list({
      workspaceId,
      projectId,
      projectVersionId: context.projectVersionId,
      limit,
    })
    return Object.freeze({
      session: Object.freeze({
        currentProjectVersionId: context.currentProjectVersionId,
        projectVersionId: context.projectVersionId,
        proxyArtifactId: context.proxyArtifactId,
        proxyUrl: `/v1/artifacts/${encodeURIComponent(context.proxyArtifactId)}/content`,
        proxyHash: context.proxyHash,
        fps: context.fps,
        resolution: Object.freeze({ width: context.width, height: context.height }),
        durationFrames: context.durationFrames,
        stale: context.stale,
      }),
      versions: Object.freeze(context.versions.map((version) => Object.freeze({ ...version }))),
      scopeContext: Object.freeze({
        formatId: context.formatId,
        localeId: context.localeId,
        recipeIds: Object.freeze([...context.recipeIds]),
        options: Object.freeze(Object.entries(context.availableScopeCounts).map(([kind, affectedCount]) => Object.freeze({
          kind: kind as ReviewScopeKind,
          affectedCount,
          enabled: affectedCount > 0,
        }))),
      }),
      scenes: Object.freeze(context.scenes.map((scene) => Object.freeze({ ...scene }))),
      annotations: Object.freeze(annotations),
    })
  }
}

export function createProjectReviewAnnotationService(dependencies: {
  repository: ReviewAnnotationRepository
  clock: () => Date
  createId: () => string
}) {
  return async function create(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyArtifactId: string
    proxyHash: string
    frame: number
    timeRangeMs: readonly [number, number]
    scope: ReviewAnnotationScope
    region?: { x: number; y: number; width: number; height: number }
    targetIds: readonly string[]
    applicationScope?: Partial<ReviewScope>
    confirmedGlobal?: boolean
    screenshotRef: string
    text: string
    author: { id: string; name: string; type: 'user' | 'api-client' }
    idempotencyKey: string
  }) {
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    const idempotencyKey = input.idempotencyKey.trim()
    assertDomain(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workspaceId) &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(projectId) &&
        idempotencyKey.length >= 8 && idempotencyKey.length <= 128,
      'INVALID_ARGUMENT',
      'Review annotation identity is invalid',
    )
    assertDomain(
      input.screenshotRef.length <= 750_000 && SCREENSHOT_PATTERN.test(input.screenshotRef),
      'INVALID_ARGUMENT',
      'Review screenshot must be a bounded JPEG or PNG data URL',
    )
    const context = await dependencies.repository.readPreviewContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project review context was not found')
    if (
      context.stale || context.projectVersionId !== input.projectVersionId ||
      context.proxyArtifactId !== input.proxyArtifactId || context.proxyHash !== input.proxyHash
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Review annotation targets a stale project preview', {
        currentVersionId: context.projectVersionId,
        currentProxyArtifactId: context.proxyArtifactId,
        stale: context.stale,
      })
    }
    assertDomain(
      input.frame < context.durationFrames && input.timeRangeMs[1] <= Math.ceil(context.durationFrames / context.fps * 1000),
      'INVALID_ARGUMENT',
      'Review annotation is outside the preview duration',
    )
    const expectedTimeMs = Math.round(input.frame / context.fps * 1000)
    assertDomain(
      Math.abs(input.timeRangeMs[0] - expectedTimeMs) <= Math.ceil(1000 / context.fps) + 1 || input.scope === 'scene',
      'INVALID_ARGUMENT',
      'Review frame and timecode do not identify the same preview moment',
    )
    if (input.scope === 'scene') {
      const scene = context.scenes.find((candidate) => candidate.id === input.targetIds[0])
      assertDomain(Boolean(scene), 'INVALID_ARGUMENT', 'Review scene target does not exist in the active version')
      assertDomain(
        input.timeRangeMs[0] === Math.round(scene!.startFrame / context.fps * 1000) &&
          input.timeRangeMs[1] === Math.round(scene!.endFrame / context.fps * 1000),
        'INVALID_ARGUMENT',
        'Review scene range does not match the active version',
      )
    }
    const currentScene = context.scenes.find((candidate) => input.frame >= candidate.startFrame && input.frame < candidate.endFrame)
    const applicationKind = input.applicationScope?.kind ?? (currentScene ? 'scene' : input.scope === 'region' ? 'region' : 'frame')
    if (applicationKind === 'region') assertDomain(Boolean(input.region), 'INVALID_SCOPE', 'Region application scope requires marked bounds')
    if (applicationKind === 'range') {
      assertDomain(input.timeRangeMs[1] > input.timeRangeMs[0], 'INVALID_SCOPE', 'Range application scope requires a non-empty time range')
    }
    if (applicationKind === 'scene' || applicationKind === 'clip') {
      assertDomain(Boolean(currentScene), 'INVALID_SCOPE', `Review ${applicationKind} scope requires a scene at the annotated frame`)
    }
    const currentTargetId = applicationKind === 'frame'
      ? `frame:${input.frame}`
      : applicationKind === 'region'
        ? `region:${input.frame}`
        : applicationKind === 'clip'
          ? `clip:${currentScene!.id.replace(/^scene:/, '')}`
          : applicationKind === 'scene'
            ? currentScene!.id
            : applicationKind === 'range'
              ? `range:${input.timeRangeMs[0]}-${input.timeRangeMs[1]}`
              : applicationKind === 'project'
                ? `project:${projectId}`
                : applicationKind === 'formats'
                  ? `format:${context.formatId}`
                  : applicationKind === 'locales'
                    ? `locale:${context.localeId}`
                    : `recipe:${context.recipeIds[0] ?? ''}`
    const requestedScope = input.applicationScope ? { ...input.applicationScope, kind: applicationKind } : { kind: applicationKind }
    if (requestedScope.global) {
      const allowed = {
        formatIds: [context.formatId],
        localeIds: [context.localeId],
        recipeIds: [...context.recipeIds],
      }
      for (const field of ['formatIds', 'localeIds', 'recipeIds'] as const) {
        assertDomain(
          !requestedScope[field]?.some((id) => !allowed[field].includes(id)),
          'INVALID_SCOPE',
          `Global review scope contains an unavailable ${field}`,
        )
      }
    }
    const resolvedScope = resolveReviewScope({
      requested: requestedScope,
      current: {
        targetId: currentTargetId,
        formatId: context.formatId,
        localeId: context.localeId,
        ...(context.recipeIds[0] ? { recipeId: context.recipeIds[0] } : {}),
      },
      availableCounts: context.availableScopeCounts,
      confirmedGlobal: input.confirmedGlobal,
    })
    const requestFingerprint = calculateVersionHash({
      workspaceId,
      projectId,
      projectVersionId: input.projectVersionId,
      proxyArtifactId: input.proxyArtifactId,
      proxyHash: input.proxyHash,
      frame: input.frame,
      timeRangeMs: input.timeRangeMs,
      scope: input.scope,
      region: input.region ?? null,
      targetIds: [...input.targetIds],
      applicationScope: resolvedScope.scope,
      affectedCount: resolvedScope.affectedCount,
      screenshotHash: calculateVersionHash(input.screenshotRef),
      text: input.text.trim(),
      author: input.author,
    })
    const existing = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with different annotation input')
      }
      return Object.freeze({ annotation: existing.annotation, replayed: true })
    }
    const createdAt = dependencies.clock().toISOString()
    const annotation = createReviewAnnotation({
      id: dependencies.createId(),
      projectVersionId: input.projectVersionId,
      proxyArtifactId: input.proxyArtifactId,
      proxyHash: input.proxyHash,
      frame: input.frame,
      timeRangeMs: input.timeRangeMs,
      screenshotRef: input.screenshotRef,
      scope: input.scope,
      ...(input.region ? { region: input.region } : {}),
      targetIds: input.targetIds,
      applicationScope: resolvedScope.scope,
      affectedCount: resolvedScope.affectedCount,
      text: input.text,
      author: input.author,
      status: 'open',
      createdAt,
    }) as PersistedReviewAnnotation
    const persisted = await dependencies.repository.create({
      workspaceId,
      projectId,
      annotation,
      idempotencyKey,
      requestFingerprint,
    })
    return Object.freeze({ annotation: persisted, replayed: false })
  }
}
