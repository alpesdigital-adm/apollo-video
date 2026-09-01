import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { applyProviderCallbackService } from '@/v2/application/transformation-jobs'
import { DomainError } from '@/v2/domain/errors'
import {
  createProviderJobRepository,
  createTransformationProviderRegistryRepository,
  transformationAdapterEnvironment,
} from '@/v2/infrastructure/repository-factory'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * The inbound provider callback boundary.
 *
 * This endpoint has its own authentication and does not accept a Bearer token.
 * A provider has no Apollo credential and never should: it proves itself with
 * an HMAC over the exact bytes it sent, bound to a timestamp inside a narrow
 * window and to an event id that is consumed exactly once, durably.
 *
 * It is also not `/v1/webhooks/*`. Those are Apollo's *outbound* deliveries to
 * customers. This is the opposite direction, and the two share no secret, no
 * table and no trust.
 *
 * Nothing here advances a job. It records a verified event and wakes the
 * schedule; the worker, which holds the lease, does the advancing. That
 * separation is what stops a duplicate delivery from ingesting a result twice.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ providerId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const { providerId } = await context.params
    const workspaceId = request.headers.get('apollo-workspace-id')?.trim()
    const providerJobId = request.headers.get('apollo-provider-job-id')?.trim()
    if (!workspaceId || !providerJobId) {
      throw new DomainError('INVALID_ARGUMENT', 'Provider callback must name its workspace and provider job')
    }

    const configuration = transformationAdapterEnvironment(process.env, providerId)
    if (!configuration?.callbackSecret) {
      // Refused without disclosing whether the provider exists: an unconfigured
      // provider and a wrong provider id must look identical from outside.
      throw new DomainError('WEBHOOK_SECRET_UNAVAILABLE', 'Provider callback verification is not configured')
    }

    // The exact bytes. Parsing and re-serialising before verification would let
    // a caller reorder keys or reformat a number past the signature.
    const rawBody = new Uint8Array(await request.arrayBuffer())
    const headers: Record<string, string | undefined> = {}
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })

    const providers = await createTransformationProviderRegistryRepository().listProviders({ workspaceId })
    const provider = providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new DomainError('WEBHOOK_SECRET_UNAVAILABLE', 'Provider callback verification is not configured')

    const outcome = await applyProviderCallbackService({
      jobs: createProviderJobRepository(),
      clock: () => new Date(),
      createEventId: () => `provider-callback-${randomUUID()}`,
    })({
      workspaceId,
      providerId,
      adapterId: provider.adapterId,
      providerJobId,
      secret: configuration.callbackSecret,
      rawBody,
      headers,
    })

    // A rejection answers 202 with the verdict rather than a 4xx: the status
    // code is what a provider retries on, and a forged callback must not be
    // able to make a genuine provider hammer this endpoint.
    return NextResponse.json(
      presentSuccess({
        outcome: outcome.outcome,
        ...(outcome.reason ? { rejectedBecause: outcome.reason } : {}),
      }),
      { status: 202, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
