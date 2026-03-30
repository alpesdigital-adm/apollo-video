import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { extractAudio, detectSilences } from '@/lib/services/ffmpeg'
import { transcribeAudio } from '@/lib/services/whisper'
import path from 'path'
import fs from 'fs'
import type { SubtitleEntry } from '@/lib/types/project'

export async function POST(request: NextRequest) {
  let tempAudioPath: string | null = null
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

    if (!project.normalizedPath) {
      return NextResponse.json({ error: 'Normalized video not found' }, { status: 400 })
    }

    // Create temp directory for audio processing
    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    tempAudioPath = path.join(uploadDir, `${projectId}-audio.wav`)

    // Extract audio from normalized video
    await extractAudio(project.normalizedPath, tempAudioPath)

    // Transcribe audio using Whisper
    const transcription = await transcribeAudio(tempAudioPath)

    // Detect silences in audio
    const silences = await detectSilences(tempAudioPath)

    // Generate subtitles from transcription
    const subtitles: SubtitleEntry[] = transcription.segments.map((segment, index) => ({
      id: index,
      text: segment.text,
      startTime: segment.start,
      endTime: segment.end,
      startFrame: Math.round(segment.start * (project.videoFps || 30)),
      endFrame: Math.round(segment.end * (project.videoFps || 30)),
      words: segment.words
    }))

    // Detect video format based on aspect ratio
    const width = project.videoWidth || 1920
    const height = project.videoHeight || 1080
    const aspectRatio = width > height ? '16:9' : '9:16'

    // Update project with transcription data
    await prisma.project.update({
      where: { id: projectId },
      data: {
        transcriptionJson: JSON.stringify(transcription),
        subtitlesJson: JSON.stringify(subtitles),
        silencesJson: JSON.stringify(silences),
        format: aspectRatio,
        status: 'analyzing'
      }
    })

    // Clean up temp audio file
    if (fs.existsSync(tempAudioPath)) {
      fs.unlinkSync(tempAudioPath)
      tempAudioPath = null
    }

    return NextResponse.json({
      success: true,
      transcription,
      subtitles,
      silences,
      format: aspectRatio
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

    // Clean up temp file
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
      try {
        fs.unlinkSync(tempAudioPath)
      } catch (e) {
        console.error('Failed to clean up temp audio:', e)
      }
    }

    console.error('Transcribe error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Transcription failed'
      },
      { status: 500 }
    )
  }
}
