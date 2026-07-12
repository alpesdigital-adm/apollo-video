import { NextRequest, NextResponse } from 'next/server'
import { existsSync } from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { saveSnapshot } from '@/lib/project-director'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'
import { buildBeats } from '@/lib/beats'
import { beatThumbFileName, beatThumbsDir } from '@/lib/beat-thumbs'
import { computeColdOpenWindow } from '@/lib/cold-open'
import type { EditPlan } from '@/lib/types/edl'
import type { SubtitleEntry } from '@/lib/types/project'
import type { Scene } from '@/lib/types/scene'

/**
 * COLD OPEN (Fase 3): grava/remove `editPlan.coldOpen` (janela na timeline FONTE).
 * Não regenera cenas — só anexa a janela ao plano e invalida o MP4 renderizado.
 * Compartilha o lock 'refine' com refine/beats-assign (o coldOpen atravessa a
 * regeneração do plano nessas rotas via VideoEngineContext.coldOpen).
 *
 * Body: { beatIndex: number } para definir; { remove: true } para remover.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const projectId = params.id
  let lockAcquired = false

  try {
    const body = await request.json().catch(() => null)
    const remove: boolean = body?.remove === true
    const beatIndex: number | undefined =
      typeof body?.beatIndex === 'number' ? body.beatIndex : undefined

    if (!remove && (typeof beatIndex !== 'number' || beatIndex < 0)) {
      return NextResponse.json({ error: 'beatIndex inválido' }, { status: 400 })
    }

    if (!acquireStepLock('refine', projectId)) {
      return NextResponse.json(
        { error: 'Já existe uma edição em curso para este projeto' },
        { status: 409 }
      )
    }
    lockAcquired = true

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (!project.editPlanJson) {
      return NextResponse.json({ error: 'Projeto sem plano de edição' }, { status: 400 })
    }
    if (!project.subtitlesJson) {
      return NextResponse.json({ error: 'Projeto sem legendas' }, { status: 400 })
    }

    const subtitles: SubtitleEntry[] = JSON.parse(project.subtitlesJson)
    const scenes: Scene[] = project.scenesJson ? JSON.parse(project.scenesJson) : []
    const editPlan: EditPlan = JSON.parse(project.editPlanJson)
    const fps = project.videoFps || 30
    const durationFrames = editPlan.durationFrames || Math.ceil((project.videoDuration || 1) * fps)

    if (remove) {
      delete (editPlan as any).coldOpen
    } else {
      if (beatIndex! > subtitles.length - 1) {
        return NextResponse.json({ error: 'beatIndex fora do intervalo' }, { status: 400 })
      }
      const window = computeColdOpenWindow(beatIndex!, subtitles, scenes, fps, durationFrames)
      if (!window) {
        return NextResponse.json(
          { error: 'Não foi possível montar a janela de abertura para esta batida' },
          { status: 400 }
        )
      }
      editPlan.coldOpen = window
    }

    // Snapshot BEFORE persisting (single-level undo, shared with refine).
    await saveSnapshot(projectId, {
      scenesJson: project.scenesJson,
      paletteJson: project.paletteJson,
      editPlanJson: project.editPlanJson
    })

    await prisma.project.update({
      where: { id: projectId },
      data: {
        editPlanJson: JSON.stringify(editPlan),
        renderedVideoPath: null,
        status: 'ready',
        error: null
      }
    })

    // Rebuild beats (subtitles/scenes unchanged) with thumbUrls, same as GET.
    const dir = beatThumbsDir(projectId)
    const rebuiltBeats = buildBeats(subtitles, scenes).map((b) => {
      const thumbFile = beatThumbFileName(b.index)
      const thumbUrl = existsSync(path.join(dir, thumbFile))
        ? `/thumbs/${projectId}/${thumbFile}`
        : null
      return { ...b, thumbUrl }
    })

    return NextResponse.json({
      success: true,
      coldOpen: (editPlan as any).coldOpen || null,
      beats: rebuiltBeats
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao ajustar a abertura'
    console.error('Cold open error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    if (lockAcquired) {
      releaseStepLock('refine', projectId)
    }
  }
}
