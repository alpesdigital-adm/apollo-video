import { NextRequest, NextResponse } from 'next/server'
import { getStoredSegment } from '@/lib/media-segments'
import { materializeSegment } from '@/v2/domain/media-segment'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await props.params
  const segment = getStoredSegment(segmentId)
  if (!segment || segment.parentAssetId !== id) return NextResponse.json({ error: 'Segmento não encontrado' }, { status: 404 })
  const body = await request.json().catch(() => ({}))
  const recipe = materializeSegment(segment, { requiresPhysicalDerivative: Boolean(body.requiresPhysicalDerivative), key: typeof body.consumerKey === 'string' ? body.consumerKey : 'default' })
  return NextResponse.json({ segmentId, materialization: recipe, reusedVirtualRange: recipe === null })
}
