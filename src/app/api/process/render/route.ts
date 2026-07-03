import { NextRequest, NextResponse } from 'next/server'
import { startProjectRender, isRenderActive } from '@/lib/services/remotion-render'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'

export async function POST(request: NextRequest) {
  let projectId: string | null = null
  let lockAcquired = false

  try {
    const body = await request.json()
    projectId = body.projectId

    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    }

    if (isRenderActive(projectId)) {
      return NextResponse.json({ error: 'Render already running' }, { status: 409 })
    }

    if (!acquireStepLock('render', projectId)) {
      return NextResponse.json({ error: 'Render already running' }, { status: 409 })
    }
    lockAcquired = true

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
  } finally {
    if (lockAcquired && projectId) {
      releaseStepLock('render', projectId)
    }
  }
}
