import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { validateStoryPlan } from '@/v2/domain/story-plan'

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) { const { id } = await props.params; const project = await prisma.project.findUnique({ where: { id }, select: { storyPlanJson: true } }); if (!project?.storyPlanJson) return NextResponse.json({ error: 'StoryPlan não encontrado' }, { status: 404 }); return NextResponse.json({ storyPlan: JSON.parse(project.storyPlanJson) }) }
export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) { try { const { id } = await props.params; const result = validateStoryPlan(await request.json()); await prisma.project.update({ where: { id }, data: { storyPlanJson: JSON.stringify(result.plan) } }); return NextResponse.json(result) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'StoryPlan inválido' }, { status: 400 }) } }
