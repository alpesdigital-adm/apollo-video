import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { applyEditorialCutCommandService } from '@/v2/application/apply-editorial-cut-command'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderService } from '@/v2/application/enqueue-project-proxy-render'
import { runProjectDirectorService } from '@/v2/application/run-project-director'
import { DomainError } from '@/v2/domain/errors'
import {
  createDirectorRunRepository,
  createEditorialCommandRepository,
  createProjectProxyRenderRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface CommandBody {
  type?: unknown
  baseVersionId?: unknown
  baseHash?: unknown
  sourceTranscriptId?: unknown
  rules?: unknown
  reason?: unknown
  exclusionOverrides?: unknown
}

function parseRules(value: unknown) {
  if (!Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', 'rules must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new DomainError('INVALID_ARGUMENT', `rules[${index}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    if (Object.keys(record).some((key) => !['id', 'label', 'alternatives'].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', `rules[${index}] contains an unsupported field`)
    }
    if (
      typeof record.id !== 'string' ||
      typeof record.label !== 'string' ||
      !Array.isArray(record.alternatives) ||
      !record.alternatives.every((alternative) => typeof alternative === 'string')
    ) {
      throw new DomainError('INVALID_ARGUMENT', `rules[${index}] is invalid`)
    }
    return { id: record.id, label: record.label, alternatives: record.alternatives as string[] }
  })
}

function parseExclusionOverrides(value: unknown) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', 'exclusionOverrides must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new DomainError('INVALID_ARGUMENT', `exclusionOverrides[${index}] must be an object`)
    const record = entry as Record<string, unknown>
    if (Object.keys(record).some((key) => !['sourceStartSeconds', 'sourceEndSeconds', 'ruleIds', 'reason'].includes(key))) throw new DomainError('INVALID_ARGUMENT', `exclusionOverrides[${index}] contains an unsupported field`)
    if (typeof record.sourceStartSeconds !== 'number' || typeof record.sourceEndSeconds !== 'number' || !Array.isArray(record.ruleIds) || !record.ruleIds.every((id) => typeof id === 'string') || typeof record.reason !== 'string') throw new DomainError('INVALID_ARGUMENT', `exclusionOverrides[${index}] is invalid`)
    return { sourceStartSeconds: record.sourceStartSeconds, sourceEndSeconds: record.sourceEndSeconds, ruleIds: record.ruleIds as string[], reason: record.reason }
  })
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: CommandBody
    try {
      body = await request.json() as CommandBody
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    if (Object.keys(body).some((key) => !['type', 'baseVersionId', 'baseHash', 'sourceTranscriptId', 'rules', 'reason', 'exclusionOverrides'].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (typeof body.baseVersionId !== 'string' || typeof body.baseHash !== 'string') throw new DomainError('INVALID_ARGUMENT', 'baseVersionId and baseHash must be strings')
    if (body.reason !== undefined && typeof body.reason !== 'string') throw new DomainError('INVALID_ARGUMENT', 'reason must be a string')
    const { projectId } = await context.params
    if (body.type === 'run-director') {
      if (body.sourceTranscriptId !== undefined || body.rules !== undefined || body.exclusionOverrides !== undefined) {
        throw new DomainError('INVALID_ARGUMENT', 'run-director does not accept cut-rule fields')
      }
      const result = await runProjectDirectorService({
        repository: createDirectorRunRepository(),
        clock: () => new Date(),
        createId: (kind) => `${kind}-${randomUUID()}`,
        createEventId: randomUUID,
      })({
        workspaceId: actor.workspaceId,
        projectId,
        baseVersionId: body.baseVersionId,
        baseHash: body.baseHash,
        actor: { type: 'api-client', id: actor.clientId },
        idempotency: { key: idempotencyKey },
        ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
      })
      const proxy = await enqueueProjectProxyRenderService({
        projects: createProjectProxyRenderRepository(),
        operations: createPublicOperationRepository(),
        clock: () => new Date(),
        createId: (kind) => `${kind}-${randomUUID()}`,
      })({
        workspaceId: actor.workspaceId,
        projectId,
        actor: { type: 'api-client', id: actor.clientId },
        idempotencyKey: `${idempotencyKey}:proxy`,
      })
      const refs = result.command.payload.snapshotRefs
      return NextResponse.json(presentSuccess({
        command: {
          id: result.command.id,
          type: result.command.type,
          baseVersionId: result.command.baseVersionId,
          resultVersionId: result.version.id,
          createdAt: result.command.createdAt,
        },
        version: {
          id: result.version.id,
          sequence: result.version.sequence,
          parentVersionId: result.version.parentVersionId,
          baseHash: result.version.baseHash,
          snapshotRefs: { ...result.version.snapshotRefs, perception: refs.perception, quality: refs.quality },
          createdAt: result.version.createdAt,
        },
        directorRun: {
          id: result.run.id,
          status: result.run.status,
          plannerVersion: result.run.plannerVersion,
          criticVersion: result.run.criticVersion,
          baseVersionId: result.run.baseVersionId,
          resultVersionId: result.run.resultVersionId,
          perception: { snapshotId: refs.perception, summary: result.run.perception.summary },
          treatmentPlan: { snapshotId: refs.treatment, plan: result.run.treatmentPlan },
          storyPlan: { snapshotId: refs.story, plan: result.run.storyPlan },
          editPlan: {
            snapshotId: refs.editPlan,
            id: result.run.editPlan.id,
            durationFrames: result.run.editPlan.durationFrames,
            fps: result.run.editPlan.fps,
            subtitleCueCount: result.run.editPlan.subtitleTracks.reduce((total, track) => total + track.cues.length, 0),
            transitionCount: result.run.editPlan.transitions.length,
            automaticZoom: result.run.editPlan.movementPolicy.automaticZoom,
          },
          qualityReport: { snapshotId: refs.quality, report: result.run.qualityReport },
          decisions: result.run.decisions,
          assumptions: result.run.assumptions,
          createdAt: result.run.createdAt,
        },
        operation: presentPublicOperation(proxy.operation),
        replayed: result.replayed && proxy.replayed,
      }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
    }
    if (body.type !== 'remove-spoken-content') throw new DomainError('INVALID_ARGUMENT', 'type must be remove-spoken-content or run-director')
    if (typeof body.sourceTranscriptId !== 'string') throw new DomainError('INVALID_ARGUMENT', 'sourceTranscriptId must be a string')
    const exclusionOverrides = parseExclusionOverrides(body.exclusionOverrides)
    const result = await applyEditorialCutCommandService({
      repository: createEditorialCommandRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      sourceTranscriptId: body.sourceTranscriptId,
      rules: parseRules(body.rules),
      ...(exclusionOverrides ? { exclusionOverrides } : {}),
      ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
      actor: { type: 'api-client', id: actor.clientId },
      idempotency: { clientId: actor.clientId, key: idempotencyKey },
    })
    return NextResponse.json(
      presentSuccess({
        command: {
          id: result.command.id,
          type: result.command.type,
          baseVersionId: result.command.baseVersionId,
          resultVersionId: result.version.id,
          createdAt: result.command.createdAt,
        },
        version: {
          id: result.version.id,
          sequence: result.version.sequence,
          parentVersionId: result.version.parentVersionId,
          baseHash: result.version.baseHash,
          snapshotRefs: result.version.snapshotRefs,
          createdAt: result.version.createdAt,
        },
        editorial: {
          sourceTranscriptId: result.editPlan.retimedTranscript.sourceTranscriptId,
          sourceArtifactId: result.editPlan.sources[0]!.artifactId,
          exclusions: result.exclusions,
          retainedSourceRanges: result.retainedSourceRanges,
          outputDurationFrames: result.editPlan.durationFrames,
          fps: result.editPlan.fps,
          automaticZoom: result.editPlan.movementPolicy.automaticZoom,
          protectedOpeningFrames: result.editPlan.movementPolicy.protectedOpeningFrames,
          subtitleFaceProtection: result.editPlan.subtitlePolicy.faceProtection,
        },
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
