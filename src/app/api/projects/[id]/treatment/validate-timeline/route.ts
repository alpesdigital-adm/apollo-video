import { NextRequest, NextResponse } from 'next/server'
import { validateCameraMotions, validateContinuity, validatePatternBreakBudget } from '@/v2/domain/editorial-grammar'

export async function POST(request: NextRequest) {
  try { const body = await request.json(); return NextResponse.json({ motions: validateCameraMotions(Array.isArray(body.motions) ? body.motions : []), patternBreaks: validatePatternBreakBudget(Array.isArray(body.patternBreaks) ? body.patternBreaks : [], body.patternPolicy ?? { windowMs: 30_000, maxPerWindow: 5, maxSameType: 2, maxSameGroup: 2 }), continuityIssues: validateContinuity(Array.isArray(body.continuityFrames) ? body.continuityFrames : []) }) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Timeline inválida' }, { status: 400 }) }
}
