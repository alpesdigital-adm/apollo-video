import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { spawn } from 'child_process'
import path from 'path'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'

interface InputProps {
  scenes: Scene[]
  subtitles: SubtitleEntry[]
  transcription: Transcription
  palette: any
  videoPath: string
  format: '9:16' | '16:9'
}

export async function POST(request: NextRequest) {
  let projectId: string | null = null

  try {
    const body = await request.json()
    projectId = body.projectId

    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    }

    // Get project from database with all necessary data
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (
      !project.scenesJson ||
      !project.transcriptionJson ||
      !project.subtitlesJson ||
      !project.normalizedPath
    ) {
      return NextResponse.json(
        { error: 'Project not ready for rendering' },
        { status: 400 }
      )
    }

    // Parse project data
    const scenes: Scene[] = JSON.parse(project.scenesJson)
    const transcription: Transcription = JSON.parse(project.transcriptionJson)
    const subtitles: SubtitleEntry[] = JSON.parse(project.subtitlesJson)
    const palette = project.paletteJson ? JSON.parse(project.paletteJson) : {}

    // Create render job
    const renderJob = await prisma.renderJob.create({
      data: {
        projectId,
        status: 'queued',
        progress: 0
      }
    })

    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'rendering' }
    })

    // Prepare input props for Remotion
    const inputProps: InputProps = {
      scenes,
      subtitles,
      transcription,
      palette,
      videoPath: project.normalizedPath,
      format: project.format as '9:16' | '16:9'
    }

    // Output path for rendered video
    const outputDir = path.join(process.cwd(), 'public', 'renders')
    const outputPath = path.join(outputDir, `${projectId}-render.mp4`)

    // Spawn Remotion render process
    const remotionProcess = spawn('npx', [
      'remotion',
      'render',
      path.join(process.cwd(), 'src/remotion/Main.tsx'),
      'Main',
      outputPath,
      '--props',
      JSON.stringify(inputProps),
      '--quality',
      '80',
      '--codec',
      'h264',
      '--crf',
      '23'
    ])

    let renderOutput = ''
    let hasError = false

    remotionProcess.stdout?.on('data', (data) => {
      renderOutput += data.toString()
      console.log(`Render output: ${data}`)

      // Try to extract progress from Remotion output
      try {
        await prisma.renderJob.update({
          where: { id: renderJob.id },
          data: { progress: Math.min(90, Math.random() * 90) } // Simulate progress
        })
      } catch (e) {
        console.error('Failed to update render progress:', e)
      }
    })

    remotionProcess.stderr?.on('data', (data) => {
      const errorMsg = data.toString()
      console.error(`Render error: ${errorMsg}`)
      hasError = true
    })

    remotionProcess.on('close', async (code) => {
      try {
        if (code === 0 && !hasError) {
          // Render completed successfully
          await prisma.renderJob.update({
            where: { id: renderJob.id },
            data: { status: 'completed', progress: 100, outputPath }
          })

          await prisma.project.update({
            where: { id: projectId },
            data: { status: 'complete', renderedVideoPath: outputPath }
          })

          console.log(`Render completed for project ${projectId}`)
        } else {
          // Render failed
          await prisma.renderJob.update({
            where: { id: renderJob.id },
            data: {
              status: 'failed',
              error: `Render process exited with code ${code}`
            }
          })

          await prisma.project.update({
            where: { id: projectId },
            data: { status: 'error' }
          })

          console.error(`Render failed for project ${projectId}`)
        }
      } catch (dbError) {
        console.error('Failed to update render job status:', dbError)
      }
    })

    return NextResponse.json({
      success: true,
      jobId: renderJob.id,
      message: 'Render job started'
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

    console.error('Render error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Render failed'
      },
      { status: 500 }
    )
  }
}
