import { NextRequest, NextResponse } from 'next/server'
import { existsSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import {
  addAsset,
  getAssetsDir,
  listAssets,
  type Asset,
  type AssetKind
} from '@/lib/asset-library'

const MAX_ASSET_BYTES = 80 * 1024 * 1024

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
const VIDEO_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
}

function extFromName(name: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(name || '')
  return match ? match[1].toLowerCase() : null
}

function resolveKindAndExt(file: File): { kind: AssetKind; ext: string } | null {
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('image/')) {
    return { kind: 'image', ext: IMAGE_EXTENSIONS[type] || extFromName(file.name) || 'png' }
  }
  if (type.startsWith('video/')) {
    return { kind: 'video', ext: VIDEO_EXTENSIONS[type] || extFromName(file.name) || 'mp4' }
  }
  // Fallback pela extensão do nome quando o browser não manda o mime.
  const ext = extFromName(file.name)
  if (ext && Object.values(IMAGE_EXTENSIONS).includes(ext)) return { kind: 'image', ext }
  if (ext && Object.values(VIDEO_EXTENSIONS).includes(ext)) return { kind: 'video', ext }
  return null
}

function makeAssetId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Best-effort probe de dimensões de imagem lendo apenas o cabeçalho do arquivo
 * (PNG / GIF / JPEG). Retorna null quando não é fácil — dimensões ficam omitidas.
 */
function probeImageSize(buffer: Buffer): { width: number; height: number } | null {
  try {
    // PNG: assinatura 8 bytes + IHDR (width/height big-endian nos offsets 16/20).
    if (
      buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    // GIF: "GIF87a"/"GIF89a" + width/height little-endian nos offsets 6/8.
    if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    // JPEG: percorre os markers até um SOF (0xFFC0..0xFFCF, exceto C4/C8/CC).
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7)
          }
        }
        const segmentLength = buffer.readUInt16BE(offset + 2)
        if (segmentLength <= 0) break
        offset += 2 + segmentLength
      }
    }
  } catch {
    return null
  }
  return null
}

export async function GET() {
  return NextResponse.json({ assets: listAssets() })
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

    const resolved = resolveKindAndExt(file)
    if (!resolved) {
      return NextResponse.json(
        { error: 'Formato inválido — envie uma imagem ou vídeo' },
        { status: 400 }
      )
    }

    if (file.size > MAX_ASSET_BYTES) {
      return NextResponse.json(
        { error: 'Arquivo muito grande — o máximo é 80MB' },
        { status: 400 }
      )
    }

    const assetsDir = getAssetsDir()
    if (!existsSync(assetsDir)) {
      await mkdir(assetsDir, { recursive: true })
    }

    const id = makeAssetId()
    const filename = `${id}.${resolved.ext}`
    const buffer = Buffer.from(await file.arrayBuffer())
    writeFileSync(path.join(assetsDir, filename), buffer)

    const asset: Asset = {
      id,
      kind: resolved.kind,
      label: label || file.name.replace(/\.[a-zA-Z0-9]+$/, ''),
      tags: tagsCsv
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      path: `/assets/${filename}`,
      addedAt: new Date().toISOString()
    }

    if (resolved.kind === 'image') {
      const size = probeImageSize(buffer)
      if (size) {
        asset.width = size.width
        asset.height = size.height
      }
    }

    const saved = addAsset(asset)
    return NextResponse.json({ asset: saved })
  } catch (error) {
    console.error('Asset upload error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao subir o asset' },
      { status: 500 }
    )
  }
}
