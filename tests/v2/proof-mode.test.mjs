import assert from 'node:assert/strict'
import test from 'node:test'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'

import {
  createProofModeRun,
  hydrateProofModeRun,
  PROOF_MODE_POLICY_VERSION,
  PROOF_MODE_VISUAL_GOLDENS,
} from '../../src/v2/domain/proof-mode.ts'
import {
  stableSerialize,
} from '../../src/v2/domain/canonical-hash.ts'
import {
  createProofModeRunService,
} from '../../src/v2/application/proof-mode.ts'
import {
  compileProofModeRenderScene,
} from '../../src/v2/application/compile-proof-mode-render-scene.ts'
import {
  compileApolloVideoRenderProps,
} from '../../src/v2/application/compile-apollo-video-render-props.ts'
import {
  createRenderInputSpec,
} from '../../src/v2/domain/render-input.ts'
import {
  isProofPresentationActive,
} from '../../remotion/src/lib/proof-coordination.ts'

const hash = (character) => character.repeat(64)
const createdAt = '2026-07-29T15:30:00.000Z'

function authenticatedActor(workspaceId, clientId) {
  const credentialId = 'credential-proof-mode-service'
  const auditContext = createExternalAuditContext({ clientId, credentialId, workspaceId, environment: 'production' })
  return Object.freeze({
    clientId, credentialId, workspaceId, environment: 'production',
    scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function fixture(input = {}) {
  const evaluation = {
    id: 'proof-integrity-evaluation-mode',
    sequence: 1,
    proofNeedItemId: 'proof-need-item-mode',
    proofNeedItemHash: hash('a'),
    proofNeedResolution: 'selected-evidence',
    selectedEvidenceId: 'evidence-mode',
    selectedEvidenceHash: hash('b'),
    use: {
      includedContextRangeMs: [500, 4_500],
      includedAdjacentEvidenceIds: ['evidence-adjacent-mode'],
    },
    comparisons: [],
    outcome: 'approved',
    allowedForAssembly: true,
    presentation: {
      schemaVersion: 'proof-integrity-presentation/v1',
      evidenceId: 'evidence-mode',
      evidenceHash: hash('b'),
      requiredContextRangeMs: [500, 4_500],
      requiredAdjacentEvidenceIds: ['evidence-adjacent-mode'],
      visual: {
        attribution: 'Depoimento de Cliente A',
        qualifiers: ['Período: 2025'],
        mandatory: true,
      },
      verbal: {
        attribution: 'Depoimento de Cliente A',
        qualifiers: ['Período: 2025'],
        mandatory: true,
      },
      presentationHash: hash('c'),
    },
    fabricationSuggested: false,
    evaluatedAt: createdAt,
    evaluationHash: hash('d'),
  }
  const proofNeedItem = {
    id: evaluation.proofNeedItemId,
    sequence: 1,
    storyBlockId: 'story-block-mode',
    claimId: 'claim-mode',
    claimText: 'Conversão aumentou',
    claimKind: 'outcome',
    type: 'testimonial',
    function: 'build-trust',
    required: true,
    moment: {
      placement: 'existing-proof-block',
      afterStoryBlockId: 'story-block-mode',
      proofStoryBlockId: 'story-block-proof-mode',
      timelineFrame: 120,
      timelineMs: 4_000,
    },
    search: {},
    resolution: 'selected-evidence',
    selectedEvidence: {
      id: evaluation.selectedEvidenceId,
      evidenceHash: evaluation.selectedEvidenceHash,
      category: 'testimonial',
      sourceArtifactId: 'artifact-proof-mode',
      sourceRangeMs: [1_000, 4_000],
      contextRangeMs: [500, 4_500],
      score: .98,
    },
    proofUnavailable: false,
    genericCardGenerated: false,
    itemHash: evaluation.proofNeedItemHash,
  }
  const proofNeedRun = {
    id: 'proof-need-run-mode',
    workspaceId: 'workspace-proof-mode',
    projectId: 'project-proof-mode',
    batchId: 'batch-proof-mode',
    targetRecipeId: 'recipe-proof-mode',
    targetRecipeHash: hash('e'),
    items: [proofNeedItem],
    runHash: hash('f'),
  }
  const proofIntegrityRun = {
    schemaVersion: 'proof-integrity-run/v1',
    policyVersion: 'proof-integrity-policy/v1',
    id: 'proof-integrity-run-mode',
    workspaceId: proofNeedRun.workspaceId,
    projectId: proofNeedRun.projectId,
    batchId: proofNeedRun.batchId,
    targetRecipeId: proofNeedRun.targetRecipeId,
    targetRecipeHash: proofNeedRun.targetRecipeHash,
    proofNeedRunId: proofNeedRun.id,
    proofNeedRunHash: proofNeedRun.runHash,
    evaluations: [evaluation],
    summary: {
      evaluationCount: 1,
      approvedCount: 1,
      blockedCount: 0,
      notApplicableCount: 0,
      hardIssueCount: 0,
      fabricationSuggestionCount: 0,
      readyForAssembly: true,
    },
    createdByClientId: 'api-client-proof-mode',
    createdAt,
    runHash: hash('1'),
  }
  return {
    id: input.id ?? 'proof-mode-run-fixture',
    workspaceId: proofNeedRun.workspaceId,
    projectId: proofNeedRun.projectId,
    proofIntegrityRun,
    proofNeedRun,
    sources: [{
      evaluation,
      proofNeedItem,
      sourceArtifactId: proofNeedItem.selectedEvidence.sourceArtifactId,
      sourceMediaType: input.sourceMediaType ?? 'video',
      contextRequired: input.contextRequired ?? false,
    }],
    formats: input.formats ?? ['9:16', '16:9', '4:5', '1:1', '21:9'],
    rhythm: input.rhythm ?? 'measured',
    overrides: input.overrides ?? [],
    createdByClientId: 'api-client-proof-mode',
    createdAt,
  }
}

test('T-FR-132 builds exactly fifteen safe visual goldens', () => {
  assert.equal(PROOF_MODE_VISUAL_GOLDENS.length, 15)
  assert.equal(
    new Set(PROOF_MODE_VISUAL_GOLDENS.map((item) => item.id)).size,
    15,
  )
  for (const golden of PROOF_MODE_VISUAL_GOLDENS) {
    const { layout } = golden
    const inside = (rect) =>
      rect.x >= layout.safeRegion.x &&
      rect.y >= layout.safeRegion.y &&
      rect.x + rect.width <=
        layout.safeRegion.x + layout.safeRegion.width &&
      rect.y + rect.height <=
        layout.safeRegion.y + layout.safeRegion.height
    assert.equal(inside(layout.creditRegion), true, golden.id)
    assert.equal(inside(layout.qualifierRegion), true, golden.id)
    if (golden.mode === 'proof-card') {
      const overlaps = (left, right) =>
        !(
          left.x + left.width <= right.x ||
          right.x + right.width <= left.x ||
          left.y + left.height <= right.y ||
          right.y + right.height <= left.y
        )
      assert.equal(
        overlaps(layout.evidenceRegion, layout.qualifierRegion),
        false,
        golden.id,
      )
      assert.equal(
        overlaps(layout.evidenceRegion, layout.creditRegion),
        false,
        golden.id,
      )
    }
    assert.equal(layout.format, golden.format)
    assert.match(layout.layoutHash, /^[a-f0-9]{64}$/)
  }
})

test('T-FR-132 selects mode from media, format, rhythm and context', () => {
  const measuredVideo = createProofModeRun(fixture())
  assert.deepEqual(
    measuredVideo.plans.map((plan) => [plan.format, plan.mode]),
    [
      ['16:9', 'split-screen'],
      ['1:1', 'cutaway'],
      ['21:9', 'split-screen'],
      ['4:5', 'cutaway'],
      ['9:16', 'cutaway'],
    ],
  )
  assert.ok(
    measuredVideo.plans
      .filter((plan) => plan.mode === 'cutaway')
      .every((plan) =>
        plan.reasonCodes.includes('MEASURED_VISUAL_CUTAWAY') &&
        !plan.reasonCodes.includes('FAST_VISUAL_CUTAWAY')),
  )
  const contextual = createProofModeRun(fixture({
    id: 'proof-mode-run-contextual',
    contextRequired: true,
  }))
  assert.ok(contextual.plans.every((plan) =>
    plan.mode === 'split-screen'))
  const image = createProofModeRun(fixture({
    id: 'proof-mode-run-image',
    sourceMediaType: 'image',
  }))
  assert.ok(image.plans.every((plan) =>
    plan.mode === 'proof-card'))
  const audio = createProofModeRun(fixture({
    id: 'proof-mode-run-audio',
    sourceMediaType: 'audio',
  }))
  assert.ok(audio.plans.every((plan) =>
    plan.mode === 'proof-card'))
  const fast = createProofModeRun(fixture({
    id: 'proof-mode-run-fast',
    rhythm: 'fast',
  }))
  assert.ok(fast.plans.every((plan) => plan.mode === 'cutaway'))
})

test('T-FR-132 manual override is segment/format scoped and stale-safe', () => {
  const override = {
    proofNeedItemId: 'proof-need-item-mode',
    format: '9:16',
    mode: 'split-screen',
    expectedEvaluationHash: hash('d'),
  }
  const run = createProofModeRun(fixture({ overrides: [override] }))
  const changed = run.plans.filter((plan) =>
    plan.selection === 'manual-override')
  assert.equal(changed.length, 1)
  assert.equal(changed[0].format, '9:16')
  assert.equal(changed[0].mode, 'split-screen')
  assert.equal(run.summary.manualOverrideCount, 1)
  assert.throws(
    () => createProofModeRun(fixture({
      id: 'proof-mode-run-stale',
      overrides: [{
        ...override,
        expectedEvaluationHash: hash('9'),
      }],
    })),
    /stale evaluation/,
  )
  assert.throws(
    () => createProofModeRun(fixture({
      id: 'proof-mode-run-context-card',
      contextRequired: true,
      overrides: [{
        ...override,
        mode: 'proof-card',
      }],
    })),
    /cannot be reduced to a proof card/,
  )
})

test('T-FR-132 preserves integrity presentation and rejects tampering', () => {
  const run = createProofModeRun(fixture())
  assert.equal(run.policyVersion, PROOF_MODE_POLICY_VERSION)
  for (const plan of run.plans) {
    assert.equal(plan.claimText, 'Conversão aumentou')
    assert.deepEqual(
      plan.presentation.visual,
      plan.presentation.verbal,
    )
    assert.equal(plan.identificationRequired, true)
    assert.equal(plan.legibility.minimumContrast, 4.5)
    assert.equal(plan.rendererContract.materializesNewMedia, false)
    assert.ok(
      plan.timing.targetDurationFrames >=
        plan.timing.minimumDurationFrames,
    )
  }
  const hydrated = hydrateProofModeRun(
    JSON.parse(stableSerialize(run)),
  )
  assert.equal(hydrated.runHash, run.runHash)
  assert.throws(
    () => hydrateProofModeRun({
      ...JSON.parse(stableSerialize(run)),
      plans: [{
        ...run.plans[0],
        presentation: {
          ...run.plans[0].presentation,
          visual: {
            ...run.plans[0].presentation.visual,
            attribution: 'Crédito removido',
          },
        },
      }, ...run.plans.slice(1)],
    }),
    /plan 1 hash is invalid|plan 1 is invalid/,
  )
})

test('T-FR-132 application service binds current evidence and idempotency', async () => {
  const source = fixture({
    id: 'proof-mode-run-service',
    formats: ['9:16'],
  })
  let persistedInput
  const service = createProofModeRunService({
    repository: {
      findReplay: async () => null,
      create: async (input) => {
        persistedInput = input
        return {
          run: {
            ...input.run,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
          },
          replayed: false,
        }
      },
      read: async () => null,
      list: async () => ({ runs: [] }),
    },
    proofIntegrity: {
      findReplay: async () => null,
      create: async () => {
        throw new Error('not used')
      },
      read: async () => source.proofIntegrityRun,
      list: async () => ({ runs: [] }),
    },
    proofNeeds: {
      findReplay: async () => null,
      create: async () => {
        throw new Error('not used')
      },
      read: async () => source.proofNeedRun,
      list: async () => ({ runs: [] }),
    },
    evidenceSegments: {
      readCreationContext: async () => null,
      findReplay: async () => null,
      readCurrent: async () => ({
        evidence: {
          evidenceHash:
            source.sources[0].evaluation.selectedEvidenceHash,
          sourceArtifactId:
            source.sources[0].sourceArtifactId,
          requiresContext: false,
        },
        sourceMediaType: 'video',
      }),
      persist: async () => {
        throw new Error('not used')
      },
      search: async () => ({ candidates: [], rejected: [] }),
    },
    clock: () => new Date(createdAt),
    createRunId: () => source.id,
  })
  const result = await service({
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    proofIntegrityRunId: source.proofIntegrityRun.id,
    expectedProofIntegrityRunHash:
      source.proofIntegrityRun.runHash,
    policyVersion: PROOF_MODE_POLICY_VERSION,
    formats: ['9:16'],
    rhythm: 'measured',
    overrides: [],
    actor: authenticatedActor(source.workspaceId, source.createdByClientId),
    idempotencyKey: 'proof-mode-service-key',
  })
  assert.equal(result.replayed, false)
  assert.equal(result.run.plans.length, 1)
  assert.equal(result.run.plans[0].sourceMediaType, 'video')
  assert.equal(
    persistedInput.requestFingerprint.length,
    64,
  )
  assert.equal(
    persistedInput.idempotencyKey,
    'proof-mode-service-key',
  )
})

test('T-FR-132 compiles an integrity-bound proof plan into renderer props', () => {
  const run = createProofModeRun(fixture({
    id: 'proof-mode-run-render',
    formats: ['9:16'],
  }))
  const plan = run.plans[0]
  const scene = compileProofModeRenderScene({
    plan,
    evidenceAssetId: 'proof-evidence',
    fps: 30,
    timelineDurationFrames: 600,
  })
  const spec = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: {
      id: 'remotion',
      version: '4.0.489',
      digest: hash('8'),
    },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: {
      id: plan.id,
      versionId: 'project-version-proof-mode',
      hash: plan.planHash,
    },
    output: {
      id: 'proof-golden-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: plan.layout.canvas.width,
      height: plan.layout.canvas.height,
      fps: 30,
      safeArea: {
        top: .05,
        right: .05,
        bottom: .05,
        left: .05,
      },
      durationInFrames: 600,
    },
    assets: [
      {
        id: 'primary-video',
        artifactId: 'artifact-primary-proof-mode',
        artifactKey: 'proof/primary.mp4',
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: hash('6'),
        byteSize: 1_000,
      },
      {
        id: 'proof-evidence',
        artifactId: plan.sourceArtifactId,
        artifactKey: 'proof/evidence.mp4',
        kind: 'video',
        role: 'proof-evidence',
        ordinal: 1,
        sha256: hash('7'),
        byteSize: 1_000,
      },
    ],
    props: {
      primaryVideoAssetId: 'primary-video',
      scenes: [scene],
      subtitles: [],
      palette: {
        primary: '#FFB800',
        secondary: '#20202A',
        accent: '#FF6B35',
        text: '#FFFFFF',
        background: '#050508',
      },
    },
  })
  const compiled = compileApolloVideoRenderProps({
    ...spec,
    assets: spec.assets.map((asset) => ({
      ...asset,
      uri: `file:///materialized/${asset.id}`,
    })),
  })
  assert.equal(compiled.scenes[0].type, 'proof-presentation')
  assert.equal(
    compiled.scenes[0].props.evidenceSrc,
    'file:///materialized/proof-evidence',
  )
  assert.equal(
    compiled.scenes[0].props.evidenceAssetId,
    undefined,
  )
  assert.equal(
    compiled.scenes[0].props.proofModePlanHash,
    plan.planHash,
  )
  assert.throws(
    () => compileApolloVideoRenderProps({
      ...spec,
      assets: spec.assets.map((asset) => ({
        ...asset,
        uri: `file:///materialized/${asset.id}`,
      })),
      props: {
        ...spec.props,
        scenes: [{
          ...scene,
          props: {
            ...scene.props,
            canvas: { width: 1, height: 1 },
          },
        }],
      },
    }),
    /canvas or timing is invalid/,
  )
})

test('T-FR-132 suppresses subtitles for the entire proof window only', () => {
  const scenes = [{
    type: 'proof-presentation',
    from: 1,
    to: 3,
    fromFrame: 30,
    toFrame: 90,
    props: {},
  }]
  assert.equal(
    isProofPresentationActive(scenes, 29, 30),
    false,
  )
  assert.equal(
    isProofPresentationActive(scenes, 30, 30),
    true,
  )
  assert.equal(
    isProofPresentationActive(scenes, 89, 30),
    true,
  )
  assert.equal(
    isProofPresentationActive(scenes, 90, 30),
    false,
  )
})
