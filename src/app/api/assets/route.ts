import { NextRequest, NextResponse } from 'next/server'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import {
  addAsset,
  getAssetsDir,
  listAssets,
  type Asset
} from '@/lib/asset-library'
import { getMediaProbe } from '@/lib/services/ffmpeg'
import { evaluateMediaProbe, sniffMediaInput } from '@/v2/domain/media-input'
import { DomainError } from '@/v2/domain/errors'

const MAX_ASSET_BYTES = 80 * 1024 * 1024

function makeAssetId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const limit = Math.min(Math.max(Number(params.get('limit') || 24), 1), 100)
  const offset = Math.max(Number(params.get('offset') || 0), 0)
  const kind = params.get('kind')
  const person = params.get('person')?.toLocaleLowerCase()
  const theme = params.get('theme')?.toLocaleLowerCase()
  const rights = params.get('rights')
  const filtered = listAssets().filter((asset) =>
    (!kind || asset.kind === kind) &&
    (!person || asset.person?.toLocaleLowerCase() === person) &&
    (!theme || asset.theme?.toLocaleLowerCase().includes(theme) || asset.tags.some((tag) => tag.toLocaleLowerCase().includes(theme))) &&
    (!rights || asset.rightsStatus === rights)
  )
  return NextResponse.json({ assets: filtered.slice(offset, offset + limit), page: { offset, limit, total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null } })
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const label = String(formData.get('label') ?? '').trim()
    const tagsCsv = String(formData.get('tags') ?? '')

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'Arquivo é obrigatório' }, { status: 400 })
    }

    if (file.size > MAX_ASSET_BYTES) {
      return NextResponse.json(
        { error: 'Arquivo muito grande — o máximo é 80MB', code: 'SIZE_LIMIT', action: 'Use o upload multipart da API pública ou reduza o arquivo.' },
        { status: 400 }
      )
    }

    const assetsDir = getAssetsDir()
    if (!existsSync(assetsDir)) {
      await mkdir(assetsDir, { recursive: true })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const detected = sniffMediaInput({ filename: file.name, declaredMime: file.type, bytes: buffer.subarray(0, 64), byteSize: file.size })
    const id = makeAssetId()
    const filename = `${id}.${detected.extension}`
    const finalPath = path.join(assetsDir, filename)
    const quarantinePath = `${finalPath}.quarantine`
    writeFileSync(quarantinePath, buffer)
    let decision
    try {
      decision = evaluateMediaProbe(detected, await getMediaProbe(quarantinePath))
      if (decision.status !== 'usable') {
        unlinkSync(quarantinePath)
        return NextResponse.json({ error: decision.error?.message, code: decision.error?.code, action: decision.error?.action, status: 'quarantined' }, { status: 422 })
      }
      renameSync(quarantinePath, finalPath)
    } catch (error) {
      if (existsSync(quarantinePath)) unlinkSync(quarantinePath)
      throw error
    }

    const asset: Asset = {
      id,
      kind: detected.kind,
      label: label || file.name.replace(/\.[a-zA-Z0-9]+$/, ''),
      tags: tagsCsv
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      path: `/assets/${filename}`,
      addedAt: new Date().toISOString(),
      status: 'usable',
      codec: decision.probe?.codec,
      duration: decision.probe?.duration,
      width: decision.probe?.width,
      height: decision.probe?.height
    }

    const saved = addAsset(asset)
    return NextResponse.json({ asset: saved })
  } catch (error) {
    console.error('Asset upload error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao subir o asset', ...(error instanceof DomainError ? { code: error.code, action: 'Confira formato, extensão e integridade do arquivo.' } : { code: 'PROBE_FAILED', action: 'Exporte novamente o arquivo e tente outra vez.' }) },
      { status: error instanceof DomainError ? 400 : 422 }
    )
  }
}
