import { NextRequest, NextResponse } from 'next/server'
import { getAssetById, updateAsset } from '@/lib/asset-library'
import { catalogImage } from '@/v2/domain/image-library'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const asset = getAssetById(id)
    if (!asset) return NextResponse.json({ error: 'Asset não encontrado' }, { status: 404 })
    if (asset.kind !== 'image') return NextResponse.json({ error: 'Análise disponível apenas para imagens' }, { status: 409 })
    const body = await request.json()
    const analysis = catalogImage({ assetId: id, width: Number(body.width ?? asset.width), height: Number(body.height ?? asset.height), colors: Array.isArray(body.colors) ? body.colors : [], faces: Array.isArray(body.faces) ? body.faces : [], objects: Array.isArray(body.objects) ? body.objects : [], ocrRegions: Array.isArray(body.ocrRegions) ? body.ocrRegions : [], model: String(body.model ?? 'unknown'), modelVersion: String(body.modelVersion ?? 'unknown') })
    updateAsset(id, { imageAnalysis: analysis as unknown as Record<string, unknown>, tags: [...asset.tags, ...analysis.inferredTags.map((tag) => tag.value)] })
    return NextResponse.json({ analysis })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Análise inválida' }, { status: 400 }) }
}
