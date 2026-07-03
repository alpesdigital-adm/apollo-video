import OpenAI from 'openai'
import fs from 'fs'
import { mkdir, readdir, writeFile } from 'fs/promises'
import path from 'path'
import type { Scene } from '../types/scene'

type ImageProvider = 'gemini' | 'openai'

interface GenerateImageInsertOptions {
  projectId: string
  scenes: Scene[]
  format: '9:16' | '16:9'
  stylePreset: string
  transcriptionText: string
  existingScenes?: Scene[]
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

function createOpenAIClient(): OpenAI {
  const apiKey = getEnvValue('OPENAI_API_KEY')
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing')
  }

  return new OpenAI({ apiKey })
}

function getGeminiApiKey(): string | null {
  return getEnvValue('GEMINI_API_KEY') || getEnvValue('GOOGLE_API_KEY')
}

function getImageProviderOrder(): ImageProvider[] {
  const configured = String(getEnvValue('IMAGE_GENERATION_PROVIDER') || 'auto').toLowerCase()

  if (configured === 'gemini' || configured === 'openai') {
    return [configured]
  }

  const providers: ImageProvider[] = []
  if (getGeminiApiKey()) {
    providers.push('gemini')
  }
  if (getEnvValue('OPENAI_API_KEY')) {
    providers.push('openai')
  }

  return providers
}

function getModelCandidates(): string[] {
  const candidates = [
    getEnvValue('OPENAI_IMAGE_MODEL'),
    'gpt-image-1'
  ].filter(Boolean) as string[]

  return [...new Set(candidates)]
}

function getGeminiModelCandidates(): string[] {
  const candidates = [
    getEnvValue('GEMINI_IMAGE_MODEL'),
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
    'gemini-2.5-flash-image-preview'
  ].filter(Boolean) as string[]

  return [...new Set(candidates)]
}

function getSizeCandidates(format: '9:16' | '16:9', layout: string): string[] {
  const configuredSize = getEnvValue('OPENAI_IMAGE_SIZE')
  const preferred =
    layout === 'top-image-compact'
      ? '1536x1024'
      : layout === 'split-bottom'
      ? '1024x1024'
      : format === '9:16'
        ? '1024x1536'
        : '1536x1024'

  return [
    configuredSize,
    preferred,
    '1024x1024'
  ].filter(Boolean) as string[]
}

function getStyleDirection(stylePreset: string): string {
  const directions: Record<string, string> = {
    'creator-clean':
      'documentary creator-video B-roll, natural light, believable real-world setting, useful visual context, polished but not glossy',
    'editorial-bold':
      'bold editorial documentary B-roll, strong composition, real business context, cinematic but not staged',
    'minimal-glass':
      'minimal premium documentary B-roll, restrained palette, subtle depth, realistic work context'
  }

  return directions[stylePreset] || directions['creator-clean']
}

function getRoleInstruction(role: string | undefined): string {
  const instructions: Record<string, string> = {
    evidence:
      'Narrative role: evidence. Show a concrete proof-like situation that makes the spoken claim feel credible, such as a real workspace, evaluation moment, or operational detail.',
    contrast:
      'Narrative role: contrast. Show two different user behaviors or business situations in the same realistic scene without making it look like a symbolic poster.',
    process:
      'Narrative role: process. Show the behind-the-scenes action or decision process that would happen in a real business.',
    decision:
      'Narrative role: decision. Show evaluation, tradeoff, or planning in a grounded way, with human presence or practical materials.',
    context:
      'Narrative role: context. Show the real-world situation behind the spoken sentence, with ordinary details that support the narration.'
  }

  return instructions[role || 'context'] || instructions.context
}

