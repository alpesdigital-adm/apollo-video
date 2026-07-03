import fs from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import type { Scene } from '../types/scene'

/**
 * Pacote 3 — B-roll de vídeo.
 *
 * Anima os stills de IA já gerados (image-to-video via WaveSpeed) para as cenas
 * ImageInsert marcadas com `motion: true`. Falha/timeout de um clipe NUNCA quebra
 * o analyze: a cena simplesmente permanece com o still (fallback gracioso).
 *
 * Segue os mesmos padrões de auth/env do image-generation.ts (lê .env.local/.env).
 */

interface GenerateMotionOptions {
  projectId: string
  scenes: Scene[]
  format?: '9:16' | '16:9'
}

// WaveSpeed image-to-video (doc confirmada):
//   POST https://api.wavespeed.ai/api/v3/bytedance/seedance-2.0/image-to-video
//   auth: Authorization: Bearer <WAVESPEED_API_KEY>
//   poll: GET https://api.wavespeed.ai/api/v3/predictions/{id}/result
const WAVESPEED_HOST = 'https://api.wavespeed.ai'
const DEFAULT_I2V_MODEL = 'bytedance/seedance-2.0/image-to-video'
const CLIP_TIMEOUT_MS = 4 * 60 * 1000
const POLL_INTERVAL_MS = 4000

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

function getMaxMotionClips(): number {
  const raw = Number(getEnvValue('MAX_MOTION_CLIPS') || 3)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3
}

function getI2vModel(): string {
  return getEnvValue('WAVESPEED_I2V_MODEL') || DEFAULT_I2V_MODEL
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

/**
 * Turn a local /generated-images/... path into a data URI. The dev server is not
 * publicly reachable, so we cannot hand WaveSpeed a localhost URL — send the
 * bytes inline instead (WaveSpeed accepts data URIs for the `image` field).
 */
async function imagePathToDataUri(imagePath: string): Promise<string> {
  const absolute = path.join(process.cwd(), 'public', imagePath.replace(/^\//, ''))
  const buffer = await readFile(absolute)
  return `data:${mimeFromPath(absolute)};base64,${buffer.toString('base64')}`
}

function buildMotionPrompt(scene: Extract<Scene, { type: 'ImageInsert' }>): string {
  const base = (scene.imagePrompt || '').trim()
  return [
    base,
    'Subtle cinematic camera movement: slow parallax push-in, gentle drift, natural micro-motion in the scene.',
    'Keep it realistic and understated, no fast cuts, no morphing, no added text or logos.'
  ]
    .filter(Boolean)
    .join(' ')
}

async function submitI2vJob(apiKey: string, dataUri: string, prompt: string, format: '9:16' | '16:9'): Promise<string> {
  const response = await fetch(`${WAVESPEED_HOST}/api/v3/${getI2vModel()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      prompt,
      image: dataUri,
      duration: 5,
      aspect_ratio: format === '16:9' ? '16:9' : '9:16',
      resolution: '1080p',
      generate_audio: false
    })
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.message || payload?.error || `WaveSpeed submit failed (${response.status})`
    throw new Error(String(message))
  }

  const id = payload?.data?.id || payload?.id
  if (!id) {
    throw new Error('WaveSpeed submit returned no prediction id')
  }
  return String(id)
}

async function pollI2vResult(apiKey: string, id: string): Promise<string> {
  const deadline = Date.now() + CLIP_TIMEOUT_MS

  while (Date.now() < deadline) {
    const response = await fetch(`${WAVESPEED_HOST}/api/v3/predictions/${id}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    const payload = await response.json().catch(() => null)
    const data = payload?.data || payload
    const status = String(data?.status || '').toLowerCase()

    if (status === 'completed' || status === 'succeeded') {
      const output =
        (Array.isArray(data?.outputs) && data.outputs[0]) ||
        data?.output ||
        (Array.isArray(data?.output) && data.output[0])
      if (!output) {
        throw new Error('WaveSpeed completed with no output url')
      }
      return String(output)
    }

    if (status === 'failed' || status === 'error' || status === 'canceled') {
      throw new Error(`WaveSpeed job ${status}: ${data?.error || 'unknown error'}`)
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error('WaveSpeed job timed out')
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download clip (${response.status})`)
  }
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()))
}

async function generateClipForScene(
  apiKey: string,
  scene: Extract<Scene, { type: 'ImageInsert' }>,
  outputDir: string,
  projectId: string,
  format: '9:16' | '16:9'
): Promise<string> {
  const dataUri = await imagePathToDataUri(scene.imagePath as string)
  const prompt = buildMotionPrompt(scene)
  const id = await submitI2vJob(apiKey, dataUri, prompt, format)
  const outputUrl = await pollI2vResult(apiKey, id)

  const slug = String(scene.id).replace(/[^a-zA-Z0-9._-]/g, '-')
  const fileName = `${projectId}-scene-${slug}.mp4`.replace(/[^a-zA-Z0-9._-]/g, '-')
  const filePath = path.join(outputDir, fileName)
  await downloadToFile(outputUrl, filePath)

  return `/generated-videos/${fileName}`
}

/**
 * For each ImageInsert scene with `motion: true` and an `imagePath`, animate the
 * still into a ~5s vertical clip via WaveSpeed. Jobs run in parallel
 * (Promise.allSettled); any failure/timeout is a console.warn and the scene keeps
 * its still. Hard cap of MAX_MOTION_CLIPS (default 3) clips per video — extra
 * scenes keep the still and have their `motion` flag cleared.
 */
export async function generateMotionForScenes({
  projectId,
  scenes,
  format = '9:16'
}: GenerateMotionOptions): Promise<Scene[]> {
  const apiKey = getEnvValue('WAVESPEED_API_KEY')

  const eligibleIndexes = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(
      ({ scene }) =>
        scene.type === 'ImageInsert' &&
        (scene as any).motion === true &&
        Boolean((scene as any).imagePath) &&
        !(scene as any).videoSrc &&
        (scene as any).source !== 'stock'
    )
    .map(({ index }) => index)

  if (eligibleIndexes.length === 0) {
    return scenes
  }

  const maxClips = getMaxMotionClips()
  const selected = eligibleIndexes.slice(0, maxClips)
  const overflow = new Set(eligibleIndexes.slice(maxClips))

  const result: Scene[] = scenes.map((scene, index) => {
    // Cost cap: clear the motion flag on scenes beyond the cap so nothing
    // downstream tries to treat them as animated.
    if (overflow.has(index)) {
      return { ...(scene as any), motion: false } as Scene
    }
    return scene
  })

  if (!apiKey) {
    console.warn('Motion generation skipped: WAVESPEED_API_KEY is missing')
    return result
  }

  const outputDir = path.join(process.cwd(), 'public', 'generated-videos')
  await mkdir(outputDir, { recursive: true })

  const outcomes = await Promise.allSettled(
    selected.map((index) =>
      generateClipForScene(
        apiKey,
        result[index] as Extract<Scene, { type: 'ImageInsert' }>,
        outputDir,
        projectId,
        format
      )
    )
  )

  outcomes.forEach((outcome, i) => {
    const index = selected[i]
    const scene = result[index]
    if (outcome.status === 'fulfilled') {
      result[index] = { ...(scene as any), videoSrc: outcome.value } as Scene
    } else {
      console.warn(
        `Motion clip skipped for ${(scene as any).id}: ${
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        }`
      )
    }
  })

  return result
}
