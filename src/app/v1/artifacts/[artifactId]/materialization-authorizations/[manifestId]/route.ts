import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { authorizeRenderInputMaterializationService } from '@/v2/application/authorize-render-input-materialization'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createMaterializationAuthorizationRepository,
  createMediaArtifactQueryRepository,
  createProtectedRenderInputStore,
  createRenderInputAssetAvailability,
} from '@/v2/infrastructure/repository-factory'
import { createConfiguredRenderTargetRegistry } from '@/v2/infrastructure/render-target-registry'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function parseRequest(body: unknown): {
  use: string
  market?: string
  syntheticOperations?: readonly string[]
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be a JSON object')
  }
  const value = body as Record<string, unknown>
  if (typeof value.use !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', 'use must be a string')
  }
  if (value.market !== undefined && typeof value.market !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', 'market must be a string')
  }
  if (
    value.syntheticOperations !== undefined &&
    (!Array.isArray(value.syntheticOperations) ||
      !value.syntheticOperations.every((item) => typeof item === 'string'))
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'syntheticOperations must contain strings')
  }
  if (
    Object.keys(value).some(
      (key) => !['use', 'market', 'syntheticOperations'].includes(key),
    )
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body contains unsupported properties')
  }
  return {
    use: value.use,
    ...(typeof value.market === 'string' ? { market: value.market } : {}),
    ...(Array.isArray(value.syntheticOperations)
      ? { syntheticOperations: value.syntheticOperations as string[] }
      : {}),
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string; manifestId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:render')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const { artifactId, manifestId } = await context.params
    const authorize = authorizeRenderInputMaterializationService({
      artifactRepository: createMediaArtifactQueryRepository(),
      protectedRenderInputs: createProtectedRenderInputStore(),
      assetAvailability: createRenderInputAssetAvailability(),
      targets: createConfiguredRenderTargetRegistry(),
      rights: createAssetRightsRepository(),
      authorizations: createMaterializationAuthorizationRepository(),
      clock: () => new Date(),
      createId: () => `materialization-auth-${randomUUID()}`,
    })
    const result = await authorize({
      workspaceId: actor.workspaceId,
      artifactId,
      manifestId,
      ...parseRequest(body),
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    const authorization = result.authorization
    return NextResponse.json(
      presentSuccess({
        authorization: {
          schemaVersion: authorization.schemaVersion,
          id: authorization.id,
          artifactId: authorization.artifactId,
          manifestId: authorization.manifestId,
          inputHash: authorization.inputHash,
          use: authorization.use,
          ...(authorization.market ? { market: authorization.market } : {}),
          locale: authorization.locale,
          syntheticOperations: [...authorization.syntheticOperations],
          status: authorization.status,
          issues: authorization.issues.map((issue) => ({ ...issue })),
          decisions: authorization.decisions.map((decision) => ({
            artifactId: decision.artifactId,
            assetOrdinal: decision.assetOrdinal,
            assetKind: decision.assetKind,
            outcome: decision.outcome,
            reasonCodes: [...decision.reasonCodes],
            ...(decision.rightsSnapshotId
              ? { rightsSnapshotId: decision.rightsSnapshotId }
              : {}),
            ...(decision.rightsSnapshotHash
              ? { rightsSnapshotHash: decision.rightsSnapshotHash }
              : {}),
            ...(decision.validUntil ? { validUntil: decision.validUntil } : {}),
          })),
          evaluatedAt: authorization.evaluatedAt,
          ...(authorization.validUntil
            ? { validUntil: authorization.validUntil }
            : {}),
          revalidationRequired: true,
        },
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
