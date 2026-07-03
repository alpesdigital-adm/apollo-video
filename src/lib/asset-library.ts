/**
 * Asset Library (Pacote 4) — registry das mídias PRÓPRIAS do usuário (clipes e
 * imagens que ele sobe: fotos de credibilidade, memes de filme/série, prints de
 * notícia, b-roll de evento/podcast). A IA usa esses assets nos vídeos.
 *
 * Segue o mesmo padrão file-backed de creator-profile.ts / brand-colors.ts:
 * registro em data/assets.json; arquivos servidos de public/assets/<id>.<ext>.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

export type AssetKind = 'image' | 'video'

export interface Asset {
  id: string
  kind: AssetKind
  label: string
  tags: string[]
  path: string // public URL, ex.: /assets/<id>.<ext>
  width?: number
  height?: number
  addedAt: string
}

export interface AssetLibrary {
  assets: Asset[]
}

/** Item compacto passado para os prompts (analyze/director). */
export interface AssetCatalogItem {
  id: string
  kind: AssetKind
  label: string
  tags: string[]
}

function getDataDir(): string {
  return path.join(process.cwd(), 'data')
}

function getLibraryPath(): string {
  return path.join(getDataDir(), 'assets.json')
}

export function getAssetsDir(): string {
  return path.join(process.cwd(), 'public', 'assets')
}

function sanitizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(',')
    : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of list) {
    const tag = String(entry || '').trim().replace(/\s+/g, ' ')
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= 20) break
  }
  return out
}

function sanitizeAsset(raw: any): Asset | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null
  const kind: AssetKind = raw.kind === 'video' ? 'video' : 'image'
  const assetPath = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : null
  if (!id || !assetPath) return null

  const asset: Asset = {
    id,
    kind,
    label: typeof raw.label === 'string' ? raw.label.trim() : '',
    tags: sanitizeTags(raw.tags),
    path: assetPath,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date().toISOString()
  }
  if (Number.isFinite(raw.width) && raw.width > 0) asset.width = Math.round(raw.width)
  if (Number.isFinite(raw.height) && raw.height > 0) asset.height = Math.round(raw.height)
  return asset
}

export function readAssetLibrary(): AssetLibrary {
  const filePath = getLibraryPath()
  if (!existsSync(filePath)) {
    return { assets: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    const assets = Array.isArray(parsed.assets)
      ? parsed.assets.map(sanitizeAsset).filter((a: Asset | null): a is Asset => a !== null)
      : []
    return { assets }
  } catch (error) {
    console.error('Failed to read asset library:', error)
    return { assets: [] }
  }
}

export function writeAssetLibrary(library: AssetLibrary): void {
  const dataDir = getDataDir()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  writeFileSync(getLibraryPath(), JSON.stringify(library, null, 2), 'utf8')
}

export function listAssets(): Asset[] {
  return readAssetLibrary().assets
}

export function getAssetById(id: string): Asset | null {
  if (!id) return null
  return readAssetLibrary().assets.find((asset) => asset.id === id) || null
}

export function addAsset(asset: Asset): Asset {
  const library = readAssetLibrary()
  const clean = sanitizeAsset(asset)
  if (!clean) {
    throw new Error('Invalid asset')
  }
  library.assets.unshift(clean)
  writeAssetLibrary(library)
  return clean
}

export function updateAsset(
  id: string,
  patch: { label?: string; tags?: string[] | string }
): Asset | null {
  const library = readAssetLibrary()
  const idx = library.assets.findIndex((asset) => asset.id === id)
  if (idx === -1) return null

  const current = library.assets[idx]
  const next: Asset = {
    ...current,
    label: patch.label !== undefined ? String(patch.label).trim() : current.label,
    tags: patch.tags !== undefined ? sanitizeTags(patch.tags) : current.tags
  }
  library.assets[idx] = next
  writeAssetLibrary(library)
  return next
}

export function deleteAsset(id: string): Asset | null {
  const library = readAssetLibrary()
  const idx = library.assets.findIndex((asset) => asset.id === id)
  if (idx === -1) return null
  const [removed] = library.assets.splice(idx, 1)
  writeAssetLibrary(library)
  return removed
}

/** Catálogo compacto (id/kind/label/tags, máx 50) para os prompts. */
export function getAssetCatalog(limit = 50): AssetCatalogItem[] {
  return listAssets()
    .slice(0, limit)
    .map((asset) => ({ id: asset.id, kind: asset.kind, label: asset.label, tags: asset.tags }))
}

/**
 * Resolve o campo `assetId` das cenas em paths de mídia server-side, ANTES do
 * engine/geração de imagem:
 *  - ImageInsert: asset de imagem → imagePath; asset de vídeo → videoSrc.
 *  - AssetCard: asset de imagem → imageSrc; asset de vídeo → videoSrc.
 * assetId inválido: ImageInsert perde o campo (segue como generate, com warn);
 * AssetCard é DESCARTADO (sem asset não há o que renderizar).
 * O `assetId` de referência é preservado na cena.
 */
export function resolveAssetsInScenes<T extends { type?: string; assetId?: string }>(
  scenes: T[]
): T[] {
  const out: T[] = []
  for (const scene of scenes) {
    const assetId = (scene as any).assetId
    if (!assetId || typeof assetId !== 'string') {
      out.push(scene)
      continue
    }

    const asset = getAssetById(assetId)
    if (!asset) {
      if (scene.type === 'AssetCard') {
        console.warn(`AssetCard com assetId inválido descartado: ${assetId}`)
        continue
      }
      // ImageInsert (ou outro): remove assetId e segue como geração normal.
      const { assetId: _drop, ...rest } = scene as any
      console.warn(`assetId inválido removido de cena ${scene.type}: ${assetId}`)
      out.push(rest as T)
      continue
    }

    if (scene.type === 'AssetCard') {
      out.push(
        asset.kind === 'video'
          ? ({ ...scene, videoSrc: asset.path } as T)
          : ({ ...scene, imageSrc: asset.path } as T)
      )
    } else if (scene.type === 'ImageInsert') {
      out.push(
        asset.kind === 'video'
          ? ({ ...scene, videoSrc: asset.path } as T)
          : ({ ...scene, imagePath: asset.path } as T)
      )
    } else {
      out.push(scene)
    }
  }
  return out
}
