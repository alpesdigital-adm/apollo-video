import { assertDomain } from './errors.ts'

export const OUTPUT_ASPECT_RATIOS = ['9:16', '16:9', '4:5', '1:1', '21:9'] as const

export type OutputAspectRatio = (typeof OUTPUT_ASPECT_RATIOS)[number]

export interface NormalizedInsets {
  top: number
  right: number
  bottom: number
  left: number
}
export interface OutputSpec {
  schemaVersion: 1
  id: string
  locale: string
  aspectRatio: OutputAspectRatio
  width: number
  height: number
  fps: number
  safeArea: Readonly<NormalizedInsets>
  deliveryProfileId?: string
}

export type OutputSpecInput = Omit<OutputSpec, 'schemaVersion'>

const RATIO_VALUES: Readonly<Record<OutputAspectRatio, number>> = Object.freeze({
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '4:5': 4 / 5,
  '1:1': 1,
  '21:9': 21 / 9,
})

const DEFAULT_SAFE_AREA: Readonly<NormalizedInsets> = Object.freeze({
  top: 0.05,
  right: 0.05,
  bottom: 0.05,
  left: 0.05,
})

export const OUTPUT_PRESETS: Readonly<Record<OutputAspectRatio, Readonly<OutputSpecInput>>> =
  Object.freeze({
    '9:16': Object.freeze({
      id: 'preset-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      safeArea: DEFAULT_SAFE_AREA,
    }),
    '16:9': Object.freeze({
      id: 'preset-16x9',
      locale: 'pt-BR',
      aspectRatio: '16:9',
      width: 1920,
      height: 1080,
      fps: 30,
      safeArea: DEFAULT_SAFE_AREA,
    }),
    '4:5': Object.freeze({
      id: 'preset-4x5',
      locale: 'pt-BR',
      aspectRatio: '4:5',
      width: 1080,
      height: 1350,
      fps: 30,
      safeArea: DEFAULT_SAFE_AREA,
    }),
    '1:1': Object.freeze({
      id: 'preset-1x1',
      locale: 'pt-BR',
      aspectRatio: '1:1',
      width: 1080,
      height: 1080,
      fps: 30,
      safeArea: DEFAULT_SAFE_AREA,
    }),
    '21:9': Object.freeze({
      id: 'preset-21x9',
      locale: 'pt-BR',
      aspectRatio: '21:9',
      width: 2520,
      height: 1080,
      fps: 30,
      safeArea: DEFAULT_SAFE_AREA,
    }),
  })

function isFiniteNormalized(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < 0.5
}

export function validateOutputSpec(input: OutputSpecInput): void {
  assertDomain(input.id.trim().length > 0, 'INVALID_OUTPUT_SPEC', 'OutputSpec id is required')
  assertDomain(input.locale.trim().length > 0, 'INVALID_OUTPUT_SPEC', 'OutputSpec locale is required')
  assertDomain(
    OUTPUT_ASPECT_RATIOS.includes(input.aspectRatio),
    'INVALID_OUTPUT_SPEC',
    'Unsupported aspect ratio',
    { aspectRatio: input.aspectRatio },
  )
  assertDomain(
    Number.isInteger(input.width) && input.width > 0 && input.width % 2 === 0,
    'INVALID_OUTPUT_SPEC',
    'Output width must be a positive even integer',
    { width: input.width },
  )
  assertDomain(
    Number.isInteger(input.height) && input.height > 0 && input.height % 2 === 0,
    'INVALID_OUTPUT_SPEC',
    'Output height must be a positive even integer',
    { height: input.height },
  )
  assertDomain(
    Number.isInteger(input.fps) && input.fps >= 1 && input.fps <= 120,
    'INVALID_OUTPUT_SPEC',
    'FPS must be an integer between 1 and 120',
    { fps: input.fps },
  )

  const actualRatio = input.width / input.height
  const expectedRatio = RATIO_VALUES[input.aspectRatio]
  assertDomain(
    Math.abs(actualRatio - expectedRatio) <= 0.002,
    'INVALID_OUTPUT_SPEC',
    'Canvas dimensions do not match the declared aspect ratio',
    { actualRatio, expectedRatio, width: input.width, height: input.height },
  )

  const { top, right, bottom, left } = input.safeArea
  assertDomain(
    [top, right, bottom, left].every(isFiniteNormalized),
    'INVALID_OUTPUT_SPEC',
    'Safe-area insets must be normalized values from 0 inclusive to 0.5 exclusive',
    { safeArea: input.safeArea },
  )
  assertDomain(top + bottom < 1, 'INVALID_OUTPUT_SPEC', 'Vertical safe areas overlap')
  assertDomain(left + right < 1, 'INVALID_OUTPUT_SPEC', 'Horizontal safe areas overlap')
}

export function createOutputSpec(input: OutputSpecInput): Readonly<OutputSpec> {
  validateOutputSpec(input)

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    safeArea: Object.freeze({ ...input.safeArea }),
  })
}
