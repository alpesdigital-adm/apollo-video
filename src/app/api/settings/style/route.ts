import { NextRequest, NextResponse } from 'next/server'
import {
  isValidSubtitleStyle,
  isValidGradePreset,
  readStylePrefs,
  writeStylePrefs
} from '@/lib/style-prefs'

export async function GET() {
  return NextResponse.json(readStylePrefs())
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Merge onto current prefs so a partial update never wipes the other field.
    const current = readStylePrefs()
    const prefs = { ...current }

    if (body?.subtitleStyle !== undefined) {
      if (!isValidSubtitleStyle(body.subtitleStyle)) {
        return NextResponse.json({ error: 'subtitleStyle inválido' }, { status: 400 })
      }
      prefs.subtitleStyle = body.subtitleStyle
    }

    if (body?.jumpCutPunchIns !== undefined) {
      if (typeof body.jumpCutPunchIns !== 'boolean') {
        return NextResponse.json({ error: 'jumpCutPunchIns inválido' }, { status: 400 })
      }
      prefs.jumpCutPunchIns = body.jumpCutPunchIns
    }

    if (body?.gradePreset !== undefined) {
      if (!isValidGradePreset(body.gradePreset)) {
        return NextResponse.json({ error: 'gradePreset inválido' }, { status: 400 })
      }
      prefs.gradePreset = body.gradePreset
    }

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
