import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderService } from '@/v2/application/enqueue-project-proxy-render'
import { applyManualEditService } from '@/v2/application/manual-edit'
import { DomainError } from '@/v2/domain/errors'
import type {
  ManualGesture,
  ManualCropRegion,
  ManualInspectorPatch,
} from '@/v2/domain/manual-editing'
import {
  createColorPipelineCompilationRepository,
  createManualEditRepository,
  createProjectProxyRenderRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentProjectVersionV2,
  presentPublicOperation,
  presentSuccess,
} from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface ManualEditBody {
  action?: unknown
  baseVersionId?: unknown
  baseHash?: unknown
  expectedRevision?: unknown
  variantId?: unknown
  targetId?: unknown
  operation?: unknown
  targetVersionId?: unknown
  reason?: unknown
}

function strictRecord(
  value: unknown,
  field: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains an unsupported field`)
  }
  return record
}

function parseOperation(value: unknown): ManualGesture | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'operation must be an object')
  }
  const base = value as Record<string, unknown>
  if (typeof base.kind !== 'string' || typeof base.clipId !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', 'operation kind and clipId are required')
  }
  if (base.kind === 'select') {
    strictRecord(value, 'operation', ['kind', 'clipId'])
    return { kind: 'select', clipId: base.clipId }
  }
  if (base.kind === 'trim') {
    strictRecord(value, 'operation', ['kind', 'clipId', 'edge', 'atMs'])
    if (
      !['start', 'end'].includes(String(base.edge)) ||
      typeof base.atMs !== 'number'
    ) throw new DomainError('INVALID_ARGUMENT', 'trim operation is invalid')
    return {
      kind: 'trim',
      clipId: base.clipId,
      edge: base.edge as 'start' | 'end',
      atMs: base.atMs,
    }
  }
  if (base.kind === 'split') {
    strictRecord(value, 'operation', ['kind', 'clipId', 'atMs'])
    if (typeof base.atMs !== 'number') {
      throw new DomainError('INVALID_ARGUMENT', 'split operation is invalid')
    }
    return { kind: 'split', clipId: base.clipId, atMs: base.atMs }
  }
  if (base.kind === 'move') {
    strictRecord(value, 'operation', ['kind', 'clipId', 'startMs', 'track'])
    if (typeof base.startMs !== 'number' || typeof base.track !== 'number') {
      throw new DomainError('INVALID_ARGUMENT', 'move operation is invalid')
    }
    return {
      kind: 'move',
      clipId: base.clipId,
      startMs: base.startMs,
      track: base.track,
    }
  }
  if (base.kind === 'replace') {
    strictRecord(value, 'operation', ['kind', 'clipId', 'sourceId'])
    if (typeof base.sourceId !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'replace operation is invalid')
    }
    return { kind: 'replace', clipId: base.clipId, sourceId: base.sourceId }
  }
  if (base.kind === 'crop') {
    strictRecord(value, 'operation', ['kind', 'clipId', 'crop'])
    const crop = strictRecord(base.crop, 'operation.crop', [
      'x', 'y', 'width', 'height',
    ])
    if (!['x', 'y', 'width', 'height'].every((field) =>
      typeof crop[field] === 'number')) {
      throw new DomainError('INVALID_ARGUMENT', 'crop operation is invalid')
    }
    return {
      kind: 'crop',
      clipId: base.clipId,
      crop: {
        x: crop.x as number,
        y: crop.y as number,
        width: crop.width as number,
        height: crop.height as number,
      } satisfies ManualCropRegion,
    }
  }
  if (base.kind === 'inspect') {
    strictRecord(value, 'operation', ['kind', 'clipId', 'patch'])
    const patch = strictRecord(base.patch, 'operation.patch', [
      'layout', 'text', 'subtitle', 'color', 'motion', 'audioGain',
    ]) as ManualInspectorPatch
    return { kind: 'inspect', clipId: base.clipId, patch }
  }
  throw new DomainError('INVALID_ARGUMENT', 'operation kind is unsupported')
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
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = strictRecord(rawBody, 'Request body', [
      'action', 'baseVersionId', 'baseHash', 'expectedRevision', 'variantId',
      'targetId', 'operation', 'targetVersionId', 'reason',
    ]) as ManualEditBody
    if (
      !['apply', 'undo', 'redo', 'restore'].includes(String(body.action)) ||
      typeof body.baseVersionId !== 'string' ||
      typeof body.baseHash !== 'string' ||
      typeof body.expectedRevision !== 'number' ||
      typeof body.variantId !== 'string' ||
      typeof body.targetId !== 'string' ||
      (body.targetVersionId !== undefined && typeof body.targetVersionId !== 'string') ||
      (body.reason !== undefined && typeof body.reason !== 'string')
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'Manual edit request is invalid')
    }
    const { projectId } = await context.params
    const result = await applyManualEditService({
      repository: createManualEditRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      expectedRevision: body.expectedRevision,
      action: body.action as 'apply' | 'undo' | 'redo' | 'restore',
      variantId: body.variantId,
      targetId: body.targetId,
      ...(body.operation !== undefined ? { operation: parseOperation(body.operation) } : {}),
      ...(typeof body.targetVersionId === 'string'
        ? { targetVersionId: body.targetVersionId }
        : {}),
      ...(typeof body.reason === 'string' && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey,
    })
    const proxy = await enqueueProjectProxyRenderService({
      projects: createProjectProxyRenderRepository(),
      operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey: `${idempotencyKey}:proxy`,
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess({
      command: {
        id: result.command.id,
        type: result.command.type,
        action: result.command.payload.action,
        baseVersionId: result.command.baseVersionId,
        resultVersionId: result.version.id,
        scope: result.command.scope,
        payload: result.command.payload,
        createdAt: result.command.createdAt,
      },
      version: presentProjectVersionV2({
        id: result.version.id,
        sequence: result.version.sequence,
        parentVersionId: result.version.parentVersionId,
        baseHash: result.version.baseHash,
        snapshotRefs: result.version.snapshotRefs,
        createdAt: result.version.createdAt,
      }, { current: true, previewAvailable: false }),
      timeline: result.timeline,
      comparison: result.comparison,
      operation: presentPublicOperation(proxy.operation),
      replayed: result.replayed && proxy.replayed,
    }), {
      status: result.replayed && proxy.replayed ? 200 : 201,
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
