import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createTreatmentPlan } from '@/v2/domain/treatment-plan'

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params; const project = await prisma.project.findUnique({ where: { id }, select: { treatmentPlanJson: true } })
  if (!project?.treatmentPlanJson) return NextResponse.json({ error: 'Tratamento ainda não definido' }, { status: 404 })
  return NextResponse.json({ treatmentPlan: JSON.parse(project.treatmentPlanJson) })
}
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try { const { id } = await props.params; const plan = createTreatmentPlan(await request.json()); await prisma.project.update({ where: { id }, data: { treatmentPlanJson: JSON.stringify(plan) } }); return NextResponse.json({ treatmentPlan: plan }) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Tratamento inválido' }, { status: 400 }) }
}
