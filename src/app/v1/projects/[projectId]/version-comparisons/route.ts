import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderService } from '@/v2/application/enqueue-project-proxy-render'
import { applyManualEditService } from '@/v2/application/manual-edit'
import {
  decideVersionComparisonService,
  readVersionComparisonService,
} from '@/v2/application/version-compare'
import { DomainError } from '@/v2/domain/errors'
import type { VersionCompareMode } from '@/v2/domain/manual-editing'
import {
  createColorPipelineCompilationRepository,
  createManualEditRepository,
  createProjectProxyRenderRepository,
  createPublicOperationRepository,
  createVersionCompareRepository,
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

function identity(value: string | null, field: string): string {
  const normalized = value?.trim() ?? ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return normalized
}

function mode(value: string | null): VersionCompareMode {
  if (!['toggle', 'split', 'overlay'].includes(value ?? '')) {
    throw new DomainError('INVALID_ARGUMENT', 'mode must be toggle, split or overlay')
  }
  return value as VersionCompareMode
}

function strictBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  }
  const record = value as Record<string, unknown>
  const allowed = [
    'action', 'beforeVersionId', 'afterVersionId', 'mode', 'baseVersionId',
    'baseHash', 'expectedRevision', 'variantId', 'reason',
  ]
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
  }
  return record
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const result = await readVersionComparisonService({
      repository: createManualEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      beforeVersionId: identity(request.nextUrl.searchParams.get('beforeVersionId'), 'beforeVersionId'),
      afterVersionId: identity(request.nextUrl.searchParams.get('afterVersionId'), 'afterVersionId'),
      mode: mode(request.nextUrl.searchParams.get('mode')),
    })
    return NextResponse.json(presentSuccess(result), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
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
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = strictBody(raw)
    if (
      !['accept', 'reopen', 'restore'].includes(String(body.action)) ||
      typeof body.beforeVersionId !== 'string' ||
      typeof body.afterVersionId !== 'string' ||
      typeof body.mode !== 'string' ||
      typeof body.baseVersionId !== 'string' ||
      typeof body.baseHash !== 'string' ||
      typeof body.expectedRevision !== 'number' ||
      typeof body.variantId !== 'string' ||
      (body.reason !== undefined && typeof body.reason !== 'string')
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'Version comparison action request is invalid')
    }
    const { projectId } = await context.params
    const compareMode = mode(body.mode)
    const action = body.action as 'accept' | 'reopen' | 'restore'
    if (action !== 'restore') {
      const result = await decideVersionComparisonService({
        comparisonRepository: createVersionCompareRepository(),
        manualEditRepository: createManualEditRepository(),
        clock: () => new Date(),
        createCommandId: () => `edit-command-${randomUUID()}`,
        createEventId: randomUUID,
      })({
        workspaceId: actor.workspaceId,
        projectId,
        beforeVersionId: body.beforeVersionId,
        afterVersionId: body.afterVersionId,
        mode: compareMode,
        action,
        baseVersionId: body.baseVersionId,
        baseHash: body.baseHash,
        expectedRevision: body.expectedRevision,
        actor: actor.auditContext.actor,
        idempotencyKey,
        ...(typeof body.reason === 'string' && body.reason.trim()
          ? { reason: body.reason.trim() }
          : {}),
      })
      return NextResponse.json(presentSuccess({
        action,
        command: {
          id: result.command.id,
          type: result.command.type,
          baseVersionId: result.command.baseVersionId,
          scope: result.command.scope,
          payload: result.command.payload,
          createdAt: result.command.createdAt,
        },
        projectStatus: result.projectStatus,
        comparison: result.comparison,
        impact: result.impact,
        versionsPreserved: true,
        replayed: result.replayed,
      }), {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      })
    }
    const comparisonState = await readVersionComparisonService({
      repository: createManualEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      beforeVersionId: body.beforeVersionId,
      afterVersionId: body.afterVersionId,
      mode: compareMode,
    })
    if (
      comparisonState.current.versionId !== body.baseVersionId ||
      comparisonState.current.baseHash !== body.baseHash ||
      comparisonState.current.revision !== body.expectedRevision ||
      comparisonState.versions.after.id !== comparisonState.current.versionId
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Version comparison base is stale', {
        currentVersionId: comparisonState.current.versionId,
        currentBaseHash: comparisonState.current.baseHash,
        currentRevision: comparisonState.current.revision,
      })
    }
    const restored = await applyManualEditService({
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
      action: 'restore',
      variantId: body.variantId,
      targetId: 'project-edit-plan',
      targetVersionId: body.beforeVersionId,
      actor: actor.auditContext.actor,
      idempotencyKey,
      ...(typeof body.reason === 'string' && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
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
      actor: actor.auditContext.actor,
      idempotencyKey: `${idempotencyKey}:proxy`,
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess({
      action,
      command: {
        id: restored.command.id,
        type: restored.command.type,
        baseVersionId: restored.command.baseVersionId,
        resultVersionId: restored.version.id,
        scope: restored.command.scope,
        payload: restored.command.payload,
        createdAt: restored.command.createdAt,
      },
      version: presentProjectVersionV2({
        id: restored.version.id,
        sequence: restored.version.sequence,
        parentVersionId: restored.version.parentVersionId,
        baseHash: restored.version.baseHash,
        snapshotRefs: restored.version.snapshotRefs,
        createdAt: restored.version.createdAt,
      }, { current: true, previewAvailable: false }),
      timeline: restored.timeline,
      comparison: comparisonState.comparison,
      versionsPreserved: true,
      operation: presentPublicOperation(proxy.operation),
      replayed: restored.replayed && proxy.replayed,
    }), {
      status: restored.replayed && proxy.replayed ? 200 : 201,
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
