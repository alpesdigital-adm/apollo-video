import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { analyzeContent } from '@/lib/services/claude'
import { resolveSceneTiming } from '@/lib/utils/timing'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'
import type { Scene } from '@/lib/types/scene'

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

    if (!project.transcriptionJson) {
      return NextResponse.json({ error: 'Transcription not found' }, { status: 400 })
    }

    // Parse transcription and subtitles
    const transcription: Transcription = JSON.parse(project.transcriptionJson)
    const subtitles: SubtitleEntry[] = project.subtitlesJson ? JSON.parse(project.subtitlesJson) : []

    // Call Claude API to analyze content and generate scenes
    const analysisResult = await analyzeContent(
      transcription.text,
      project.format || '16:9'
    )

    // Resolve scene timing - convert startLeg to actual frame numbers
    const scenesWithTiming = resolveSceneTiming(analysisResult.scenes, subtitles)

    // Update project with analysis results
    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: {
        scenesJson: JSON.stringify(scenesWithTiming),
        paletteJson: JSON.stringify(analysisResult.palette),
        narrativeFormat: analysisResult.narrativeFormat,
        status: 'ready'
      }
    })

    return NextResponse.json({
      success: true,
      scenes: scenesWithTiming,
      palette: analysisResult.palette,
      narrativeFormat: analysisResult.narrativeFormat
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

    console.error('Analyze error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Analysis failed'
      },
      { status: 500 }
    )
  }
}
