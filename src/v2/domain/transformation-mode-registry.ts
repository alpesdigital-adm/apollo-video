import { calculateCanonicalHash } from './canonical-hash.ts'
import { TRANSFORMATION_MODES, type TransformationFallback, type TransformationMode, type TransformationPreserve } from './transformation-brief.ts'

export const TRANSFORMATION_MODE_REGISTRY_VERSION = 'transformation-mode-registry/v1' as const

export interface TransformationModeContract {
  mode: TransformationMode
  providerCapability: string
  requiredInputs: readonly string[]
  outputMediaType: 'video'
  mandatoryPreserves: readonly TransformationPreserve[]
  risks: readonly string[]
  defaultFallbackLadder: readonly TransformationFallback[]
  requiresMask: boolean
  requiresCritic: boolean
  riskLevel: 1 | 2 | 3 | 4 | 5
}

function contract(value: TransformationModeContract): Readonly<TransformationModeContract> {
  return Object.freeze({
    ...value,
    requiredInputs: Object.freeze([...value.requiredInputs]),
    mandatoryPreserves: Object.freeze([...value.mandatoryPreserves]),
    risks: Object.freeze([...value.risks]),
    defaultFallbackLadder: Object.freeze([...value.defaultFallbackLadder]),
  })
}

export const TRANSFORMATION_MODE_CONTRACTS = Object.freeze({
  'camera-motion': contract({ mode: 'camera-motion', providerCapability: 'camera-motion', requiredInputs: ['source-video', 'motion-target'], outputMediaType: 'video', mandatoryPreserves: ['identity', 'speech', 'timing'], risks: ['crop', 'motion-sickness', 'safe-zone-violation'], defaultFallbackLadder: ['still-parallax', 'source-unchanged'], requiresMask: false, requiresCritic: true, riskLevel: 1 }),
  cutaway: contract({ mode: 'cutaway', providerCapability: 'generated-cutaway', requiredInputs: ['editorial-intent', 'duration'], outputMediaType: 'video', mandatoryPreserves: ['audio'], risks: ['semantic-mismatch', 'continuity'], defaultFallbackLadder: ['generated-cutaway', 'still-parallax', 'source-unchanged'], requiresMask: false, requiresCritic: true, riskLevel: 2 }),
  relight: contract({ mode: 'relight', providerCapability: 'relight', requiredInputs: ['source-video', 'lighting-target'], outputMediaType: 'video', mandatoryPreserves: ['identity', 'speech', 'wardrobe'], risks: ['flicker', 'identity-drift'], defaultFallbackLadder: ['source-unchanged'], requiresMask: false, requiresCritic: true, riskLevel: 3 }),
  stylization: contract({ mode: 'stylization', providerCapability: 'video-to-video', requiredInputs: ['source-video', 'style-target'], outputMediaType: 'video', mandatoryPreserves: ['timing', 'speech'], risks: ['identity-drift', 'flicker', 'anatomy'], defaultFallbackLadder: ['generated-cutaway', 'still-parallax', 'source-unchanged'], requiresMask: false, requiresCritic: true, riskLevel: 4 }),
  'background-replacement': contract({ mode: 'background-replacement', providerCapability: 'background-replace', requiredInputs: ['source-video', 'subject-mask', 'background-target'], outputMediaType: 'video', mandatoryPreserves: ['identity', 'lips', 'expression', 'body-motion', 'wardrobe', 'speech', 'foreground'], risks: ['composite-edges', 'lighting-mismatch', 'identity-drift'], defaultFallbackLadder: ['actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged'], requiresMask: true, requiresCritic: true, riskLevel: 4 }),
  'object-environment-change': contract({ mode: 'object-environment-change', providerCapability: 'video-to-video', requiredInputs: ['source-video', 'change-mask', 'environment-target'], outputMediaType: 'video', mandatoryPreserves: ['identity', 'speech'], risks: ['protected-object-change', 'hallucination', 'temporal-incoherence'], defaultFallbackLadder: ['actor-composite', 'generated-cutaway', 'source-unchanged'], requiresMask: true, requiresCritic: true, riskLevel: 5 }),
} satisfies Record<TransformationMode, TransformationModeContract>)

if (Object.keys(TRANSFORMATION_MODE_CONTRACTS).length !== TRANSFORMATION_MODES.length || TRANSFORMATION_MODES.some((mode) => !TRANSFORMATION_MODE_CONTRACTS[mode])) {
  throw new Error('Transformation mode registry is not exhaustive')
}

export const TRANSFORMATION_MODE_REGISTRY_HASH = calculateCanonicalHash({
  schemaVersion: TRANSFORMATION_MODE_REGISTRY_VERSION,
  contracts: TRANSFORMATION_MODES.map((mode) => TRANSFORMATION_MODE_CONTRACTS[mode]),
})
