import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  listProjectAssetSelectionsService,
  selectProjectAssetService,
  type AssetSelectionCandidateInput,
} from '@/v2/application/select-project-asset'
import type { PersistedAssetSelection } from '@/v2/application/ports/asset-selection-repository'
import type { AssetBrief } from '@/v2/domain/asset-selection'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createAssetSelectionRepository,
  createMediaArtifactQueryRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function strictRecord(value: unknown, allowed: readonly string[], field: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains an unsupported field`)
  }
  return record
}

function parseBody(value: unknown): {
  projectVersionId: string
  projectVersionHash: string
  brief: AssetBrief
  candidates: readonly AssetSelectionCandidateInput[]
} {
  const body = strictRecord(
    value,
    ['projectVersionId', 'projectVersionHash', 'brief', 'candidates'],
    'Request body',
  )
  if (
    typeof body.projectVersionId !== 'string' ||
    typeof body.projectVersionHash !== 'string' ||
    !Array.isArray(body.candidates)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'projectVersionId, projectVersionHash, brief and candidates are required',
    )
  }
  const brief = strictRecord(
    body.brief,
    ['intention', 'content', 'style', 'durationMs', 'entry', 'exit', 'prohibited'],
    'brief',
  )
  const duration = strictRecord(brief.durationMs, ['min', 'max'], 'brief.durationMs')
  const candidates = body.candidates.map((candidate, index) => strictRecord(
    candidate,
    [
      'artifactId',
      'source',
      'content',
      'style',
      'durationMs',
      'quality',
      'continuity',
      'novelty',
      'literalness',
    ],
    `candidates[${index}]`,
  ))
  return {
    projectVersionId: body.projectVersionId,
    projectVersionHash: body.projectVersionHash,
    brief: {
      intention: brief.intention as string,
      content: brief.content as string[],
      style: brief.style as string[],
      durationMs: {
        min: duration.min as number,
        max: duration.max as number,
      },
      entry: brief.entry as string,
      exit: brief.exit as string,
      prohibited: brief.prohibited as string[],
    },
    candidates: candidates as unknown as readonly AssetSelectionCandidateInput[],
  }
}

function presentSelection(selection: Readonly<PersistedAssetSelection>) {
  return {
    schemaVersion: selection.schemaVersion,
    id: selection.id,
    projectId: selection.projectId,
    projectVersionId: selection.projectVersionId,
    projectVersionHash: selection.projectVersionHash,
    brief: selection.brief,
    briefHash: selection.briefHash,
    candidates: selection.candidates.map((candidate) => ({
      artifactId: candidate.id,
      source: candidate.source,
      content: candidate.content,
      style: candidate.style,
      durationMs: candidate.durationMs,
      rights: candidate.rights,
      quality: candidate.quality,
      continuity: candidate.continuity,
      novelty: candidate.novelty,
      literalness: candidate.literalness,
    })),
    candidatesHash: selection.candidatesHash,
    rightsEvidence: selection.rightsEvidence,
    decision: selection.result.decision,
    selectedArtifactId: selection.result.selectedId,
    selectedSource: selection.result.source,
    evaluations: selection.result.evaluations,
    searchStoppedBefore: selection.result.searchStoppedBefore,
    auditId: selection.result.auditId,
    selectionHash: selection.selectionHash,
    createdBy: selection.createdBy,
    createdAt: selection.createdAt,
  }
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
    const projectVersionId =
      request.nextUrl.searchParams.get('projectVersionId')?.trim() || undefined
    const limitValue = request.nextUrl.searchParams.get('limit')
    const limit = limitValue === null ? undefined : Number(limitValue)
    const selections = await listProjectAssetSelectionsService({
      selections: createAssetSelectionRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
    return NextResponse.json(
      presentSuccess({ selections: selections.map(presentSelection) }),
      { headers: publicApiHeaders(requestId) },
    )
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
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseBody(raw)
    const { projectId } = await context.params
    const result = await selectProjectAssetService({
      selections: createAssetSelectionRepository(),
      artifacts: createMediaArtifactQueryRepository(),
      rights: createAssetRightsRepository(),
      clock: () => new Date(),
      createId: () => `asset-selection-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      projectVersionHash: body.projectVersionHash,
      brief: body.brief,
      candidates: body.candidates,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        selection: presentSelection(result.selection),
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
