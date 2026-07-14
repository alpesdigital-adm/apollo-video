import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readAssetRightsService } from '@/v2/application/read-asset-rights'
import { setAssetRightsService } from '@/v2/application/set-asset-rights'
import type { AssetRightsDraft, AssetRightsSnapshot } from '@/v2/domain/asset-rights'
import { DomainError } from '@/v2/domain/errors'
import { createAssetRightsRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function presentRights(snapshot: AssetRightsSnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    artifactId: snapshot.artifactId,
    sequence: snapshot.sequence,
    snapshotHash: snapshot.snapshotHash,
    ...(snapshot.owner ? { owner: snapshot.owner } : {}),
    ...(snapshot.license ? { license: snapshot.license } : {}),
    status: snapshot.status,
    allowedUses: [...snapshot.allowedUses],
    prohibitedUses: [...snapshot.prohibitedUses],
    allowedWorkspaceIds: [...snapshot.allowedWorkspaceIds],
    ...(snapshot.allowedMarkets ? { allowedMarkets: [...snapshot.allowedMarkets] } : {}),
    ...(snapshot.allowedLocales ? { allowedLocales: [...snapshot.allowedLocales] } : {}),
    ...(snapshot.allowedSyntheticOperations
      ? { allowedSyntheticOperations: [...snapshot.allowedSyntheticOperations] }
      : {}),
    ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
    consent: {
      status: snapshot.consent.status,
      allowedUses: [...snapshot.consent.allowedUses],
      ...(snapshot.consent.allowedMarkets
        ? { allowedMarkets: [...snapshot.consent.allowedMarkets] }
        : {}),
      ...(snapshot.consent.allowedLocales
        ? { allowedLocales: [...snapshot.consent.allowedLocales] }
        : {}),
      ...(snapshot.consent.allowedSyntheticOperations
        ? {
            allowedSyntheticOperations: [
              ...snapshot.consent.allowedSyntheticOperations,
            ],
          }
        : {}),
      ...(snapshot.consent.expiresAt ? { expiresAt: snapshot.consent.expiresAt } : {}),
      ...(snapshot.consent.documentArtifactId
        ? { documentArtifactId: snapshot.consent.documentArtifactId }
        : {}),
    },
    ...(snapshot.sourceNote ? { sourceNote: snapshot.sourceNote } : {}),
    createdBy: { ...snapshot.createdBy },
    createdAt: snapshot.createdAt,
  }
}

function parseDraft(body: unknown): AssetRightsDraft {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be a JSON object')
  }
  const candidate = body as Record<string, unknown>
  if (
    typeof candidate.consent !== 'object' ||
    candidate.consent === null ||
    Array.isArray(candidate.consent)
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'consent must be an object')
  }
  return body as AssetRightsDraft
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:rights')
    const { artifactId } = await context.params
    const readRights = readAssetRightsService({ repository: createAssetRightsRepository() })
    const result = await readRights(actor.workspaceId, artifactId)
    return NextResponse.json(
      presentSuccess({
        artifactId: result.artifactId,
        configured: result.snapshot !== null,
        ...(result.snapshot ? { rights: presentRights(result.snapshot) } : {}),
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:rights')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const { artifactId } = await context.params
    const setRights = setAssetRightsService({
      repository: createAssetRightsRepository(),
      clock: () => new Date(),
      createId: () => `rights-${randomUUID()}`,
    })
    const result = await setRights({
      workspaceId: actor.workspaceId,
      artifactId,
      draft: parseDraft(body),
      actor: { type: 'api-client', id: actor.clientId },
    })
    return NextResponse.json(
      presentSuccess({
        artifactId: result.artifactId,
        rights: presentRights(result.snapshot),
        replayed: result.replayed,
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
