import { assertDomain } from '../domain/errors.ts'
import {
  OUTPUT_PRESETS,
} from '../domain/output-spec.ts'
import {
  assertProofModePlan,
  type ProofModePlan,
} from '../domain/proof-mode.ts'
import {
  createRenderInputSpec,
  type RenderInputSpecV1,
} from '../domain/render-input.ts'
import {
  compileProofModeRenderScene,
} from './compile-proof-mode-render-scene.ts'

const PRESENTER_ASSET_ID = 'primary-video'
const EVIDENCE_ASSET_ID = 'proof-evidence'
const PROOF_COMPOSITION = Object.freeze({
  id: 'apollo-video',
  version: 'v1',
  propsSchemaRef: 'apollo://render-props/apollo-video/v1',
})
const DEFAULT_PALETTE = Object.freeze({
  primary: '#FFB800',
  secondary: '#20202A',
  accent: '#FFB800',
  text: '#FFFFFF',
  background: '#050508',
})
const MODES_REQUIRING_PRESENTER = Object.freeze([
  'split-screen',
  'proof-card',
] as const)

export interface ProofModeRenderAsset {
  artifactId: string
  artifactKey: string
  kind: 'video' | 'image'
  sha256: string
  byteSize: number
}

export interface ProofModeRenderSubtitle {
  text: string
  fromFrame: number
  toFrame: number
  anchor: 'top' | 'middle' | 'bottom'
}

export interface CompileProofModeRenderInputRequest {
  plan: Readonly<ProofModePlan>
  projectVersionId: string
  renderer: Readonly<{ id: string; version: string; digest: string }>
  presenter: Readonly<ProofModeRenderAsset>
  evidence: Readonly<ProofModeRenderAsset>
  timelineDurationFrames?: number
  subtitles?: readonly Readonly<ProofModeRenderSubtitle>[]
  palette?: Readonly<Record<string, string>>
  stylePreset?: string
  subtitleStyle?: string
  gradePreset?: string
}

/**
 * Compiles one approved ProofMode plan into the RenderInput specification the
 * durable artifact-render operation consumes. The result is the same portable
 * contract the production worker leases, materializes and renders, so proof
 * presentations never depend on a renderer invoked outside the operation.
 */
export function compileProofModeRenderInput(
  input: CompileProofModeRenderInputRequest,
): RenderInputSpecV1 {
  assertProofModePlan(input.plan)
  const { plan } = input
  const output = OUTPUT_PRESETS[plan.format]
  assertDomain(
    Boolean(output),
    'INVALID_OUTPUT_SPEC',
    'Proof plan format has no output preset',
  )
  const minimumFrames =
    plan.timing.timelineEntryFrame + plan.timing.targetDurationFrames
  const durationInFrames =
    input.timelineDurationFrames ?? minimumFrames
  assertDomain(
    Number.isSafeInteger(durationInFrames) &&
      durationInFrames >= minimumFrames,
    'INVALID_RENDER_INPUT',
    'Proof render timeline is shorter than the planned presentation',
  )
  assertDomain(
    plan.sourceMediaType === 'video' || plan.sourceMediaType === 'image'
      ? input.evidence.kind === plan.sourceMediaType
      : true,
    'INVALID_RENDER_INPUT',
    'Proof evidence asset kind does not match the planned source media type',
  )
  assertDomain(
    !MODES_REQUIRING_PRESENTER.includes(
      plan.mode as (typeof MODES_REQUIRING_PRESENTER)[number],
    ) || input.presenter.kind === 'video',
    'INVALID_RENDER_INPUT',
    `Proof mode ${plan.mode} requires a presenter video asset`,
  )
  const scene = compileProofModeRenderScene({
    plan,
    evidenceAssetId: EVIDENCE_ASSET_ID,
    fps: output.fps,
    timelineDurationFrames: durationInFrames,
  })
  return createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: {
      id: input.renderer.id,
      version: input.renderer.version,
      digest: input.renderer.digest,
    },
    composition: { ...PROOF_COMPOSITION },
    plan: {
      id: plan.id,
      versionId: input.projectVersionId,
      hash: plan.planHash,
    },
    output: {
      ...output,
      id: `proof-${plan.format.replace(':', 'x')}-${plan.mode}`,
      durationInFrames,
    },
    assets: [
      {
        id: PRESENTER_ASSET_ID,
        artifactId: input.presenter.artifactId,
        artifactKey: input.presenter.artifactKey,
        kind: input.presenter.kind,
        role: 'presenter',
        ordinal: 0,
        sha256: input.presenter.sha256,
        byteSize: input.presenter.byteSize,
      },
      {
        id: EVIDENCE_ASSET_ID,
        artifactId: input.evidence.artifactId,
        artifactKey: input.evidence.artifactKey,
        kind: input.evidence.kind,
        role: 'proof-evidence',
        ordinal: 1,
        sha256: input.evidence.sha256,
        byteSize: input.evidence.byteSize,
      },
    ],
    props: {
      primaryVideoAssetId: PRESENTER_ASSET_ID,
      scenes: [scene],
      subtitles: input.subtitles ?? [],
      palette: input.palette ?? { ...DEFAULT_PALETTE },
      stylePreset: input.stylePreset ?? 'creator-clean',
      subtitleStyle: input.subtitleStyle ?? 'kinetic',
      gradePreset: input.gradePreset ?? 'natural',
    },
  })
}

export const PROOF_MODE_RENDER_ASSET_IDS = Object.freeze({
  presenter: PRESENTER_ASSET_ID,
  evidence: EVIDENCE_ASSET_ID,
})