function getNarrativeRoleInstruction(role: string | undefined): string {
  const instructions: Record<string, string> = {
    hook:
      'Narrative position: opening hook. Support the first claim with a concrete visual that makes the viewer understand the stakes quickly, without adding a new character or fake interface.',
    context:
      'Narrative position: context. Ground the narration in a believable real-world situation and avoid over-explaining the sentence visually.',
    proof:
      'Narrative position: proof. Make the claim feel more credible through observable evidence, artifacts, process traces, or a realistic evaluation setting.',
    process:
      'Narrative position: process. Show the practical mechanism behind the spoken idea, as if captured during real work.',
    objection:
      'Narrative position: objection. Show the friction, interruption, cost, or hesitation behind the spoken idea without turning it into a dramatic metaphor.',
    decision:
      'Narrative position: decision. Show a grounded choice point, comparison, or tradeoff being evaluated in the real world.',
    cta:
      'Narrative position: call to action. Show the next practical step or outcome context without fake buttons, fake forms, or readable UI.'
  }

  return instructions[role || 'context'] || instructions.context
}

function buildPrompt(
  scene: Extract<Scene, { type: 'ImageInsert' }>,
  options: GenerateImageInsertOptions
): string {
  const layoutInstruction =
    scene.layout === 'top-image-compact'
      ? 'This image will be a compact top strip covering the upper 30% of a vertical talking-head video. Use a wide, simple composition with the important subject centered and no tiny details.'
      : scene.layout === 'split-bottom'
      ? 'This image will occupy the lower half of a vertical talking-head video. Keep the important action centered in the middle 70% with no tiny details.'
      : 'This image may briefly cover the whole frame in a narrated social video. It must be credible, grounded, and useful, not a metaphor poster.'

  return [
    `${options.format} social video visual insert.`,
    `Style: ${getStyleDirection(options.stylePreset)}.`,
    getNarrativeRoleInstruction(scene.narrativeRole),
    getRoleInstruction(scene.visualRole),
    layoutInstruction,
    scene.sourceText ? `Exact spoken phrase supported by this insert: "${scene.sourceText}".` : '',
    `Narration context: ${scene.imagePrompt}`,
    'Make it look like a plausible B-roll still from a real small-business marketing conversation, not generic stock photography and not an AI concept illustration.',
    'Avoid making a generated person or face the main subject. Prefer over-the-shoulder framing, hands, desk details, devices at a distance, or faces out of frame.',
    'If devices appear, screens must be softly blurred, abstract, over-the-shoulder, or out of focus; no readable interface, no fake app screenshot, no fake search bar.',
    'No text, no letters, no numbers, no logos, no watermarks, no captions, no charts with readable writing.',
    'Avoid empty roads, glowing UI, network-node graphics, isometric illustrations, perfect close-up hands typing, plastic smiles, surreal symbolism, and staged studio product shots.'
  ].join(' ')
}

async function downloadImageFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status})`)
  }

  return Buffer.from(await response.arrayBuffer())
}

async function generateOpenAIImageBuffer(prompt: string, format: '9:16' | '16:9', layout: string): Promise<Buffer> {
  const client = createOpenAIClient()
  let lastError: unknown

  for (const model of getModelCandidates()) {
    for (const size of getSizeCandidates(format, layout)) {
      const baseParams = {
        model,
        prompt,
        n: 1,
        size
      } as any

      for (const params of [
        { ...baseParams, response_format: 'b64_json' },
        baseParams
      ]) {
        try {
          const result = await client.images.generate(params)
          const image = result.data?.[0] as any

          if (image?.b64_json) {
            return Buffer.from(image.b64_json, 'base64')
          }

          if (image?.url) {
            return downloadImageFromUrl(image.url)
          }

          throw new Error('Image generation returned no image data')
        } catch (error) {
          lastError = error
          const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
          const canRetryWithoutResponseFormat =
            'response_format' in params &&
            (message.includes('response_format') || message.includes('unsupported parameter'))

          if (!canRetryWithoutResponseFormat) {
            break
          }
        }
      }
    }
  }

  throw new Error(`Image generation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function buildGeminiPrompt(prompt: string, format: '9:16' | '16:9', layout: string): string {
  const aspectRatio =
    layout === 'top-image-compact'
      ? 'wide horizontal image, roughly 3:1 crop-safe'
      : format === '9:16'
        ? 'vertical 9:16 crop-safe'
        : 'horizontal 16:9 crop-safe'

  return [
    prompt,
    `Output requirement: create one photorealistic editorial B-roll still image, ${aspectRatio}.`,
    'Do not add captions, text, UI labels, watermarks, logos, or poster-style graphic design.'
  ].join(' ')
}

