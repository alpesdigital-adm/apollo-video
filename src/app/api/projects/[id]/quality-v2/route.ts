import { NextRequest, NextResponse } from 'next/server'
import { selectAsset } from '@/v2/domain/asset-selection'
import { compileQualityPatches, createQualityReport, critiqueAsset, critiqueProxy, decideQualityIteration, validateQuality } from '@/v2/application/closed-quality-loop'
import { evaluateMvpCoreGate, QUALITY_API_ACTIONS } from '@/v2/domain/mvp-core-gate'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = await request.json()
  try {
    if (!QUALITY_API_ACTIONS.includes(body.action)) return NextResponse.json({ error: 'Unsupported quality action' }, { status: 400 })
    const input = { ...body.input, projectId: id }
    const result = body.action === 'select-asset' ? selectAsset(input.brief, input.candidates)
      : body.action === 'critique-asset' ? critiqueAsset(input)
      : body.action === 'critique-proxy' ? critiqueProxy(input)
      : body.action === 'validate' ? validateQuality(input)
      : body.action === 'compile-patches' ? compileQualityPatches(input.issues)
      : body.action === 'iterate' ? decideQualityIteration(input)
      : body.action === 'report' ? createQualityReport(input)
      : body.action === 'mvp-gate' ? evaluateMvpCoreGate(input.evidence)
      : null
    if (!result) return NextResponse.json({ error: 'Quality operation produced no result' }, { status: 422 })
    return NextResponse.json({ data: result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Quality operation failed' }, { status: 422 })
  }
}
