import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isRenderActive } from '@/lib/services/remotion-render'
import { hasSnapshot } from '@/lib/project-director'
import { pickMusicForProject } from '@/lib/audio-assets'

const ORPHAN_RENDER_THRESHOLD_MS = 3 * 60000

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const projectId = params.id

    if (!projectId) {
      return NextResponse.json({ error: 'Project ID required' }, { status: 400 })
    }

    // Get project from database
    let project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        renderJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Lazy reconciliation: cover server restarts where a render process
    // died without ever reaching the close/error handlers.
    if (project.status === 'rendering' && !isRenderActive(projectId)) {
      const latestJob = project.renderJobs[0] || null
      const isStale =
        latestJob &&
        (latestJob.status === 'queued' || latestJob.status === 'rendering') &&
        Date.now() - latestJob.updatedAt.getTime() > ORPHAN_RENDER_THRESHOLD_MS

      if (isStale) {
        const message = 'Render órfão — processo não está mais ativo'
        try {
          await prisma.renderJob.update({
            where: { id: latestJob.id },
            data: { status: 'failed', error: message }
          })
          await prisma.project.update({
            where: { id: projectId },
            data: { status: 'error', error: message }
          })

          project = await prisma.project.findUnique({
            where: { id: projectId },
            include: {
              renderJobs: {
                orderBy: { createdAt: 'desc' },
                take: 1
              }
            }
          })
        } catch (reconcileError) {
          console.error('Failed to reconcile orphaned render:', reconcileError)
        }
      }
    }

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get latest render job if any
    const latestRenderJob = project.renderJobs[0] || null

    return NextResponse.json({
      id: project.id,
      name: project.name,
      status: project.status,
      error: project.error,
      format: project.format,
      engineKind: project.engineKind,
      stylePreset: project.stylePreset,
      videoDuration: project.videoDuration,
      videoWidth: project.videoWidth,
      videoHeight: project.videoHeight,
      videoFps: project.videoFps,
      normalizedPath: project.normalizedPath,
      editPlan: project.editPlanJson ? JSON.parse(project.editPlanJson) : null,
      transcription: project.transcriptionJson ? JSON.parse(project.transcriptionJson) : null,
      subtitles: project.subtitlesJson ? JSON.parse(project.subtitlesJson) : [],
      silences: project.silencesJson ? JSON.parse(project.silencesJson) : [],
      scenes: project.scenesJson ? JSON.parse(project.scenesJson) : [],
      palette: project.paletteJson ? JSON.parse(project.paletteJson) : null,
      musicPick: pickMusicForProject(projectId),
      hasRefineSnapshot: hasSnapshot(projectId),
      renderedVideoPath: project.renderedVideoPath,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      renderJob: latestRenderJob
        ? {
            id: latestRenderJob.id,
            status: latestRenderJob.status,
            progress: latestRenderJob.progress,
            error: latestRenderJob.error
          }
        : null
    })
  } catch (error) {
    console.error('Status error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to get project status'
      },
      { status: 500 }
    )
  }
}
