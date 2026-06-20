export type InsertStylePreset = 'creator-clean' | 'editorial-bold' | 'minimal-glass'

export interface InsertStylePresetMeta {
  id: InsertStylePreset
  name: string
  description: string
  analysisTone: string
}

export const INSERT_STYLE_PRESETS: InsertStylePresetMeta[] = [
  {
    id: 'creator-clean',
    name: 'Creator Clean',
    description: 'Cards limpos, alto contraste e inserts discretos para videos narrados.',
    analysisTone:
      'clean creator video style, concise editorial cards, restrained motion, strong readability over talking-head footage'
  },
  {
    id: 'editorial-bold',
    name: 'Editorial Bold',
    description: 'Visual de revista digital, blocos fortes e chamadas mais marcantes.',
    analysisTone:
      'bold editorial magazine style, assertive short headlines, confident contrast, punchy but premium motion'
  },
  {
    id: 'minimal-glass',
    name: 'Minimal Glass',
    description: 'Vidro escuro, bordas sutis e menos interferencia sobre o rosto.',
    analysisTone:
      'minimal translucent glass style, quiet premium overlays, short captions, light visual footprint'
  }
]

export const DEFAULT_INSERT_STYLE_PRESET: InsertStylePreset = 'creator-clean'

export function normalizeInsertStylePreset(value: FormDataEntryValue | string | null | undefined): InsertStylePreset {
  const preset = typeof value === 'string' ? value : ''
  return INSERT_STYLE_PRESETS.some((item) => item.id === preset)
    ? (preset as InsertStylePreset)
    : DEFAULT_INSERT_STYLE_PRESET
}

export function getInsertStylePresetMeta(value: string | null | undefined): InsertStylePresetMeta {
  const preset = INSERT_STYLE_PRESETS.find((item) => item.id === value)
  return preset || INSERT_STYLE_PRESETS[0]
}
