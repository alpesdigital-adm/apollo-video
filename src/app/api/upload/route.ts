import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getVideoInfo } from '@/lib/services/ffmpeg'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { resolveStrategicObjective } from '@/v2/domain/strategic-objective'

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File
    const objective = resolveStrategicObjective(String(formData.get('objective') ?? 'discovery'))
    // Seletor de preset removido do produto: o visual é dirigido pelas cores da
    // marca, presets de legenda, grade e leis de direção. Fica o padrão fixo.
    const stylePreset = 'creator-clean'

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!file.type.startsWith('video/')) {
      return NextResponse.json({ error: 'File must be a video' }, { status: 400 })
    }

    // Ensure uploads directory exists
    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    if (!existsSync(uploadDir)) {
      await mkdir(uploadDir, { recursive: true })
    }

    // Generate unique filename
    const filename = `${uuidv4()}.mp4`
    const filepath = path.join(uploadDir, filename)

    // Save file to disk
    const bytes = await file.arrayBuffer()
    await writeFile(filepath, Buffer.from(bytes))

    // Get video information
    const videoInfo = await getVideoInfo(filepath)

    // Detect video format based on aspect ratio
    const aspectRatio = videoInfo.width > videoInfo.height ? '16:9' : '9:16'

    // Create project in database
    const project = await prisma.project.create({
      data: {
        id: uuidv4(),
        name: file.name.replace(/\.[^/.]+$/, ''), // Remove extension
        rawVideoPath: filepath,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        videoDuration: videoInfo.duration,
        videoFps: videoInfo.fps,
        format: aspectRatio,
        stylePreset,
        objective: objective.id,
        status: 'created'
      }
    })

    return NextResponse.json({
      projectId: project.id,
      format: aspectRatio,
      videoInfo
    })
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Upload failed'
      },
      { status: 500 }
    )
  }
}
