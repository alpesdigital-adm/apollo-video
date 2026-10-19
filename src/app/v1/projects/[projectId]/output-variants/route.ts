import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createProjectOutputVariantService } from '@/v2/application/create-project'
import { createProjectOutputVariantRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { parseCreateProjectOutputVariantBody, presentOutputBoundVersion } from '@/v2/public-api/project-output-variant-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { DomainError } from '@/v2/domain/errors'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request), { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const result = await createProjectOutputVariantService({ repository: createProjectOutputVariantRepository(),
      clock: () => new Date(), createId: kind => `${kind}-${randomUUID()}`, createEventId: randomUUID })({
      ...parseCreateProjectOutputVariantBody(raw), workspaceId: actor.workspaceId, projectId, actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    if (result.bundle.origin.kind !== 'create-output-variant') throw new DomainError('PERSISTENCE_CONFLICT', 'Output receipt origin differs')
    const c = result.bundle.origin.result.command, entry = result.bundle.state.document.entries.find(e => e.variantId === c.payload.variantId)
    if (!entry) throw new DomainError('PERSISTENCE_CONFLICT', 'Output receipt member is missing')
    return NextResponse.json(presentSuccess({ version: presentOutputBoundVersion(result.bundle.version),
      command: { id: c.id, type: c.type, baseVersionId: c.baseVersionId, commandHash: c.commandHash },
      variant: { id: entry.variantId, outputSpecRevisionId: entry.outputSpecRevisionId,
        specHash: entry.specHash, revisionNumber: entry.spec.revisionNumber,
        consumption: entry.consumption.status === 'blocked' ? entry.consumption : {
          status: 'materialized', materializationHash: entry.consumption.materialization.materializationHash,
        } }, replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
