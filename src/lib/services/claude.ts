/**
 * Claude analysis service for video content structure and design
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { getInsertStylePresetMeta } from '../style-presets'
import type { Transcription, SubtitleEntry, VideoFormat } from '../types/project'
import type { Scene, AnalysisResult, NarrativeRole, SceneType } from '../types/scene'

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

function createAnthropicClient(): Anthropic {
  const apiKey =
    readEnvFileValue(path.join(process.cwd(), '.env.local'), 'ANTHROPIC_API_KEY') ||
    readEnvFileValue(path.join(process.cwd(), '.env.local'), 'CLAUDE_API_KEY') ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing')
  }

  return new Anthropic({ apiKey })
}

function getAnthropicModelCandidates(): string[] {
  const configuredModel =
    readEnvFileValue(path.join(process.cwd(), '.env.local'), 'ANTHROPIC_MODEL') ||
    process.env.ANTHROPIC_MODEL

  return [
    configuredModel,
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307'
  ].filter(Boolean) as string[]
}

async function createMessageWithModelFallback(params: any) {
  const client = createAnthropicClient()
  let lastError: unknown

  for (const model of getAnthropicModelCandidates()) {
    try {
      return await client.messages.create({
        ...params,
        model
      })
    } catch (error) {
      lastError = error
      const status = (error as any)?.status
      const message = error instanceof Error ? error.message : String(error)
      const canTryNext =
        status === 404 ||
        message.includes('not_found_error') ||
        message.toLowerCase().includes('model')

      if (!canTryNext) {
        throw error
      }
    }
  }

  throw lastError
}

// Valid scene types for validation
const VALID_SCENE_TYPES: SceneType[] = [
  'FullScreen',
  'LowerThird',
  'Split',
  'SplitVertical',
  'Card',
  'Message',
  'Number',
  'Flow',
  'CTA',
  'StickFigures',
  'ImageInsert'
]

const VALID_VISUAL_ROLES = ['evidence', 'contrast', 'process', 'context', 'decision']
const VALID_NARRATIVE_ROLES: NarrativeRole[] = [
  'hook',
  'context',
  'proof',
  'process',
  'objection',
  'decision',
  'cta'
]

function inferNarrativeRole(startLeg: number, subtitleCount: number): NarrativeRole {
  if (subtitleCount <= 0) {
    return 'context'
  }

  const progress = startLeg / Math.max(1, subtitleCount - 1)
  if (progress <= 0.16) {
    return 'hook'
  }
  if (progress >= 0.86) {
    return 'cta'
  }

  return 'context'
}

function normalizeNarrativeRole(value: unknown, startLeg: number, subtitleCount: number): NarrativeRole {
  return VALID_NARRATIVE_ROLES.includes(value as NarrativeRole)
    ? (value as NarrativeRole)
    : inferNarrativeRole(startLeg, subtitleCount)
}

function limitCopy(value: unknown, maxChars: number): string {
  const text = String(value || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length <= maxChars) {
    return text
  }

  const slice = text.slice(0, maxChars - 1)
  const lastSpace = slice.lastIndexOf(' ')
  return `${slice.slice(0, lastSpace > 20 ? lastSpace : maxChars - 1).trim()}...`
}

function sanitizeSceneCopy(sceneData: any): any {
  switch (sceneData.type) {
    case 'FullScreen':
      sceneData.text = limitCopy(sceneData.text || sceneData.title, 70)
      sceneData.subtitle = sceneData.subtitle ? limitCopy(sceneData.subtitle, 70) : undefined
      delete sceneData.fontSize
      delete sceneData.color
      delete sceneData.bgColor
      break
    case 'LowerThird':
      sceneData.title = limitCopy(sceneData.title, 42)
      sceneData.subtitle = limitCopy(sceneData.subtitle, 70)
      break
    case 'Split':
      sceneData.topText = limitCopy(sceneData.topText || sceneData.title, 54)
      sceneData.bottomText = limitCopy(sceneData.bottomText || sceneData.content, 54)
      break
    case 'SplitVertical':
      sceneData.leftLabel = limitCopy(sceneData.leftLabel, 24)
      sceneData.rightLabel = limitCopy(sceneData.rightLabel, 24)
      sceneData.leftText = limitCopy(sceneData.leftText, 54)
      sceneData.rightText = limitCopy(sceneData.rightText, 54)
      break
    case 'Card':
      sceneData.title = limitCopy(sceneData.title, 48)
      sceneData.description = limitCopy(sceneData.description, 80)
      break
    case 'Message':
      sceneData.sender = limitCopy(sceneData.sender, 24)
      sceneData.message = limitCopy(sceneData.message, 80)
      break
    case 'Number':
      sceneData.value = limitCopy(sceneData.value, 22)
      sceneData.label = limitCopy(sceneData.label, 58)
      break
    case 'Flow':
      sceneData.steps = Array.isArray(sceneData.steps)
        ? sceneData.steps.slice(0, 4).map((step: unknown) => limitCopy(step, 42))
        : []
      break
    case 'CTA':
      sceneData.text = limitCopy(sceneData.text, 72)
      sceneData.highlight = limitCopy(sceneData.highlight, 54)
      break
    case 'StickFigures':
      sceneData.situation = limitCopy(sceneData.situation, 64)
      sceneData.caption = limitCopy(sceneData.caption, 84)
      break
    case 'ImageInsert':
      sceneData.layout = ['split-bottom', 'top-image-compact'].includes(sceneData.layout)
        ? sceneData.layout
        : 'full'
      sceneData.visualRole = VALID_VISUAL_ROLES.includes(sceneData.visualRole)
        ? sceneData.visualRole
        : 'context'
      sceneData.narrativeRole = VALID_NARRATIVE_ROLES.includes(sceneData.narrativeRole)
        ? sceneData.narrativeRole
        : 'context'
      sceneData.imagePrompt = limitCopy(sceneData.imagePrompt || sceneData.prompt || sceneData.description, 700)
      sceneData.imageAlt = limitCopy(sceneData.imageAlt || sceneData.imagePrompt, 120)
      sceneData.sourceText = limitCopy(sceneData.sourceText || sceneData.spokenText || sceneData.imageAlt, 220)
      delete sceneData.text
      delete sceneData.title
      delete sceneData.subtitle
      delete sceneData.description
      delete sceneData.message
      delete sceneData.value
      delete sceneData.label
      delete sceneData.topText
      delete sceneData.bottomText
      delete sceneData.leftText
      delete sceneData.rightText
      delete sceneData.situation
      delete sceneData.caption
      delete sceneData.steps
      break
  }

  return sceneData
}

function extractScenePrompt(sceneData: any): string {
  const values = [
    sceneData.imagePrompt,
    sceneData.prompt,
    sceneData.text,
    sceneData.title,
    sceneData.subtitle,
    sceneData.description,
    sceneData.message,
    sceneData.value,
    sceneData.label,
    sceneData.topText,
    sceneData.bottomText,
    sceneData.leftText,
    sceneData.rightText,
    sceneData.situation,
    sceneData.caption,
    ...(Array.isArray(sceneData.steps) ? sceneData.steps : [])
  ]

  return limitCopy(values.filter(Boolean).join(' '), 700)
}

/**
 * Analyze transcription to generate video scene structure
 * Uses Claude to determine narrative format, color palette, and scene breakdown
 * @param transcriptionText The transcribed text content
 * @param format Video format ('9:16' for vertical, '16:9' for horizontal)
 * @returns AnalysisResult with narrative format, palette, and scenes
 */
