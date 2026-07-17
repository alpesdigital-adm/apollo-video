import { NextRequest, NextResponse } from 'next/server'
import { DIRECTOR_TOOL_DESCRIPTORS, executeDirectorTool } from '@/v2/agent/director-tools'

export async function GET() { return NextResponse.json({ tools: DIRECTOR_TOOL_DESCRIPTORS }) }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const services = {
      searchMedia: async (args: Readonly<Record<string, unknown>>) => ({ kind: 'media-search-request', args }),
      createStoryPlan: async (args: Readonly<Record<string, unknown>>) => ({ kind: 'story-plan-proposal', args }),
      proposeAsset: async (args: Readonly<Record<string, unknown>>) => ({ kind: 'asset-proposal', args }),
      evaluateCandidate: async (args: Readonly<Record<string, unknown>>) => ({ kind: 'candidate-evaluation-request', args }),
      proposePatch: async (args: Readonly<Record<string, unknown>>) => ({ kind: 'patch-proposal', args })
    }
    return NextResponse.json(await executeDirectorTool(body.call, body.context, services))
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Tool call inválida' }, { status: 400 }) }
}
