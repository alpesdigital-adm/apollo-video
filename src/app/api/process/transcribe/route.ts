import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cutSilencesFromVideo, detectSilences, extractAudio } from '@/lib/services/ffmpeg'
import { getPreferredTranscriptionAudioExtension, transcribeAudio } from '@/lib/services/whisper'
import { generateSubtitlesFromTranscription } from '@/lib/utils/silence'
import type { Silence } from '@/lib/types/project'
import path from 'path'
import fs from 'fs'

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
    const forceTranscription = Boolean(body.force)
    const skipAutoCut = Boolean(body.skipAutoCut)
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!project.normalizedPath) {
      return NextResponse.json({ error: 'Normalized video not found' }, { status: 400 })
    }

    if (!forceTranscription && project.transcriptionJson && project.subtitlesJson && project.silencesJson) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          status: 'analyzing',
          error: null
        }
      })

      return NextResponse.json({
        success: true,
        transcription: JSON.parse(project.transcriptionJson),
        subtitles: JSON.parse(project.subtitlesJson),
        silences: JSON.parse(project.silencesJson),
        format: project.format,
        reusedExistingTranscription: true
      })
    }

    // Create temp directory for audio processing
    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    const audioExtension = getPreferredTranscriptionAudioExtension()
    tempAudioPath = path.join(uploadDir, `${projectId}-audio.${audioExtension}`)

    // Extract audio from normalized video
    await extractAudio(project.normalizedPath, tempAudioPath)

    // Transcribe audio using the configured high-quality provider.
    const transcription = await transcribeAudio(tempAudioPath)

    let silences: Silence[] = []
    let cutPath = project.normalizedPath
    let cutResult: { cutSilences: Silence[]; outputDuration: number } = {
      cutSilences: [],
      outputDuration:
        project.videoDuration ||
        transcription.segments[transcription.segments.length - 1]?.end ||
        0
    }

    if (!skipAutoCut) {
      // Detect silences in audio
      const silenceThreshold = Number(process.env.AUTO_CUT_SILENCE_DB || -35)
      const silenceDuration = Number(process.env.AUTO_CUT_MIN_SILENCE || 0.55)
      silences = await detectSilences(tempAudioPath, silenceThreshold, silenceDuration)

      // Cut the actual media and shift transcript timings to the new edited timeline.
      cutPath = path.join(uploadDir, `${projectId}-autocut.mp4`)
      cutResult = await cutSilencesFromVideo(
        project.normalizedPath,
        cutPath,
        silences,
        project.videoDuration || 0
      )
    }

    const subtitles = generateSubtitlesFromTranscription(
      transcription,
      cutResult.cutSilences,
      project.videoFps || 30
    )

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
        silencesJson: JSON.stringify(cutResult.cutSilences),
        normalizedPath: cutPath,
        videoDuration: cutResult.outputDuration,
        format: aspectRatio,
        engineKind: 'narrative',
        editPlanJson: null,
        scenesJson: null,
        paletteJson: null,
        narrativeFormat: null,
        renderedVideoPath: null,
        error: null,
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
      silences: cutResult.cutSilences,
      format: aspectRatio
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed'

    // Update status to error if projectId is available
    if (projectId) {
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            status: 'error',
            error: message
          }
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
        error: message
      },
      { status: 500 }
    )
  }
}
