import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { relevantUncertainty } from '@/v2/domain/decision-confidence'

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const project = await prisma.project.findUnique({ where: { id }, select: { confidenceJson: true } })
  if (!project) return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
  const items = project.confidenceJson ? JSON.parse(project.confidenceJson) : []
  return NextResponse.json({ items, relevant: relevantUncertainty(items) })
}

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params; const body = await request.json(); const items = Array.isArray(body.items) ? body.items : []
    relevantUncertainty(items)
    await prisma.project.update({ where: { id }, data: { confidenceJson: JSON.stringify(items) } })
    return NextResponse.json({ items, relevant: relevantUncertainty(items) })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Confidence inválida' }, { status: 400 }) }
}
