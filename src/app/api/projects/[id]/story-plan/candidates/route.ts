import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { selectMontageCandidate } from '@/v2/application/select-montage-candidate'

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) { const { id } = await props.params; const project = await prisma.project.findUnique({ where: { id }, select: { montageCandidatesJson: true } }); if (!project?.montageCandidatesJson) return NextResponse.json({ error: 'Candidatos não encontrados' }, { status: 404 }); return NextResponse.json(JSON.parse(project.montageCandidatesJson)) }
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) { try { const { id } = await props.params; const body = await request.json(); const result = selectMontageCandidate({ seeds: body.seeds ?? [], rubric: body.rubric, minimumConfidence: Number(body.minimumConfidence ?? .7) }); await prisma.project.update({ where: { id }, data: { montageCandidatesJson: JSON.stringify(result) } }); return NextResponse.json(result) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Candidatos inválidos' }, { status: 400 }) } }
