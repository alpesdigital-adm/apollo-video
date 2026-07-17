import { NextRequest, NextResponse } from 'next/server'
import { planTalkingHead, planVisualMontage, validateProductionCoverage } from '@/v2/domain/production-modes'
export async function POST(request: NextRequest) { try { const body = await request.json(); const plan = body.mode === 'visual-montage' ? planVisualMontage(body) : planTalkingHead(body); return NextResponse.json({ plan, quality: validateProductionCoverage(plan) }) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Plano inválido' }, { status: 400 }) } }
