import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { diagnoseMediaArtifactLineageService } from '@/v2/application/diagnose-media-artifact-lineage'
import { createMediaArtifactQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { publicArtifactReference } from '@/v2/public-api/public-media-identity'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string; manifestId: string }> },
) {
  const requestId = resolveRequestId(request)

  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const { artifactId, manifestId } = await context.params
    const diagnoseLineage = diagnoseMediaArtifactLineageService({
      repository: createMediaArtifactQueryRepository(),
    })
    const diagnostic = await diagnoseLineage(actor.workspaceId, artifactId, manifestId)

    return NextResponse.json(
      presentSuccess({ ...diagnostic, nodes: diagnostic.nodes.map((node) => ({ ...node, artifactKey: publicArtifactReference(node.artifactId) })) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
