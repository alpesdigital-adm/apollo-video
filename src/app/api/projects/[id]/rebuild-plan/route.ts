import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { narrativeEngine } from '@/lib/engines/narrative-engine'
import { resolveSceneTiming } from '@/lib/utils/timing'
import type { Silence, SubtitleEntry, Transcription } from '@/lib/types/project'
import type { Scene } from '@/lib/types/scene'

/**
 * Rebuild the editPlan for an existing project from the scenes already stored in
 * the DB — same engine path as /projects/refine (resolveSceneTiming →
 * narrativeEngine.createPlan) but WITHOUT the IA director step and WITHOUT a
 * snapshot. Use it to re-apply engine-level fixes (e.g. the buildLayoutSegments
 * clamp that stops a short layout segment from bleeding into the next scene) to
 * plans that were persisted before the fix existed. Invalidates the rendered
 * video so the next render picks up the fresh plan.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const projectId = params.id
    if (!projectId) {
      return NextResponse.json({ error: 'projectId é obrigatório' }, { status: 400 })
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (!project.scenesJson) {
      return NextResponse.json({ error: 'Nenhuma cena para reconstruir' }, { status: 400 })
    }
    if (!project.normalizedPath) {
      return NextResponse.json({ error: 'Vídeo processado não encontrado' }, { status: 400 })
    }

    const scenes: Scene[] = JSON.parse(project.scenesJson)
    const subtitles: SubtitleEntry[] = project.subtitlesJson ? JSON.parse(project.subtitlesJson) : []
    const silences: Silence[] = project.silencesJson ? JSON.parse(project.silencesJson) : []
    const transcription: Transcription | null = project.transcriptionJson
      ? JSON.parse(project.transcriptionJson)
      : null

    const format = (project.format || '16:9') as '9:16' | '16:9'
    const fps = project.videoFps || 30
    const stylePreset = project.stylePreset || 'creator-clean'

    // Preserve the persistent hook headline already resolved on the old plan.
    const existingPlan = project.editPlanJson ? JSON.parse(project.editPlanJson) : null
    const hookTitle: string | undefined =
      existingPlan && typeof existingPlan.hookTitle === 'string' && existingPlan.hookTitle.trim()
        ? existingPlan.hookTitle
        : undefined

    // Re-resolve timing (startLeg → frame) then rebuild the plan with the current
    // engine — no IA, no snapshot.
    const scenesWithTiming = resolveSceneTiming(scenes, subtitles, fps)

    const editPlan = narrativeEngine.createPlan({
      projectId,
      format,
      stylePreset,
      fps,
      source: {
        rawPath: project.rawVideoPath,
        renderPath: project.normalizedPath,
        duration: project.videoDuration || 0,
        width: project.videoWidth,
        height: project.videoHeight
      },
      transcription: transcription || ({ text: '', words: [], segments: [] } as unknown as Transcription),
      subtitles,
      silences,
      scenes: scenesWithTiming,
      hookTitle
    })

    await prisma.project.update({
      where: { id: projectId },
      data: {
        scenesJson: JSON.stringify(scenesWithTiming),
        engineKind: narrativeEngine.kind,
        editPlanJson: JSON.stringify(editPlan),
        renderedVideoPath: null,
        status: 'ready',
        error: null
      }
    })

    return NextResponse.json({
      ok: true,
      projectId,
      layoutSegments: editPlan.layoutSegments,
      sceneCount: scenesWithTiming.length
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao reconstruir o plano'
    console.error('Project rebuild-plan error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
