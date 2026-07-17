import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import type { MediaSegment } from '@/v2/domain/media-segment'

const filePath = () => path.join(process.cwd(), 'data', 'media-segments.json')

export function listStoredSegments(parentAssetId?: string): MediaSegment[] {
  if (!existsSync(filePath())) return []
  try { const parsed = JSON.parse(readFileSync(filePath(), 'utf8')); return (Array.isArray(parsed) ? parsed : []).filter((item) => !parentAssetId || item.parentAssetId === parentAssetId) } catch { return [] }
}

export function storeSegment(segment: MediaSegment): MediaSegment {
  const all = listStoredSegments().filter((item) => item.id !== segment.id)
  mkdirSync(path.dirname(filePath()), { recursive: true })
  writeFileSync(filePath(), JSON.stringify([segment, ...all], null, 2), 'utf8')
  return segment
}

export function getStoredSegment(id: string): MediaSegment | null { return listStoredSegments().find((item) => item.id === id) ?? null }
