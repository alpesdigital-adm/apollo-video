import { NextRequest, NextResponse } from 'next/server'
import { existsSync, unlinkSync } from 'fs'
import path from 'path'
import { deleteAsset, getAssetById, getAssetsDir, updateAsset } from '@/lib/asset-library'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json().catch(() => ({}))
    const patch: { label?: string; tags?: string[] | string } = {}
    if (typeof body.label === 'string') patch.label = body.label
    if (body.tags !== undefined) patch.tags = body.tags

    const updated = updateAsset(params.id, patch)
    if (!updated) {
      return NextResponse.json({ error: 'Asset não encontrado' }, { status: 404 })
    }
    return NextResponse.json({ asset: updated })
  } catch (error) {
    console.error('Asset update error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao atualizar o asset' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const asset = getAssetById(params.id)
    if (!asset) {
      return NextResponse.json({ error: 'Asset não encontrado' }, { status: 404 })
    }

    // Remove o arquivo físico (best-effort) antes de apagar o registro.
    const basename = path.basename(asset.path)
    const filePath = path.join(getAssetsDir(), basename)
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath)
      } catch (error) {
        console.error('Failed to remove asset file:', error)
      }
    }

    deleteAsset(params.id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Asset delete error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao excluir o asset' },
      { status: 500 }
    )
  }
}
