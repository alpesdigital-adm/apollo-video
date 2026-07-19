import { calculateVersionHash } from './version-hash.ts'
import type {
  PersistedReviewAnnotation,
  ReviewAnnotationRepository,
} from './ports/review-annotation-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  createReviewAnnotation,
  type ReviewAnnotationScope,
} from '../domain/review-system.ts'

const SCREENSHOT_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/

export function readProjectReviewService(dependencies: {
  repository: ReviewAnnotationRepository
}) {
  return async function read(input: { workspaceId: string; projectId: string; limit?: number }) {
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    const limit = input.limit ?? 50
    assertDomain(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workspaceId) &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(projectId) &&
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'Review query is invalid',
    )
    const context = await dependencies.repository.readPreviewContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project review context was not found')
    const annotations = await dependencies.repository.list({
      workspaceId,
      projectId,
      projectVersionId: context.projectVersionId,
      limit,
    })
    return Object.freeze({
      session: Object.freeze({
        projectVersionId: context.projectVersionId,
        proxyArtifactId: context.proxyArtifactId,
        proxyUrl: `/v1/artifacts/${encodeURIComponent(context.proxyArtifactId)}/content`,
        proxyHash: context.proxyHash,
        fps: context.fps,
        resolution: Object.freeze({ width: context.width, height: context.height }),
        durationFrames: context.durationFrames,
        stale: context.stale,
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
