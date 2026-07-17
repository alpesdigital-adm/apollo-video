import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createPerceptionTimeline, queryPerceptionRange, type PerceptionKind } from '@/v2/domain/perception-timeline'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const project = await prisma.project.findUnique({ where: { id }, select: { perceptionTimelineJson: true } })
    if (!project?.perceptionTimelineJson) return NextResponse.json({ error: 'Percepção ainda não disponível' }, { status: 404 })
    const timeline = JSON.parse(project.perceptionTimelineJson)
    const kinds = request.nextUrl.searchParams.get('kinds')?.split(',').filter(Boolean) as PerceptionKind[] | undefined
    return NextResponse.json(queryPerceptionRange(timeline, { startMs: Number(request.nextUrl.searchParams.get('startMs') ?? 0), endMs: Number(request.nextUrl.searchParams.get('endMs') ?? timeline.durationMs), kinds }))
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Range inválido' }, { status: 400 }) }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const body = await request.json()
    const timeline = createPerceptionTimeline({ durationMs: Number(body.durationMs), observations: Array.isArray(body.observations) ? body.observations : [] })
    await prisma.project.update({ where: { id }, data: { perceptionTimelineJson: JSON.stringify(timeline) } })
    return NextResponse.json({ timeline })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Timeline inválida' }, { status: 400 }) }
}
