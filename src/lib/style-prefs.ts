import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

/**
 * Global subtitle-style preference (data/style-prefs.json), following the same
 * file-backed config pattern as brand-colors.ts. Single source of truth for the
 * subtitle preset applied to renders and the live player.
 */
export type SubtitleStyle =
  | 'kinetic'
  | 'karaoke-box'
  | 'karaoke-pill'
  | 'caps-stroke'
  | 'clean-color'

export const SUBTITLE_STYLES: SubtitleStyle[] = [
  'kinetic',
  'karaoke-box',
  'karaoke-pill',
  'caps-stroke',
  'clean-color'
]

export interface StylePrefs {
  subtitleStyle: SubtitleStyle
  // Pacote 5: alternating punch-in scale between silence cuts (disguises jump cuts).
  jumpCutPunchIns: boolean
}

const DEFAULT_PREFS: StylePrefs = {
  subtitleStyle: 'kinetic',
  jumpCutPunchIns: true
}

export function isValidSubtitleStyle(value: unknown): value is SubtitleStyle {
  return typeof value === 'string' && (SUBTITLE_STYLES as string[]).includes(value)
}

function getDataDir(): string {
  return path.join(process.cwd(), 'data')
}

function getPrefsPath(): string {
  return path.join(getDataDir(), 'style-prefs.json')
}

export function readStylePrefs(): StylePrefs {
  const filePath = getPrefsPath()
  if (!existsSync(filePath)) {
    return { ...DEFAULT_PREFS }
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      subtitleStyle: isValidSubtitleStyle(parsed?.subtitleStyle)
        ? parsed.subtitleStyle
        : DEFAULT_PREFS.subtitleStyle,
      jumpCutPunchIns:
        typeof parsed?.jumpCutPunchIns === 'boolean'
          ? parsed.jumpCutPunchIns
          : DEFAULT_PREFS.jumpCutPunchIns
    }
  } catch (error) {
    console.error('Failed to read style prefs:', error)
    return { ...DEFAULT_PREFS }
  }
}

export function writeStylePrefs(prefs: StylePrefs): void {
  const dataDir = getDataDir()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  writeFileSync(getPrefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
}
