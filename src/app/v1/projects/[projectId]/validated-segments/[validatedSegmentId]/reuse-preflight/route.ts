import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { preflightValidatedSegmentReuseService } from '@/v2/application/catalog-validated-segments'
import { DomainError } from '@/v2/domain/errors'
import {
  VALIDATED_PROTECTED_ASPECTS,
  type ValidatedProtectedAspect,
} from '@/v2/domain/validated-segment'
import { createValidatedSegmentRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const BODY_FIELDS = new Set([
  'targetRecipe',
  'requestedChanges',
  'claim',
])
const RECIPE_FIELDS = new Set([
  'id',
  'role',
  'objective',
  'format',
  'locale',
])

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains an unsupported field`,
    )
  }
}

function strictBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, BODY_FIELDS, 'Request body')
  const recipe = record(body.targetRecipe, 'targetRecipe')
  exactFields(recipe, RECIPE_FIELDS, 'targetRecipe')
  if (
    typeof recipe.id !== 'string' ||
    !['hook', 'body', 'cta', 'proof', 'whole-video'].includes(
      String(recipe.role),
    ) ||
    typeof recipe.objective !== 'string' ||
    typeof recipe.format !== 'string' ||
    typeof recipe.locale !== 'string' ||
    !Array.isArray(body.requestedChanges) ||
    !body.requestedChanges.every(
      (change) =>
        typeof change === 'string' &&
        VALIDATED_PROTECTED_ASPECTS.includes(
          change as ValidatedProtectedAspect,
        ),
    ) ||
    !['historical-association', 'causality'].includes(
      String(body.claim),
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'ValidatedSegment reuse preflight is invalid',
    )
  }
  return {
    targetRecipe: {
      id: recipe.id,
      role:
        recipe.role as
          | 'hook'
          | 'body'
          | 'cta'
          | 'proof'
          | 'whole-video',
      objective: recipe.objective,
      format: recipe.format,
      locale: recipe.locale,
    },
    requestedChanges:
      body.requestedChanges as ValidatedProtectedAspect[],
    claim:
      body.claim as 'historical-association' | 'causality',
  }
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{
      projectId: string
      validatedSegmentId: string
    }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = strictBody(rawBody)
    const { projectId, validatedSegmentId } = await context.params
    const decision = await preflightValidatedSegmentReuseService({
      repository: createValidatedSegmentRepository(),
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      validatedSegmentId,
      ...body,
    })
    return NextResponse.json(presentSuccess({ decision }), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
