import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readVariantRecipeService,
} from '@/v2/application/variant-recipes'
import {
  createVariantRecipeRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentVariantRecipe,
} from '@/v2/public-api/variant-recipe-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; recipeId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, recipeId } = await context.params
    const recipe = await readVariantRecipeService({
      repository: createVariantRecipeRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: recipeId,
    })
    return NextResponse.json(
      presentSuccess({
        recipe: presentVariantRecipe(recipe),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
