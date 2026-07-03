import crypto from 'crypto'
import fs from 'fs'
import { mkdir, readdir, writeFile } from 'fs/promises'
import path from 'path'
import type { Scene } from '../types/scene'

/**
 * Pacote 3 — fonte opcional de stock (Pexels Videos).
 *
 * Para cenas ImageInsert com `source: 'stock'` + `stockQuery`, busca um vídeo
 * vertical na Pexels e usa como b-roll. Sem PEXELS_API_KEY ou sem resultado, a
 * cena é deixada intacta (o fluxo normal — still/generate — segue valendo).
 * Cache por query: o mesmo termo reusa o arquivo já baixado.
 */

interface ApplyStockOptions {
  scenes: Scene[]
}

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }
  const content = fs.readFileSync(filePath, 'utf8')
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`))
  if (!line) {
    return null
  }
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

function getEnvValue(key: string): string | null {
  return (
    readEnvFileValue(path.join(process.cwd(), '.env.local'), key) ||
    readEnvFileValue(path.join(process.cwd(), '.env'), key) ||
    process.env[key] ||
    null
  )
}

function queryHash(query: string): string {
  return crypto.createHash('sha1').update(query.trim().toLowerCase()).digest('hex').slice(0, 16)
}

async function findCachedClip(outputDir: string, hash: string): Promise<string | null> {
  try {
    const files = await readdir(outputDir)
    const match = files.find((file) => file === `${hash}.mp4`)
    return match ? `/stock/${match}` : null
  } catch {
    return null
  }
}

interface PexelsVideoFile {
  quality?: string
  width?: number
  height?: number
  link?: string
  file_type?: string
}

interface PexelsVideo {
  video_files?: PexelsVideoFile[]
}

/**
 * Pick the best portrait mp4 file: portrait (height > width), preferring the
 * largest one that stays at or under ~1080 wide (medium/hd range).
 */
function pickBestFile(video: PexelsVideo): string | null {
  const files = (video.video_files || []).filter(
    (file) =>
      file.link &&
      (file.file_type === 'video/mp4' || /\.mp4/i.test(file.link)) &&
      Number(file.height) > Number(file.width)
  )
  if (files.length === 0) {
    return null
  }
  const ranked = [...files].sort((a, b) => {
    const aw = Number(a.width) || 0
    const bw = Number(b.width) || 0
    const aOver = aw > 1200 ? 1 : 0
    const bOver = bw > 1200 ? 1 : 0
    if (aOver !== bOver) return aOver - bOver
    return bw - aw
  })
  return ranked[0]?.link || null
}

async function searchPexels(apiKey: string, query: string): Promise<string | null> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
    query
  )}&orientation=portrait&size=medium&per_page=5`
  const response = await fetch(url, { headers: { Authorization: apiKey } })
  if (!response.ok) {
    throw new Error(`Pexels search failed (${response.status})`)
  }
  const payload = await response.json().catch(() => null)
  const videos: PexelsVideo[] = Array.isArray(payload?.videos) ? payload.videos : []
  for (const video of videos) {
    const link = pickBestFile(video)
    if (link) {
      return link
    }
  }
  return null
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download stock clip (${response.status})`)
  }
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()))
}

/**
 * Resolve `videoSrc` for ImageInsert scenes with source === 'stock'. Failure of
 * any single lookup is a console.warn and leaves the scene untouched so the
 * normal generate/still path can take over.
 */
export async function applyStockVideos({ scenes }: ApplyStockOptions): Promise<Scene[]> {
  const apiKey = getEnvValue('PEXELS_API_KEY')

  const eligible = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(
      ({ scene }) =>
        scene.type === 'ImageInsert' &&
        (scene as any).source === 'stock' &&
        typeof (scene as any).stockQuery === 'string' &&
        (scene as any).stockQuery.trim().length > 0 &&
        !(scene as any).videoSrc
    )

  if (eligible.length === 0 || !apiKey) {
    if (eligible.length > 0 && !apiKey) {
      console.warn('Stock video skipped: PEXELS_API_KEY is missing (scenes fall back to generate)')
    }
    return scenes
  }

  const outputDir = path.join(process.cwd(), 'public', 'stock')
  await mkdir(outputDir, { recursive: true })

  const result = [...scenes]
  // Sequential to keep the query cache coherent (same query reuses one file).
  for (const { scene, index } of eligible) {
    const query = (scene as any).stockQuery.trim()
    const hash = queryHash(query)
    try {
      let videoSrc = await findCachedClip(outputDir, hash)
      if (!videoSrc) {
        const link = await searchPexels(apiKey, query)
        if (!link) {
          console.warn(`Stock video: no Pexels result for "${query}" (${(scene as any).id})`)
          continue
        }
        const filePath = path.join(outputDir, `${hash}.mp4`)
        await downloadToFile(link, filePath)
        videoSrc = `/stock/${hash}.mp4`
      }
      result[index] = { ...(scene as any), videoSrc } as Scene
    } catch (error) {
      console.warn(
        `Stock video skipped for ${(scene as any).id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return result
}
