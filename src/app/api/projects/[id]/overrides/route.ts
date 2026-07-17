import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeProjectOverrides } from '@/v2/domain/project-overrides'

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const project = await prisma.project.findUnique({ where: { id }, select: { overridesJson: true } })
  if (!project) return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
  return NextResponse.json({ overrides: project.overridesJson ? JSON.parse(project.overridesJson) : {} })
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin')
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Origem não autorizada' }, { status: 403 })
  const { id } = await props.params
  try {
    const body = await request.json() as { overrides?: unknown }
    const overrides = normalizeProjectOverrides(body.overrides ?? {})
    const updated = await prisma.project.update({ where: { id }, data: { overridesJson: JSON.stringify(overrides) }, select: { id: true } })
    return NextResponse.json({ projectId: updated.id, overrides })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha ao salvar overrides' }, { status: 400 })
  }
}
