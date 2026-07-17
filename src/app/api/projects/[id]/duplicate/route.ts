import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  if ((origin && origin !== request.nextUrl.origin) || (fetchSite && fetchSite !== 'same-origin')) return NextResponse.json({ error: 'Origem não autorizada' }, { status: 403 })
  const { id } = await props.params
  try {
    const project = await prisma.project.findUnique({ where: { id } })
    if (!project) return NextResponse.json({ error: 'Projeto não encontrado' }, { status: 404 })
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...sharedReferences } = project
    const duplicate = await prisma.project.create({
      data: { ...sharedReferences, name: `${project.name} (cópia)`.slice(0, 120), status: 'created', error: null, archivedFromStatus: null },
    })
    return NextResponse.json({ project: { id: duplicate.id, name: duplicate.name, status: duplicate.status }, copyMode: 'shared-source-references' }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha ao duplicar projeto' }, { status: 500 })
  }
}
