import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { refineScene } from '@/lib/services/claude'
import type { Scene } from '@/lib/types/scene'

export async function POST(request: NextRequest) {
  try {
    const { projectId, sceneId, instruction } = await request.json()

    if (!projectId || !sceneId || !instruction) {
      return NextResponse.json(
        { error: 'projectId, sceneId, and instruction required' },
        { status: 400 }
      )
    }

    // Get project from database
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!project.scenesJson) {
      return NextResponse.json({ error: 'No scenes found' }, { status: 400 })
    }

    // Parse scenes
    const scenes: Scene[] = JSON.parse(project.scenesJson)

    // Find the scene to refine
    const sceneIndex = scenes.findIndex((s) => s.id === sceneId)

    if (sceneIndex === -1) {
      return NextResponse.json({ error: 'Scene not found' }, { status: 404 })
    }

    const currentScene = scenes[sceneIndex]

    // Call Claude to refine the scene based on instruction
    const refinedScene = await refineScene(currentScene, instruction)

    // Update the scene in the array
    scenes[sceneIndex] = refinedScene

    // Save updated scenes to database
    await prisma.project.update({
      where: { id: projectId },
      data: {
        scenesJson: JSON.stringify(scenes)
      }
    })

    return NextResponse.json({
      success: true,
      scene: refinedScene
    })
  } catch (error) {
    console.error('Refine scene error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to refine scene'
      },
      { status: 500 }
    )
  }
}
