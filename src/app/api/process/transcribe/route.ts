import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cutSilencesFromVideo, detectSilences, extractAudio, generatePreviewProxy } from '@/lib/services/ffmpeg'
import { getPreferredTranscriptionAudioExtension, transcribeAudio } from '@/lib/services/whisper'
import { generateSubtitlesFromTranscription } from '@/lib/utils/silence'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'
import type { Silence } from '@/lib/types/project'
import path from 'path'
import fs from 'fs'

export async function POST(request: NextRequest) {
  let tempAudioPath: string | null = null
  let projectId: string | null = null
  let lockAcquired = false

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

    if (!acquireStepLock('transcribe', projectId)) {
      return NextResponse.json(
        { error: 'Transcription already running for this project' },
        { status: 409 }
      )
    }
    lockAcquired = true

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

    // Always start from the pristine normalized file: on re-runs, normalizedPath
    // points at the autocut, and using the same file as ffmpeg input AND output
    // corrupts the stream (invalid NAL units) and double-cuts the timeline.
    const pristineNormalizedPath = path.join(uploadDir, `${projectId}-normalized.mp4`)
    const sourceVideoPath = fs.existsSync(pristineNormalizedPath)
      ? pristineNormalizedPath
      : project.normalizedPath

    // Extract audio from normalized video
    await extractAudio(sourceVideoPath, tempAudioPath)

    // Transcribe audio using the configured high-quality provider.
    const transcription = await transcribeAudio(tempAudioPath)

    let silences: Silence[] = []
    let cutPath = sourceVideoPath
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
        sourceVideoPath,
        cutPath,
        silences,
        Math.max(
          project.videoDuration || 0,
          transcription.segments[transcription.segments.length - 1]?.end || 0
        )
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

    // Best-effort: generate a lightweight preview proxy for the browser player
    // when the working (autocut) file is large. Never blocks or fails the route.
    if (!skipAutoCut && cutPath !== sourceVideoPath) {
      try {
        const previewMinBytes = Number(process.env.PREVIEW_PROXY_MIN_MB || 150) * 1024 * 1024
        if (fs.statSync(cutPath).size > previewMinBytes) {
          const proxyPath = path.join(uploadDir, `${projectId}-proxy.mp4`)
          const proxyTmpPath = path.join(uploadDir, `${projectId}-proxy.tmp.mp4`)

          generatePreviewProxy(cutPath, proxyTmpPath)
            .then(() => {
              fs.renameSync(proxyTmpPath, proxyPath)
              console.log(`Preview proxy generated for project ${projectId}`)
            })
            .catch((proxyError) => {
              console.warn(`Preview proxy generation failed for project ${projectId}:`, proxyError)
            })
        }
      } catch (statError) {
        console.warn(`Preview proxy check failed for project ${projectId}:`, statError)
      }
    }

    // Clean up temp audio file
    if (fs.existsSync(tempAudioPath)) {
      fs.unlinkSync(tempAudioPath)
      tempAudioPath = null
    }

    // Beat thumbnails were generated against the previous subtitlesJson —
    // drop them so the next /beats call regenerates against the new timeline.
    try {
      const thumbsDir = path.join(process.cwd(), 'public', 'thumbs', projectId)
      if (fs.existsSync(thumbsDir)) {
        fs.rmSync(thumbsDir, { recursive: true, force: true })
      }
    } catch (thumbsError) {
      console.warn(`Failed to clear stale beat thumbs for project ${projectId}:`, thumbsError)
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
  } finally {
    if (lockAcquired && projectId) {
      releaseStepLock('transcribe', projectId)
    }
  }
}
