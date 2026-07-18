import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { applyEditorialCutCommandService } from '@/v2/application/apply-editorial-cut-command'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createEditorialCommandRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface CommandBody {
  type?: unknown
  baseVersionId?: unknown
  baseHash?: unknown
  sourceTranscriptId?: unknown
  rules?: unknown
  reason?: unknown
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
    if (Object.keys(body).some((key) => !['type', 'baseVersionId', 'baseHash', 'sourceTranscriptId', 'rules', 'reason'].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (body.type !== 'remove-spoken-content') throw new DomainError('INVALID_ARGUMENT', 'type must be remove-spoken-content')
    if (typeof body.baseVersionId !== 'string' || typeof body.baseHash !== 'string' || typeof body.sourceTranscriptId !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'baseVersionId, baseHash and sourceTranscriptId must be strings')
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') throw new DomainError('INVALID_ARGUMENT', 'reason must be a string')
    const { projectId } = await context.params
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
