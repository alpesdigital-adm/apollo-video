import { NextRequest, NextResponse } from 'next/server'
import { startProjectRender } from '@/lib/services/remotion-render'

export async function POST(request: NextRequest) {
  let projectId: string | null = null

  try {
    const body = await request.json()
    projectId = body.projectId

    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    }

    const renderJob = await startProjectRender(projectId, {
      statusOnStart: 'rendering',
      clearExistingRender: true
    })

    return NextResponse.json({
      success: true,
      jobId: renderJob.jobId,
      message: 'Render job started'
    })
  } catch (error) {
    console.error('Render error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Render failed'
      },
      { status: 500 }
    )
  }
}
