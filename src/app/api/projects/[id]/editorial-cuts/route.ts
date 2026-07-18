import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cutSilencesFromVideo, AUTOCUT_MARGIN, getVideoInfo } from '@/lib/services/ffmpeg'
import { generateSubtitlesFromTranscription } from '@/lib/utils/silence'
import {
  applyEditorialCutsToTranscription,
  editorialCutsAsSilences,
  normalizeEditorialCuts,
  type EditorialCut
} from '@/lib/editorial-cuts'
import type { Transcription } from '@/lib/types/project'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const body = await request.json() as { cuts?: EditorialCut[] }
    const project = await prisma.project.findUnique({ where: { id } })
    if (!project) return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
    if (!project.transcriptionJson || !project.normalizedPath) {
      return NextResponse.json({ error: 'O projeto ainda não possui transcrição editável' }, { status: 409 })
    }
    if (!Array.isArray(body.cuts) || !body.cuts.length || body.cuts.length > 50) {
      return NextResponse.json({ error: 'Informe entre 1 e 50 cortes editoriais' }, { status: 400 })
    }

    const fps = project.videoFps || 30
    const pristinePath = path.join(process.cwd(), 'public', 'uploads', `${id}-normalized.mp4`)
    const sourcePath = pristinePath
    const sourceInfo = await getVideoInfo(sourcePath)
    const sourceDuration = sourceInfo.duration
    const cuts = normalizeEditorialCuts(body.cuts, sourceDuration)
    if (!cuts.length) return NextResponse.json({ error: 'Nenhum intervalo de corte válido' }, { status: 400 })

    const requestedCuts = editorialCutsAsSilences(cuts, fps, AUTOCUT_MARGIN)
    const outputPath = path.join(process.cwd(), 'public', 'uploads', `${id}-editorial.mp4`)
    const result = await cutSilencesFromVideo(sourcePath, outputPath, requestedCuts, sourceDuration)

    const transcription = JSON.parse(project.transcriptionJson) as Transcription
    const editedTranscription = applyEditorialCutsToTranscription(transcription, cuts)
    const subtitles = generateSubtitlesFromTranscription(editedTranscription, result.cutSilences, fps)

    await prisma.project.update({
      where: { id },
      data: {
        transcriptionJson: JSON.stringify(editedTranscription),
        subtitlesJson: JSON.stringify(subtitles),
        silencesJson: JSON.stringify(result.cutSilences),
        normalizedPath: outputPath,
        videoDuration: result.outputDuration,
        scenesJson: null,
        editPlanJson: null,
        renderedVideoPath: null,
        status: 'analyzing',
        error: null
      }
    })

    return NextResponse.json({
      projectId: id,
      status: 'analyzing',
      cuts,
      removedDuration: Number((sourceDuration - result.outputDuration).toFixed(3)),
      outputDuration: result.outputDuration,
      remainingSubtitleCount: subtitles.length
    })
  } catch (error) {
    console.error('Editorial cuts failed:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha ao aplicar cortes editoriais' }, { status: 500 })
  }
}
