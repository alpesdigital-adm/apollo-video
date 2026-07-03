import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { consumeSnapshot } from '@/lib/project-director'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'

export async function POST(request: NextRequest) {
  let projectId: string | null = null
  let lockAcquired = false

  try {
    const body = await request.json()
    projectId = body.projectId

    if (!projectId) {
      return NextResponse.json({ error: 'projectId é obrigatório' }, { status: 400 })
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!acquireStepLock('refine', projectId)) {
      return NextResponse.json(
        { error: 'Já existe uma edição em curso para este projeto' },
        { status: 409 }
      )
    }
    lockAcquired = true

    // Consome o snapshot (nível único de undo).
    const snapshot = await consumeSnapshot(projectId)
    if (!snapshot) {
      return NextResponse.json({ error: 'Nenhuma alteração para desfazer' }, { status: 404 })
    }

    await prisma.project.update({
      where: { id: projectId },
      data: {
        scenesJson: snapshot.scenesJson,
        paletteJson: snapshot.paletteJson,
        editPlanJson: snapshot.editPlanJson,
        renderedVideoPath: null,
        status: 'ready',
        error: null
      }
    })

    return NextResponse.json({
      success: true,
      scenes: snapshot.scenesJson ? JSON.parse(snapshot.scenesJson) : [],
      palette: snapshot.paletteJson ? JSON.parse(snapshot.paletteJson) : null
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao desfazer'
    console.error('Project refine undo error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    if (lockAcquired && projectId) {
      releaseStepLock('refine', projectId)
    }
  }
}
