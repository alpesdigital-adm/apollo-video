import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

export interface CreatorProfile {
  name: string
  handle: string
  avatarPath: string | null
}

const DEFAULT_PROFILE: CreatorProfile = {
  name: '',
  handle: '',
  avatarPath: null
}

function getDataDir(): string {
  return path.join(process.cwd(), 'data')
}

function getProfilePath(): string {
  return path.join(getDataDir(), 'creator-profile.json')
}

export function readCreatorProfile(): CreatorProfile {
  const filePath = getProfilePath()
  if (!existsSync(filePath)) {
    return { ...DEFAULT_PROFILE }
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      handle: typeof parsed.handle === 'string' ? parsed.handle : '',
      avatarPath: typeof parsed.avatarPath === 'string' ? parsed.avatarPath : null
    }
  } catch (error) {
    console.error('Failed to read creator profile:', error)
    return { ...DEFAULT_PROFILE }
  }
}

export function writeCreatorProfile(profile: CreatorProfile): void {
  const dataDir = getDataDir()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  writeFileSync(getProfilePath(), JSON.stringify(profile, null, 2), 'utf8')
}