async function generateGeminiImageBuffer(prompt: string, format: '9:16' | '16:9', layout: string): Promise<Buffer> {
  const apiKey = getGeminiApiKey()
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing')
  }

  let lastError: unknown
  for (const model of getGeminiModelCandidates()) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: buildGeminiPrompt(prompt, format, layout) }]
              }
            ],
            generationConfig: {
              responseModalities: ['IMAGE']
            }
          })
        }
      )
      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        const message =
          payload?.error?.message ||
          payload?.message ||
          `Gemini image request failed (${response.status})`
        throw Object.assign(new Error(message), { status: response.status })
      }

      const parts = (payload?.candidates || [])
        .flatMap((candidate: any) => candidate?.content?.parts || [])
      const inlineImage = parts.find((part: any) => part?.inlineData?.data || part?.inline_data?.data)
      const data = inlineImage?.inlineData?.data || inlineImage?.inline_data?.data

      if (data) {
        return Buffer.from(data, 'base64')
      }

      const fileData = parts.find((part: any) => part?.fileData?.fileUri || part?.file_data?.file_uri)
      const fileUri = fileData?.fileData?.fileUri || fileData?.file_data?.file_uri
      if (fileUri) {
        return downloadImageFromUrl(fileUri)
      }

      throw new Error('Gemini image generation returned no image data')
    } catch (error) {
      lastError = error
      const status = (error as any)?.status
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      const canTryNextModel =
        status === 404 ||
        status === 400 ||
        message.includes('not found') ||
        message.includes('model') ||
        message.includes('responsemodalities')

      if (!canTryNextModel) {
        break
      }
    }
  }

  throw new Error(`Gemini image generation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function generateImageBuffer(prompt: string, format: '9:16' | '16:9', layout: string): Promise<Buffer> {
  const providers = getImageProviderOrder()
  if (providers.length === 0) {
    throw new Error('No image generation provider configured. Add OPENAI_API_KEY or GEMINI_API_KEY.')
  }

  const errors: string[] = []
  for (const provider of providers) {
    try {
      return provider === 'gemini'
        ? await generateGeminiImageBuffer(prompt, format, layout)
        : await generateOpenAIImageBuffer(prompt, format, layout)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${provider}: ${message}`)
      console.warn(`Image provider ${provider} failed: ${message}`)
    }
  }

  throw new Error(`Image generation failed: ${errors.join(' | ')}`)
}

async function listReusableProjectImages(outputDir: string, projectId: string): Promise<string[]> {
  try {
    const files = await readdir(outputDir)
    return files
      .filter((file) => file.startsWith(`${projectId}-`) && /\.(png|jpg|jpeg|webp)$/i.test(file))
      .sort()
      .map((file) => `/generated-images/${file}`)
  } catch {
    return []
  }
}

