import { NextRequest, NextResponse } from 'next/server'
import { validateNarrativeEdit } from '@/v2/domain/narrative-safety'
export async function POST(request: NextRequest) { try { const body = await request.json(); const result = validateNarrativeEdit(Array.isArray(body.statements) ? body.statements : [], Array.isArray(body.edit) ? body.edit : []); return NextResponse.json(result, { status: result.safe ? 200 : 409 }) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Validação narrativa falhou' }, { status: 400 }) } }
