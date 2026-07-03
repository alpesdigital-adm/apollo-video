/**
 * Server-only helpers for the audio asset layer (SFX + background music).
 *
 * Reads directly from public/audio/{sfx,music} via fs. Deterministic —
 * NEVER Math.random()/Date — so the same project always resolves to the
 * same background track, both in the browser player and in the headless
 * Remotion render.
 *
 * IMPORTANT: this module imports `fs` and must only be imported from
 * server-side code (API routes, remotion-render.ts). Do NOT import it from
 * src/lib/remotion/input-props.ts or any 'use client' component — that
 * would break the client bundle.
 */

import { existsSync, readdirSync } from 'fs'
import path from 'path'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a'])
const MUSIC_VOLUME = 0.1

function audioDir(sub: 'sfx' | 'music'): string {
  return path.join(process.cwd(), 'public', 'audio', sub)
}

function listAudioFiles(sub: 'sfx' | 'music'): string[] {
  try {
    return readdirSync(audioDir(sub))
      .filter((file) => AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .sort()
  } catch {
    return []
  }
}

export function listSfx(): string[] {
  return listAudioFiles('sfx')
}

export function listMusic(): string[] {
  return listAudioFiles('music')
}

export interface MusicPick {
  src: string
  volume: number
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * Deterministic background-track pick for a project, based on the files
 * currently present in public/audio/music (simple hash(projectId) % count —
 * no randomness, stable across renders/reloads). Returns null when the
 * folder is empty: no trilha = silence, not an error.
 */
export function pickMusicForProject(projectId: string): MusicPick | null {
  const files = listMusic()
  if (files.length === 0) return null
  const index = hashString(projectId) % files.length
  return { src: `/audio/music/${files[index]}`, volume: MUSIC_VOLUME }
}

/**
 * Whether a given SFX kind has a matching asset file on disk
 * (public/audio/sfx/<kind>.wav). Used to filter audio events whose asset is
 * missing before they reach the renderer/player.
 */
export function sfxAssetExists(kind: string): boolean {
  return existsSync(path.join(audioDir('sfx'), `${kind}.wav`))
}
