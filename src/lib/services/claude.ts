/**
 * Claude analysis service for video content structure and design
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Transcription, SubtitleEntry, VideoFormat } from '../types/project'
import type { Scene, AnalysisResult, SceneType } from '../types/scene'

// Initialize Anthropic client - uses ANTHROPIC_API_KEY env variable
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

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
  'StickFigures'
]

/**
 * Analyze transcription to generate video scene structure
 * Uses Claude to determine narrative format, color palette, and scene breakdown
 * @param transcriptionText The transcribed text content
 * @param format Video format ('9:16' for vertical, '16:9' for horizontal)
 * @returns AnalysisResult with narrative format, palette, and scenes
 */
export async function analyzeContent(
  transcriptionText: string,
  format: VideoFormat
): Promise<AnalysisResult> {
  try {
    // For simplicity in the initial analysis, we'll work with the text
    // and generate a basic scene structure
    // In a full implementation, this would parse segments more carefully

    const systemPrompt = `You are an expert video editor and content analyst specializing in creating engaging short-form video content.
Your task is to analyze video transcriptions and create detailed scene structures that:
- Hook viewers in the first 3 seconds (especially critical for vertical ${format === '9:16' ? 'mobile' : 'desktop'} format)
- Use varied scene types to maintain visual interest
- Build narrative momentum with strategic pacing
- Include a strong call-to-action (CTA) in the last 10 seconds
- Leverage scene types for maximum impact: FullScreen for emphasis, LowerThird for context, Split/SplitVertical for comparison, Card for data, Message for dialogue, Number for stats, Flow for processes, CTA for action, StickFigures for scenarios

Important constraints:
- Always use startLeg indices as 0-based integer positions
- Set durationInSubtitles to reasonable durations (1-5 for most scenes)
- For vertical format (${format === '9:16' ? 'YES' : 'NO'}), prioritize full-screen impact and readable text`

    const userPrompt = `Analyze this video transcription and create a detailed scene breakdown:

FORMAT: ${format}

Full transcription text:
${transcriptionText}

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
      "type": "one of: FullScreen, LowerThird, Split, SplitVertical, Card, Message, Number, Flow, CTA, StickFigures",
      "startLeg": 0,
      "durationInSubtitles": 2,
      ...scene-specific-fields
    }
  ]
}

Scene type specific fields:
- FullScreen: { text: string, fontSize?: number, color?: string, bgColor?: string }
- LowerThird: { title: string, subtitle: string }
- Split: { topText: string, bottomText: string }
- SplitVertical: { leftText: string, rightText: string, leftLabel?: string, rightLabel?: string }
- Card: { number: number, title: string, description: string, icon?: string }
- Message: { sender: string, message: string }
- Number: { value: string, label: string, prefix?: string, suffix?: string }
- Flow: { steps: string[] }
- CTA: { text: string, highlight: string }
- StickFigures: { situation: string, caption: string }

Ensure the JSON is valid and complete.`

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
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
      if (!VALID_SCENE_TYPES.includes(sceneData.type)) {
        console.warn(`Invalid scene type: ${sceneData.type}, defaulting to FullScreen`)
        sceneData.type = 'FullScreen'
      }

      // Validate and clamp startLeg
      if (typeof sceneData.startLeg !== 'number' || sceneData.startLeg < 0 || sceneData.startLeg >= subtitles.length) {
        console.warn(`Invalid startLeg ${sceneData.startLeg}, clamping to valid range`)
        sceneData.startLeg = Math.max(0, Math.min(sceneData.startLeg, subtitles.length - 1))
      }

      // Ensure durationInSubtitles is valid
      if (typeof sceneData.durationInSubtitles !== 'number' || sceneData.durationInSubtitles < 1) {
        sceneData.durationInSubtitles = 1
      }

      // Ensure startFrame and endFrame are not set (will be computed later)
      delete sceneData.startFrame
      delete sceneData.endFrame

      return sceneData as Scene
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
Keep durationInSubtitles as a positive integer.`

    const userPrompt = `Refine this scene based on the user's instruction:

CURRENT SCENE:
${JSON.stringify(scene, null, 2)}

USER INSTRUCTION:
${instruction}

Return the modified scene as a complete, valid JSON object with all required fields for its type.`

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
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
    if (typeof refinedScene.startLeg !== 'number' || refinedScene.startLeg < 0) {
      refinedScene.startLeg = Math.max(0, refinedScene.startLeg)
    }

    // Validate durationInSubtitles
    if (typeof refinedScene.durationInSubtitles !== 'number' || refinedScene.durationInSubtitles < 1) {
      refinedScene.durationInSubtitles = 1
    }

    // Validate scene type
    if (!VALID_SCENE_TYPES.includes(refinedScene.type)) {
      refinedScene.type = scene.type
    }

    return refinedScene as Scene
  } catch (error) {
    throw new Error(`Scene refinement failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
