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
      format: project.format,
      videoDuration: project.videoDuration,
      videoWidth: project.videoWidth,
      videoHeight: project.videoHeight,
      normalizedPath: project.normalizedPath,
      transcriptionJson: project.transcriptionJson ? JSON.parse(project.transcriptionJson) : null,
      scenesJson: project.scenesJson ? JSON.parse(project.scenesJson) : null,
      paletteJson: project.paletteJson ? JSON.parse(project.paletteJson) : null,
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
