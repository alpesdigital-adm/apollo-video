import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createReadStream, statSync } from 'fs'
import { existsSync } from 'fs'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const videoId = params.id

    if (!videoId) {
      return NextResponse.json({ error: 'Video ID required' }, { status: 400 })
    }

    // Get project from database to find the video path
    const project = await prisma.project.findUnique({
      where: { id: videoId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Use rendered video if available, otherwise normalized, otherwise raw
    const videoPath = project.renderedVideoPath || project.normalizedPath || project.rawVideoPath

    if (!videoPath || !existsSync(videoPath)) {
      return NextResponse.json({ error: 'Video file not found' }, { status: 404 })
    }

    // Get file stats
    const stats = statSync(videoPath)
    const fileSize = stats.size

    // Get range header if present
    const rangeHeader = request.headers.get('range')

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      // Parse range header
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1

      if (start >= fileSize) {
        return new NextResponse(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`
          }
        })
      }

      const chunkSize = end - start + 1
      const stream = createReadStream(videoPath, { start, end })

      return new NextResponse(stream as any, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize.toString(),
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-cache'
        }
      })
    }

    // No range header, return full file
    const stream = createReadStream(videoPath)

    return new NextResponse(stream as any, {
      status: 200,
      headers: {
        'Content-Length': fileSize.toString(),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      }
    })
  } catch (error) {
    console.error('Video serving error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to serve video'
      },
      { status: 500 }
    )
  }
}
