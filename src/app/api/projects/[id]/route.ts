import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteProjectFiles } from '@/lib/project-files'
import { isRenderActive } from '@/lib/services/remotion-render'
import { createProductionBrief } from '@/v2/domain/production-brief'

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  return (!origin || origin === request.nextUrl.origin) && (!fetchSite || fetchSite === 'same-origin')
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Origem não autorizada' }, { status: 403 })
  try {
    const body = await request.json() as { action?: string; name?: string; format?: string; briefing?: string }
    const project = await prisma.project.findUnique({ where: { id } })
    if (!project) return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
    if (body.action === 'rename') {
      const name = body.name?.trim().replace(/\s+/g, ' ') ?? ''
      if (name.length < 1 || name.length > 120) return NextResponse.json({ error: 'O nome deve ter entre 1 e 120 caracteres' }, { status: 400 })
      const updated = await prisma.project.update({ where: { id }, data: { name } })
      return NextResponse.json({ project: { id: updated.id, name: updated.name, status: updated.status } })
    }
    if (body.action === 'configure') {
      const allowedFormats = new Set(['9:16', '16:9', '4:5', '1:1', '21:9'])
      if (body.format && !allowedFormats.has(body.format)) {
        return NextResponse.json({ error: 'Formato de saída inválido' }, { status: 400 })
      }
      if (typeof body.briefing === 'string' && body.briefing.length > 10_000) {
        return NextResponse.json({ error: 'O briefing deve ter no máximo 10.000 caracteres' }, { status: 400 })
      }
      const data = {
        ...(body.format ? { format: body.format } : {}),
        ...(typeof body.briefing === 'string'
          ? { briefingJson: JSON.stringify(createProductionBrief({ ownerText: body.briefing })) }
          : {})
      }
      const updated = await prisma.project.update({ where: { id }, data })
      return NextResponse.json({ project: { id, format: updated.format, briefing: updated.briefingJson ? JSON.parse(updated.briefingJson) : null } })
    }
    if (body.action === 'archive') {
      if (isRenderActive(id)) return NextResponse.json({ error: 'Não é possível arquivar durante um render' }, { status: 409 })
      if (project.status === 'archived') return NextResponse.json({ project: { id, status: 'archived' } })
      const updated = await prisma.project.update({ where: { id }, data: { archivedFromStatus: project.status, status: 'archived' } })
      return NextResponse.json({ project: { id: updated.id, status: updated.status } })
    }
    if (body.action === 'restore') {
      if (project.status !== 'archived') return NextResponse.json({ error: 'O projeto não está arquivado' }, { status: 409 })
      const updated = await prisma.project.update({ where: { id }, data: { status: project.archivedFromStatus ?? 'created', archivedFromStatus: null } })
      return NextResponse.json({ project: { id: updated.id, status: updated.status } })
    }
    return NextResponse.json({ error: 'Ação não suportada' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha ao alterar projeto' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const projectId = params.id

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
    }

    if (isRenderActive(projectId)) {
      return NextResponse.json(
        { error: 'Não é possível excluir durante um render' },
        { status: 409 }
      )
    }

    const { files, bytes } = await deleteProjectFiles(project)

    await prisma.project.delete({ where: { id: projectId } })

    return NextResponse.json({
      success: true,
      filesRemoved: files,
      freedMB: Math.round((bytes / (1024 * 1024)) * 100) / 100
    })
  } catch (error) {
    console.error('Delete project error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao excluir projeto' },
      { status: 500 }
    )
  }
}
