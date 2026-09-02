import { NextRequest, NextResponse } from 'next/server'

import { DomainError } from '@/v2/domain/errors'
import { createSyntheticMasterAssetServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { assertAllowlistedPublicQuery } from '@/v2/public-api/conventions'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parsePromoteSyntheticMasterBody,
  parseSyntheticMasterListQuery,
  presentSyntheticMaster,
  SYNTHETIC_MASTER_LIST_QUERY_PARAMETERS,
} from '@/v2/public-api/synthetic-master-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parsePromoteSyntheticMasterBody(raw)
    const services = createSyntheticMasterAssetServices()
    const promoted = await services.promote({
      workspaceId: actor.workspaceId,
      projectId,
      providerJobId: body.providerJobId,
      profileSnapshotId: body.profileSnapshotId,
      scriptText: body.scriptText,
      locale: body.locale,
      use: body.use,
      market: body.market,
      lineage: body.lineage,
      cost: body.cost,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({ master: presentSyntheticMaster(promoted.master), replayed: promoted.replayed }),
      { status: promoted.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    assertAllowlistedPublicQuery(request.nextUrl.searchParams, SYNTHETIC_MASTER_LIST_QUERY_PARAMETERS)
    const query = parseSyntheticMasterListQuery(request.nextUrl.searchParams)
    const services = createSyntheticMasterAssetServices()
    const masters = await services.listMasters({
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      ...query,
    })
    return NextResponse.json(
      presentSuccess({ masters: masters.map((persisted) => presentSyntheticMaster(persisted)) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
