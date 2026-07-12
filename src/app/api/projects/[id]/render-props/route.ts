import { NextRequest, NextResponse } from 'next/server'
import { startProjectRender } from '@/lib/services/remotion-render'

// Diagnóstico: monta o JSON de inputProps do estado ATUAL do projeto sem criar
// RenderJob, sem spawnar o Remotion e sem tocar no status — para renderizar
// stills de verificação. (O padrão antigo de disparar um render e matá-lo
// deixava o projeto marcado com "Render process exited with code 1".)
export async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const result = await startProjectRender(params.id, { propsOnly: true })
    return NextResponse.json({
      success: true,
      propsPath: result.propsPath,
      durationFrames: result.durationFrames
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'props build failed' },
      { status: 500 }
    )
  }
}
