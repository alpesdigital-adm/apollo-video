import { NextRequest, NextResponse } from 'next/server'
import { existsSync } from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'
import { buildBeats } from '@/lib/beats'
import { beatThumbFileName, beatThumbsDir, generateBeatThumbs } from '@/lib/beat-thumbs'
import type { SubtitleEntry } from '@/lib/types/project'
import type { Scene } from '@/lib/types/scene'
import { FPS } from '@/lib/types/timing'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const projectId = params.id

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!project.subtitlesJson) {
      return NextResponse.json({ error: 'Project has no subtitles yet' }, { status: 400 })
    }

    const subtitles: SubtitleEntry[] = JSON.parse(project.subtitlesJson)
    const scenes: Scene[] = project.scenesJson ? JSON.parse(project.scenesJson) : []

    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    const proxyPath = path.join(uploadDir, `${projectId}-proxy.mp4`)
    const videoPath = existsSync(proxyPath) ? proxyPath : project.normalizedPath

    let thumbsReady = false
    const lockAcquired = acquireStepLock('thumbs', projectId)

    if (lockAcquired) {
      try {
        if (videoPath && subtitles.length > 0) {
          await generateBeatThumbs(projectId, videoPath, subtitles, project.updatedAt.getTime())
        }
        thumbsReady = true
      } finally {
        releaseStepLock('thumbs', projectId)
      }
    }

    const dir = beatThumbsDir(projectId)
    const beats = buildBeats(subtitles, scenes).map((beat) => {
      const thumbFile = beatThumbFileName(beat.index)
      const thumbUrl = existsSync(path.join(dir, thumbFile))
        ? `/thumbs/${projectId}/${thumbFile}`
        : null

      return { ...beat, thumbUrl }
    })

    return NextResponse.json({
      beats,
      fps: project.videoFps || FPS,
      videoDuration: project.videoDuration,
      thumbsReady
    })
  } catch (error) {
    console.error('Beats error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build beats' },
      { status: 500 }
    )
  }
}
