import { NextRequest, NextResponse } from 'next/server'
import {
  isValidHexColor,
  readBrandColors,
  writeBrandColors,
  type BrandColorGroup,
  type BrandColorMode,
  type BrandColorsConfig
} from '@/lib/brand-colors'

const MAX_GROUPS = 8

function generateGroupId(): string {
  return `bcg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function validateGroup(raw: any, index: number): { group?: BrandColorGroup; error?: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `Grupo #${index + 1} inválido` }
  }

  const name = String(raw.name ?? '').trim()
  if (!name) {
    return { error: `Grupo #${index + 1}: informe um nome` }
  }

  const accent = String(raw.accent ?? '').trim()
  if (!isValidHexColor(accent)) {
    return { error: `Grupo "${name}": cor de destaque inválida (use #RGB ou #RRGGBB)` }
  }

  const group: BrandColorGroup = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateGroupId(),
    name,
    accent
  }

  for (const key of ['primary', 'background', 'text'] as const) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') {
      continue
    }
    const trimmed = String(value).trim()
    if (!isValidHexColor(trimmed)) {
      return { error: `Grupo "${name}": cor "${key}" inválida (use #RGB ou #RRGGBB)` }
    }
    group[key] = trimmed
  }

  return { group }
}

export async function GET() {
  const config = readBrandColors()
  return NextResponse.json(config)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (!Array.isArray(body.groups)) {
      return NextResponse.json({ error: 'groups deve ser uma lista' }, { status: 400 })
    }

    if (body.groups.length > MAX_GROUPS) {
      return NextResponse.json(
        { error: `Máximo de ${MAX_GROUPS} grupos de cores` },
        { status: 400 }
      )
    }

    const groups: BrandColorGroup[] = []
    for (let i = 0; i < body.groups.length; i++) {
      const { group, error } = validateGroup(body.groups[i], i)
      if (error) {
        return NextResponse.json({ error }, { status: 400 })
      }
      groups.push(group as BrandColorGroup)
    }

    const mode: BrandColorMode = body.mode === 'round-robin' ? 'round-robin' : 'ai-pick'

    const existing = readBrandColors()
    // Keep lastUsedIndex valid for the new group list; reset if out of range.
    const lastUsedIndex =
      Number.isInteger(existing.lastUsedIndex) && existing.lastUsedIndex < groups.length
        ? existing.lastUsedIndex
        : -1

    const config: BrandColorsConfig = { groups, mode, lastUsedIndex }
    writeBrandColors(config)

    return NextResponse.json(config)
  } catch (error) {
    console.error('Brand colors save error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao salvar cores da marca' },
      { status: 500 }
    )
  }
}
