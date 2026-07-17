import { NextRequest, NextResponse } from 'next/server'
import { getAssetById } from '@/lib/asset-library'
import { prisma } from '@/lib/db'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const body = await request.json().catch(() => ({}))
  if (typeof body.projectId !== 'string' || !body.projectId) return NextResponse.json({ error: 'projectId é obrigatório' }, { status: 400 })
  const asset = getAssetById(id)
  if (!asset) return NextResponse.json({ error: 'Asset não encontrado' }, { status: 404 })
  if (asset.status !== 'usable' || asset.rightsStatus !== 'eligible') return NextResponse.json({ error: 'Asset indisponível ou com direito restrito' }, { status: 409 })
  const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { assetRefsJson: true } })
  if (!project) return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
  const refs = new Set<string>(project.assetRefsJson ? JSON.parse(project.assetRefsJson) : [])
  refs.add(id)
  await prisma.project.update({ where: { id: body.projectId }, data: { assetRefsJson: JSON.stringify([...refs]) } })
  return NextResponse.json({ reference: { projectId: body.projectId, assetId: id, bytesDuplicated: false } })
}