function findReusableGeneratedImage(
  scene: Extract<Scene, { type: 'ImageInsert' }>,
  existingScenes: Scene[],
  reusableProjectImages: string[],
  index: number
): string | null {
  const sceneStartLeg = Number(scene.startLeg) || 0
  const sceneTokens = tokenizeReusableImageText([
    scene.id,
    scene.narrativeRole,
    scene.visualRole,
    scene.imagePrompt,
    scene.sourceText
  ].filter(Boolean).join(' '))
  const candidates = [
    ...existingScenes
      .filter((candidate): candidate is Extract<Scene, { type: 'ImageInsert' }> => (
        candidate.type === 'ImageInsert' && Boolean(candidate.imagePath)
      ))
      .map((candidate) => ({
        imagePath: candidate.imagePath || '',
        startLeg: Number(candidate.startLeg) || 0,
        visualRole: candidate.visualRole,
        layout: candidate.layout,
        reused: Boolean((candidate as any).reusedImagePath),
        index: null as number | null
      })),
    ...reusableProjectImages.map((imagePath, imageIndex) => ({
      imagePath,
      startLeg: null as number | null,
      visualRole: undefined,
      layout: undefined,
      reused: false,
      index: imageIndex
    }))
  ]

  const seen = new Set<string>()
  const matches = candidates
    .filter((candidate) => {
      if (!candidate.imagePath || seen.has(candidate.imagePath)) {
        return false
      }
      seen.add(candidate.imagePath)
      return true
    })
    .map((candidate) => {
      const candidateTokens = tokenizeReusableImageText(candidate.imagePath)
      const overlap = [...candidateTokens].filter((token) => sceneTokens.has(token)).length
      const positionPenalty =
        typeof candidate.startLeg === 'number'
          ? Math.min(6, Math.abs(candidate.startLeg - sceneStartLeg))
          : Math.min(4, Math.abs((candidate.index || 0) - index))

      return {
        imagePath: candidate.imagePath,
        score:
          positionPenalty +
          (candidate.visualRole && candidate.visualRole !== scene.visualRole ? 3 : 0) +
          (candidate.layout && candidate.layout !== scene.layout ? 2 : 0) +
          (candidate.reused ? 2 : 0) -
          overlap * 4
      }
    })
    .sort((a, b) => a.score - b.score)

  if (matches[0]?.imagePath) {
    return matches[0].imagePath
  }

  return reusableProjectImages[index] || null
}

function tokenizeReusableImageText(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4)
  )
}

export async function generateImageInsertAssets({
  projectId,
  scenes,
  format,
  stylePreset,
  transcriptionText,
  existingScenes = [],
}: GenerateImageInsertOptions): Promise<Scene[]> {
  const outputDir = path.join(process.cwd(), 'public', 'generated-images')
  await mkdir(outputDir, { recursive: true })
  const reusableProjectImages = await listReusableProjectImages(outputDir, projectId)

  const contextPrefix = transcriptionText.trim().slice(0, 280)

  const generatedScenes: Scene[] = []
  for (const [index, scene] of scenes.entries()) {
    // Skip non-inserts, already-generated stills, and inserts backed by a user
    // library asset (Pacote 4 — assetId was resolved to imagePath/videoSrc).
    if (scene.type !== 'ImageInsert' || scene.imagePath || (scene as any).assetId) {
      generatedScenes.push(scene)
      continue
    }

    const prompt = buildPrompt(
      {
        ...scene,
        imagePrompt: scene.imagePrompt || `Visual context for this narrated video: ${contextPrefix}`
      },
      { projectId, scenes, format, stylePreset, transcriptionText }
    )
    try {
      const buffer = await generateImageBuffer(prompt, format, scene.layout)
      const fileName = `${projectId}-${scene.id}.png`.replace(/[^a-zA-Z0-9._-]/g, '-')
      const filePath = path.join(outputDir, fileName)

      await writeFile(filePath, buffer)

      generatedScenes.push({
        ...scene,
        imagePrompt: scene.imagePrompt || prompt,
        imagePath: `/generated-images/${fileName}`
      })
    } catch (error) {
      const reusableImagePath = findReusableGeneratedImage(
        scene,
        existingScenes,
        reusableProjectImages,
        index
      )
      console.warn(
        `Image generation skipped for ${scene.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      generatedScenes.push({
        ...scene,
        imagePrompt: scene.imagePrompt || prompt,
        imagePath: reusableImagePath || undefined,
        reusedImagePath: Boolean(reusableImagePath),
        imageGenerationError: error instanceof Error ? error.message : String(error)
      } as Scene)
    }
  }

  return generatedScenes
}
