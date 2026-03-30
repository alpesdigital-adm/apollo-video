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
        status: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 20
    })

    return NextResponse.json({
      projects
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
