import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteProjectFiles } from '@/lib/project-files'
import { isRenderActive } from '@/lib/services/remotion-render'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
