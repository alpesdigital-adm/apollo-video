import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(
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

    if (project.status !== 'complete' && project.status !== 'error') {
      return NextResponse.json(
        { error: 'Só é possível voltar para revisão a partir de um projeto concluído ou com erro' },
        { status: 400 }
      )
    }

    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: 'ready',
        error: null
      }
    })

    return NextResponse.json({ success: true, status: 'ready' })
  } catch (error) {
    console.error('Reopen project error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao voltar para revisão' },
      { status: 500 }
    )
  }
}