export async function analyzeContent(
  transcriptionText: string,
  format: VideoFormat,
  subtitles: SubtitleEntry[],
  stylePreset: string = 'creator-clean'
): Promise<AnalysisResult> {
  try {
    // For simplicity in the initial analysis, we'll work with the text
    // and generate a basic scene structure
    // In a full implementation, this would parse segments more carefully

    const styleMeta = getInsertStylePresetMeta(stylePreset)

    const systemPrompt = `You are an expert video editor and content analyst specializing in premium narrated social videos.
Your job is to choose a small number of visual insert moments and describe AI-generated images that make the narration feel more concrete, credible, and easier to understand.

Important constraints:
- Subtitles are the only text layer. Do not create text cards, word inserts, captions, labels, UI screenshots, charts with text, logos, typography, or readable writing inside image prompts.
- Output only ImageInsert scenes.
- Always use startLeg indices as 0-based integer positions from the numbered subtitle timeline.
- Use image inserts selectively. Target 50-60% of the natural visual opportunities, not every subtitle block.
- For videos around 60-90 seconds, output 4-6 ImageInsert scenes. For videos around 15-30 seconds, output 2-3 ImageInsert scenes. Never exceed 7 scenes unless the timeline has many distinct chapters.
- Keep at least 6-9 seconds between most insert starts unless there is a strong editorial reason.
- Set durationInSubtitles to 2-4.
- Prefer layout "split-bottom" for most AI-generated inserts so the speaker remains present. Use layout "top-image-compact" when the original talking-head video is a close-up selfie: image occupies the top 30%, video occupies the lower 70%. Use layout "full" only for a strong chapter change with a non-human or face-obscured visual. Avoid full-screen generated people, faces, or new "actors" that compete with the speaker.
- For vertical social platforms, assume the right rail and bottom third may be covered by TikTok/Reels/Shorts UI. Image inserts can occupy visual space, but subtitles must remain readable above them.
- Classify every insert with a narrativeRole: "hook", "context", "proof", "process", "objection", "decision", or "cta". These roles are editorial metadata only; do not force the whole video into a rigid ad formula.
- Prefer "proof", "process", "objection", and "decision" when the narration makes a claim, explains how something works, handles friction, or compares choices. Use "hook" only near the opening and "cta" only near the end.
- Each image must have a clear narrative job: "evidence" (makes the claim more believable), "contrast" (shows the difference between two choices), "process" (shows what is happening behind the scenes), "context" (sets the real-world situation), or "decision" (shows evaluation/tradeoff).
- The image should answer: "what concrete situation makes this spoken sentence true?" If it only decorates the sentence, do not use an insert there.
- Image prompts must be grounded, documentary/editorial, and plausibly real. Prefer imperfect real workspaces, business context, devices seen from a distance, notes, dashboards blurred beyond readability, or people making decisions. If people appear, prefer over-the-shoulder, hands, partial body, back view, or face out of frame.
- Avoid generic AI/stock visuals: empty roads, glowing search bars, abstract network nodes, perfect close-up hands typing, fake phone interfaces, isometric diagrams, surreal metaphors, studio product shots, obvious split-screen symbolism, plastic smiles, and anything that looks like a stock photo.
- Avoid literal on-screen text descriptions like "Google Ads" rendered as words. Represent concepts through real behavior and context instead.
- Selected visual style: ${styleMeta.name}. Follow this tone: ${styleMeta.analysisTone}.`

    const numberedSubtitles = subtitles
      .map((subtitle, index) => `${index}: [${subtitle.startTime.toFixed(2)}s] ${subtitle.text}`)
      .join('\n')

    const userPrompt = `Analyze this video transcription and create a detailed scene breakdown:

FORMAT: ${format}
VISUAL STYLE: ${styleMeta.name}

Full transcription text:
${transcriptionText}

Numbered subtitle timeline:
${numberedSubtitles}

Respond with a JSON object containing:
{
  "narrativeFormat": "A 1-2 sentence description of the overall narrative approach",
  "palette": {
    "primary": "#HEX color for main brand color",
    "secondary": "#HEX color for secondary elements",
    "accent": "#HEX color for highlights and CTAs",
    "background": "#HEX color for backgrounds",
    "text": "#HEX color for text"
  },
  "scenes": [
    {
      "id": "unique-scene-id",
      "type": "ImageInsert",
      "startLeg": 0,
      "durationInSubtitles": 2,
      "layout": "full, split-bottom, or top-image-compact",
      "narrativeRole": "one of: hook, context, proof, process, objection, decision, cta",
      "visualRole": "one of: evidence, contrast, process, context, decision",
      "imagePrompt": "Detailed AI image prompt with no text, no letters, no logos, and no UI",
      "imageAlt": "Short internal description",
      "sourceText": "The exact subtitle or short spoken phrase this insert supports"
    }
  ]
}

Scene count guidance:
- Prefer fewer, stronger image inserts.
- Keep subtitles as the continuous reading layer; inserts are contextual visual support only.
- imagePrompt should be 1-3 sentences, concrete enough for image generation, and must explicitly say "no text, no letters, no logos".
- Write prompts for credible B-roll stills, not metaphor posters. Use specific physical details: environment, subject, action, camera distance, lighting, and what should be blurred or abstracted.

Ensure the JSON is valid and complete.`

    // Call Claude API
    const message = await createMessageWithModelFallback({
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ]
    })

    // Extract the text content from the response
    const content = message.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude')
    }

    // Parse JSON from the response
    let analysisData: any
    try {
      // Extract JSON from the response (it might be wrapped in markdown code blocks)
      const jsonMatch = content.text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content.text]
      const jsonString = jsonMatch[1] || content.text
      analysisData = JSON.parse(jsonString)
    } catch (parseError) {
      throw new Error(`Failed to parse Claude's JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }

    // Validate and sanitize the scenes
    if (!Array.isArray(analysisData.scenes)) {
      throw new Error('Invalid scenes array in response')
    }

    const validatedScenes: Scene[] = analysisData.scenes.map((sceneData: any) => {
      // Validate scene type
      if (!VALID_SCENE_TYPES.includes(sceneData.type) || sceneData.type !== 'ImageInsert') {
        console.warn(`Unsupported analysis scene type: ${sceneData.type}, converting to ImageInsert`)
        sceneData = {
          ...sceneData,
          type: 'ImageInsert',
          layout: ['split-bottom', 'top-image-compact'].includes(sceneData.layout)
            ? sceneData.layout
            : 'full',
          imagePrompt: extractScenePrompt(sceneData)
        }
      }

      // Validate and clamp startLeg
      if (
        typeof sceneData.startLeg !== 'number' ||
        !Number.isFinite(sceneData.startLeg) ||
        sceneData.startLeg < 0 ||
        sceneData.startLeg >= subtitles.length
      ) {
        console.warn(`Invalid startLeg ${sceneData.startLeg}, clamping to valid range`)
      }
      sceneData.startLeg = Math.max(
        0,
        Math.min(Math.floor(Number(sceneData.startLeg) || 0), Math.max(0, subtitles.length - 1))
      )

      // Ensure durationInSubtitles is valid
      if (typeof sceneData.durationInSubtitles !== 'number' || sceneData.durationInSubtitles < 2) {
        sceneData.durationInSubtitles = 2
      }

      sceneData.durationInSubtitles = Math.min(Math.floor(sceneData.durationInSubtitles), 4)
      sceneData.narrativeRole = normalizeNarrativeRole(
        sceneData.narrativeRole,
        sceneData.startLeg,
        subtitles.length
      )
      if (!sceneData.imagePrompt) {
        const subtitle = subtitles[sceneData.startLeg]
        sceneData.imagePrompt = `Premium contextual visual inspired by this spoken moment: "${subtitle?.text || transcriptionText.slice(0, 160)}". No text, no letters, no logos.`
      }
      if (!sceneData.sourceText) {
        sceneData.sourceText = subtitles[sceneData.startLeg]?.text || ''
      }

      // Ensure startFrame and endFrame are not set (will be computed later)
      delete sceneData.startFrame
      delete sceneData.endFrame

      return sanitizeSceneCopy(sceneData) as Scene
    })

    return {
      narrativeFormat: analysisData.narrativeFormat || 'Professional video content',
      palette: analysisData.palette || {
        primary: '#0066FF',
        secondary: '#0052CC',
        accent: '#FF6B35',
        background: '#FFFFFF',
        text: '#000000'
      },
      scenes: validatedScenes
    }
  } catch (error) {
    throw new Error(`Content analysis failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Refine a single scene based on user feedback
 * @param scene The scene to refine
 * @param instruction The user's instruction for how to modify the scene
 * @returns The modified scene
 */
export async function refineScene(
  scene: Scene,
  instruction: string
): Promise<Scene> {
  try {
    const systemPrompt = `You are an expert video editor refining individual scenes in a video.
You must return a valid JSON object representing the refined scene.
Keep durationInSubtitles between 2 and 4 for readability.
For ImageInsert scenes, preserve or improve narrativeRole, visualRole, imagePrompt, imageAlt, and sourceText.`

    const userPrompt = `Refine this scene based on the user's instruction:

CURRENT SCENE:
${JSON.stringify(scene, null, 2)}

USER INSTRUCTION:
${instruction}

Return the modified scene as a complete, valid JSON object with all required fields for its type.`

    const message = await createMessageWithModelFallback({
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ]
    })

    const content = message.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude')
    }

    // Parse the JSON response
    let refinedScene: any
    try {
      const jsonMatch = content.text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content.text]
      const jsonString = jsonMatch[1] || content.text
      refinedScene = JSON.parse(jsonString)
    } catch (parseError) {
      throw new Error(`Failed to parse refined scene JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }

    // Validate startLeg (ensure it's a non-negative integer)
    if (
      typeof refinedScene.startLeg !== 'number' ||
      !Number.isFinite(refinedScene.startLeg) ||
      refinedScene.startLeg < 0
    ) {
      refinedScene.startLeg = scene.startLeg
    }
    refinedScene.startLeg = Math.max(0, Math.floor(refinedScene.startLeg))

    // Validate durationInSubtitles
    if (typeof refinedScene.durationInSubtitles !== 'number' || refinedScene.durationInSubtitles < 2) {
      refinedScene.durationInSubtitles = 2
    }
    refinedScene.durationInSubtitles = Math.min(Math.floor(refinedScene.durationInSubtitles), 4)

    // Validate scene type
    if (!VALID_SCENE_TYPES.includes(refinedScene.type)) {
      refinedScene.type = scene.type
    }

    if (refinedScene.type === 'ImageInsert') {
      refinedScene.narrativeRole = VALID_NARRATIVE_ROLES.includes(refinedScene.narrativeRole)
        ? refinedScene.narrativeRole
        : (scene as any).narrativeRole || 'context'
      refinedScene.visualRole = VALID_VISUAL_ROLES.includes(refinedScene.visualRole)
        ? refinedScene.visualRole
        : (scene as any).visualRole || 'context'
      refinedScene.sourceText = refinedScene.sourceText || (scene as any).sourceText || ''
    }

    return sanitizeSceneCopy(refinedScene) as Scene
  } catch (error) {
    throw new Error(`Scene refinement failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
