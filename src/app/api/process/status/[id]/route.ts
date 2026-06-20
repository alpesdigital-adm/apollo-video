import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

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
    const project = await prisma.project.findUnique({
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
