import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

export interface BrandColorGroup {
  id: string
  name: string
  accent: string
  primary?: string
  background?: string
  text?: string
}

export type BrandColorMode = 'ai-pick' | 'round-robin'

export interface BrandColorsConfig {
  groups: BrandColorGroup[]
  mode: BrandColorMode
  lastUsedIndex: number
}

const DEFAULT_CONFIG: BrandColorsConfig = {
  groups: [],
  mode: 'ai-pick',
  lastUsedIndex: -1
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim())
}

function getDataDir(): string {
  return path.join(process.cwd(), 'data')
}

function getColorsPath(): string {
  return path.join(getDataDir(), 'brand-colors.json')
}

function sanitizeGroup(raw: any): BrandColorGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const accent = typeof raw.accent === 'string' ? raw.accent.trim() : ''
  if (!id || !name || !isValidHexColor(accent)) return null

  const group: BrandColorGroup = { id, name, accent }
  if (isValidHexColor(raw.primary)) group.primary = raw.primary.trim()
  if (isValidHexColor(raw.background)) group.background = raw.background.trim()
  if (isValidHexColor(raw.text)) group.text = raw.text.trim()
  return group
}

export function readBrandColors(): BrandColorsConfig {
  const filePath = getColorsPath()
  if (!existsSync(filePath)) {
    return { ...DEFAULT_CONFIG, groups: [] }
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const groups = Array.isArray(parsed.groups)
      ? parsed.groups.map(sanitizeGroup).filter((g: BrandColorGroup | null): g is BrandColorGroup => g !== null)
      : []
    const mode: BrandColorMode = parsed.mode === 'round-robin' ? 'round-robin' : 'ai-pick'
    const lastUsedIndex = Number.isInteger(parsed.lastUsedIndex) ? parsed.lastUsedIndex : -1

    return { groups, mode, lastUsedIndex }
  } catch (error) {
    console.error('Failed to read brand colors:', error)
    return { ...DEFAULT_CONFIG, groups: [] }
  }
}

export function writeBrandColors(config: BrandColorsConfig): void {
  const dataDir = getDataDir()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  writeFileSync(getColorsPath(), JSON.stringify(config, null, 2), 'utf8')
}

/**
 * Pick a brand color group according to the config's round-robin cursor.
 * When `advance` is true, the picked index is persisted as the new
 * lastUsedIndex so the next call continues the rotation. Returns null when
 * there are no groups configured.
 */
export function pickBrandGroup(config: BrandColorsConfig, advance: boolean): BrandColorGroup | null {
  if (config.groups.length === 0) {
    return null
  }

  const nextIndex = (config.lastUsedIndex + 1) % config.groups.length
  const group = config.groups[nextIndex]

  if (advance) {
    writeBrandColors({ ...config, lastUsedIndex: nextIndex })
  }

  return group
}
