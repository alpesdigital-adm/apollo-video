import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    // Get all projects, ordered by creation date (newest first)
    const projects = await prisma.project.findMany({
      select: {
        id: true,
        name: true,
        format: true,
        stylePreset: true,
        status: true,
        error: true,
        renderedVideoPath: true,
        renderJobs: {
          select: { id: true, status: true, progress: true, updatedAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        createdAt: true,
        updatedAt: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 20
    })

    return NextResponse.json({
      projects: projects.map((project) => {
        const latestJob = project.renderJobs[0]
        return {
          id: project.id, name: project.name, format: project.format, stylePreset: project.stylePreset,
          status: project.status, error: project.error, createdAt: project.createdAt, updatedAt: project.updatedAt,
          objective: null, locale: null, ownerId: null,
          currentVersion: null,
          job: latestJob ? { id: latestJob.id, status: latestJob.status, completed: Number.isFinite(latestJob.progress) ? latestJob.progress : null, total: Number.isFinite(latestJob.progress) ? 100 : null, updatedAt: latestJob.updatedAt } : null,
          reviewIssueCount: null,
          outputCount: project.renderedVideoPath ? 1 : 0,
        }
      })
    })
  } catch (error) {
    console.error('Get projects error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to get projects'
      },
      { status: 500 }
    )
  }
}
