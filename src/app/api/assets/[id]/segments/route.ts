import { NextRequest, NextResponse } from 'next/server'
import { getAssetById } from '@/lib/asset-library'
import { getStoredSegment, listStoredSegments, storeSegment } from '@/lib/media-segments'
import { createMediaSegment } from '@/v2/domain/media-segment'

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  return NextResponse.json({ segments: listStoredSegments(id) })
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const asset = getAssetById(id)
    if (!asset) return NextResponse.json({ error: 'Asset não encontrado' }, { status: 404 })
    const body = await request.json()
    const parent = typeof body.parentSegmentId === 'string' ? getStoredSegment(body.parentSegmentId) ?? undefined : undefined
    const segment = createMediaSegment({ id: `seg_${crypto.randomUUID()}`, workspaceId: 'legacy-default', parentAssetId: id, parentDurationMs: Math.round((asset.duration ?? 0) * 1000), parentSegment: parent, label: String(body.label ?? ''), description: body.description, startMs: Number(body.startMs), endMs: Number(body.endMs) })
    return NextResponse.json({ segment: storeSegment(segment) }, { status: 201 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Segmento inválido' }, { status: 400 }) }
}
