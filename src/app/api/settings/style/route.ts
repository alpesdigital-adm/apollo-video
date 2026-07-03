import { NextRequest, NextResponse } from 'next/server'
import { isValidSubtitleStyle, readStylePrefs, writeStylePrefs } from '@/lib/style-prefs'

export async function GET() {
  return NextResponse.json(readStylePrefs())
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (!isValidSubtitleStyle(body?.subtitleStyle)) {
      return NextResponse.json(
        { error: 'subtitleStyle inválido' },
        { status: 400 }
      )
    }

    const prefs = { subtitleStyle: body.subtitleStyle }
    writeStylePrefs(prefs)

    return NextResponse.json(prefs)
  } catch (error) {
    console.error('Style prefs save error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao salvar estilo de legenda' },
      { status: 500 }
    )
  }
}
