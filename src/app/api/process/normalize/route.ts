import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeVideo } from '@/lib/services/ffmpeg'
import path from 'path'

export async function POST(request: NextRequest) {
  let projectId: string | null = null

  try {
    const body = await request.json()
    projectId = body.projectId

    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    }

    // Get project from database
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!project.rawVideoPath) {
      return NextResponse.json({ error: 'Raw video path not set' }, { status: 400 })
    }

    // Update status to normalizing
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'normalizing' }
    })

    // Generate output path for normalized video
    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    const normalizedPath = path.join(uploadDir, `${projectId}-normalized.mp4`)

    // Normalize the video
    const videoInfo = await normalizeVideo(project.rawVideoPath, normalizedPath)

    // Update project with normalized path and prepare for transcription
    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: {
        normalizedPath,
        videoDuration: videoInfo.duration,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        videoFps: videoInfo.fps,
        status: 'transcribing'
      }
    })

    return NextResponse.json({
      success: true,
      normalizedPath,
      videoInfo
    })
  } catch (error) {
    // Update status to error if projectId is available
    if (projectId) {
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: { status: 'error' }
        })
      } catch (dbError) {
        console.error('Failed to update error status:', dbError)
      }
    }

    console.error('Normalize error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Normalization failed'
      },
      { status: 500 }
    )
  }
}
