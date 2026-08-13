import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { evaluateEditorialGrammarService } from '@/v2/application/evaluate-editorial-grammar'
import { DomainError } from '@/v2/domain/errors'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { parseEditorialGrammarEvaluationBody } from '@/v2/public-api/editorial-grammar-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    let value: unknown
    try {
      value = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const result = await evaluateEditorialGrammarService()(parseEditorialGrammarEvaluationBody(value))
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
