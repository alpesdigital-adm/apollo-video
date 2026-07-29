import { assertDomain } from '../domain/errors.ts'
import {
  assertProofModePlan,
  type ProofModePlan,
  type ProofModeRect,
} from '../domain/proof-mode.ts'

const ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/

export interface CompiledProofPresentationSceneV1 {
  type: 'proof-presentation'
  fromFrame: number
  toFrame: number
  props: Readonly<{
    schemaVersion: 'proof-presentation/v1'
    proofModePlanId: string
    proofModePlanHash: string
    proofNeedItemId: string
    mode: ProofModePlan['mode']
    sourceMediaType: ProofModePlan['sourceMediaType']
    evidenceAssetId: string
    sourceStartFrame: number
    claimText: string
    attribution: string
    qualifiers: readonly string[]
    verbalAttribution: string
    verbalQualifiers: readonly string[]
    contextRequired: boolean
    canvas: Readonly<{ width: number; height: number }>
    evidenceRegion: Readonly<ProofModeRect>
    presenterRegion?: Readonly<ProofModeRect>
    creditRegion: Readonly<ProofModeRect>
    qualifierRegion: Readonly<ProofModeRect>
    minimumFontPixels: number
    entryTransition: ProofModePlan['timing']['entryTransition']
    exitTransition: ProofModePlan['timing']['exitTransition']
  }>
}

export function compileProofModeRenderScene(input: {
  plan: Readonly<ProofModePlan>
  evidenceAssetId: string
  fps: number
  timelineDurationFrames: number
}): Readonly<CompiledProofPresentationSceneV1> {
  assertProofModePlan(input.plan)
  assertDomain(
    ASSET_ID.test(input.evidenceAssetId),
    'INVALID_RENDER_INPUT',
    'Proof evidence asset ID is invalid',
  )
  assertDomain(
    Number.isSafeInteger(input.fps) &&
      input.fps >= 1 &&
      input.fps <= 120 &&
      Number.isSafeInteger(input.timelineDurationFrames) &&
      input.timelineDurationFrames >= 1,
    'INVALID_RENDER_INPUT',
    'Proof render timeline is invalid',
  )
  const { plan } = input
  assertDomain(
    plan.layout.canvas.width >= 2 &&
      plan.layout.canvas.height >= 2,
    'INVALID_RENDER_INPUT',
    'Proof layout canvas is invalid',
  )
  const fromFrame = plan.timing.timelineEntryFrame
  const toFrame = fromFrame + plan.timing.targetDurationFrames
  assertDomain(
    fromFrame >= 0 &&
      toFrame <= input.timelineDurationFrames,
    'INVALID_RENDER_INPUT',
    'Proof presentation exceeds the render timeline',
  )
  const sourceStartFrame = Math.max(
    0,
    Math.round(
      plan.timing.sourceContextRangeMs[0] *
        input.fps /
        1_000,
    ),
  )
  return Object.freeze({
    type: 'proof-presentation',
    fromFrame,
    toFrame,
    props: Object.freeze({
      schemaVersion: 'proof-presentation/v1',
      proofModePlanId: plan.id,
      proofModePlanHash: plan.planHash,
      proofNeedItemId: plan.proofNeedItemId,
      mode: plan.mode,
      sourceMediaType: plan.sourceMediaType,
      evidenceAssetId: input.evidenceAssetId,
      sourceStartFrame,
      claimText: plan.claimText,
      attribution: plan.presentation.visual.attribution,
      qualifiers: plan.presentation.visual.qualifiers,
      verbalAttribution:
        plan.presentation.verbal.attribution,
      verbalQualifiers:
        plan.presentation.verbal.qualifiers,
      contextRequired: plan.contextRequired,
      canvas: plan.layout.canvas,
      evidenceRegion: plan.layout.evidenceRegion,
      ...(plan.layout.presenterRegion
        ? { presenterRegion: plan.layout.presenterRegion }
        : {}),
      creditRegion: plan.layout.creditRegion,
      qualifierRegion: plan.layout.qualifierRegion,
      minimumFontPixels: plan.legibility.minimumFontPixels,
      entryTransition: plan.timing.entryTransition,
      exitTransition: plan.timing.exitTransition,
    }),
  })
}
