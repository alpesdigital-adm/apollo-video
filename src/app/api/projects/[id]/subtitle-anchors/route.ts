import { NextRequest, NextResponse } from 'next/server'
import { runSubtitleAnchors } from '@/lib/beat-vision'

/**
 * CAMADA 2 sob demanda: recalcula a âncora vertical de cada legenda a partir do
 * conteúdo real dos frames (vision sobre os thumbnails por batida) e regrava
 * subtitlesJson com o campo `anchor`. Serializado pelo lock 'anchors' interno.
 * Mesmo fluxo que o fire-and-forget do transcribe, exposto para projetos que já
 * têm legendas/thumbs.
 */
export async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const projectId = params.id

  try {
    const result = await runSubtitleAnchors(projectId)

    if (!result.ran) {
      const notFound = result.reason === 'Project not found'
      const busy = result.reason?.includes('already running')
      const status = notFound ? 404 : busy ? 409 : 400
      return NextResponse.json({ error: result.reason || 'Failed to compute anchors' }, { status })
    }

    return NextResponse.json({
      success: true,
      total: result.total,
      distribution: result.distribution,
      examples: result.examples
    })
  } catch (error) {
    console.error('Subtitle anchors error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to compute anchors' },
      { status: 500 }
    )
  }
}
