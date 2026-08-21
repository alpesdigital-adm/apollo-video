import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileProofModeRenderInput,
  PROOF_MODE_RENDER_ASSET_IDS,
} from '../../src/v2/application/compile-proof-mode-render-input.ts'
import {
  compileApolloVideoRenderProps,
} from '../../src/v2/application/compile-apollo-video-render-props.ts'
import {
  renderAuthorizedInputService,
} from '../../src/v2/application/render-authorized-input.ts'
import {
  runNextPublicOperationService,
} from '../../src/v2/application/run-public-operation-worker.ts'
import {
  createProofModeRun,
  PROOF_MODES,
  PROOF_MODE_VISUAL_GOLDENS,
} from '../../src/v2/domain/proof-mode.ts'
import {
  OUTPUT_ASPECT_RATIOS,
} from '../../src/v2/domain/output-spec.ts'

const hash = (character) => character.repeat(64)
const createdAt = '2026-07-29T15:30:00.000Z'
const RENDERER = Object.freeze({
  id: 'remotion',
  version: '4.0.489',
  digest: hash('8'),
})

function assets(mediaType) {
  return {
    presenter: {
      artifactId: 'artifact-proof-presenter',
      artifactKey: 'proof/presenter.mp4',
      kind: 'video',
      sha256: hash('6'),
      byteSize: 4_096,
    },
    evidence: {
      artifactId: 'artifact-proof-evidence',
      artifactKey:
        mediaType === 'image' ? 'proof/evidence.png' : 'proof/evidence.mp4',
      kind: mediaType === 'image' ? 'image' : 'video',
      sha256: hash('7'),
      byteSize: 2_048,
    },
  }
}

function fixture(input = {}) {
  const evaluation = {
    id: 'proof-integrity-evaluation-runtime',
    sequence: 1,
    proofNeedItemId: 'proof-need-item-runtime',
    proofNeedItemHash: hash('a'),
    proofNeedResolution: 'selected-evidence',
    selectedEvidenceId: 'evidence-runtime',
    selectedEvidenceHash: hash('b'),
    use: {
      includedContextRangeMs: [500, 4_500],
      includedAdjacentEvidenceIds: [],
    },
    comparisons: [],
    outcome: 'approved',
    allowedForAssembly: true,
    presentation: {
      schemaVersion: 'proof-integrity-presentation/v1',
      evidenceId: 'evidence-runtime',
      evidenceHash: hash('b'),
      requiredContextRangeMs: [500, 4_500],
      requiredAdjacentEvidenceIds: [],
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
    storyBlockId: 'story-block-runtime',
    claimId: 'claim-runtime',
    claimText: 'Conversão aumentou',
    claimKind: 'outcome',
    type: 'testimonial',
    function: 'build-trust',
    required: true,
    moment: {
      placement: 'existing-proof-block',
      afterStoryBlockId: 'story-block-runtime',
      proofStoryBlockId: 'story-block-proof-runtime',
      timelineFrame: 120,
      timelineMs: 4_000,
    },
    search: {},
    resolution: 'selected-evidence',
    selectedEvidence: {
      id: evaluation.selectedEvidenceId,
      evidenceHash: evaluation.selectedEvidenceHash,
      category: 'testimonial',
      sourceArtifactId: 'artifact-proof-runtime',
      sourceRangeMs: [1_000, 4_000],
      contextRangeMs: [500, 4_500],
      score: .98,
    },
    proofUnavailable: false,
    genericCardGenerated: false,
    itemHash: evaluation.proofNeedItemHash,
  }
  const proofNeedRun = {
    id: 'proof-need-run-runtime',
    workspaceId: 'workspace-proof-runtime',
    projectId: 'project-proof-runtime',
    batchId: 'batch-proof-runtime',
    targetRecipeId: 'recipe-proof-runtime',
    targetRecipeHash: hash('e'),
    items: [proofNeedItem],
    runHash: hash('f'),
  }
  return {
    id: input.id ?? 'proof-mode-run-runtime',
    workspaceId: proofNeedRun.workspaceId,
    projectId: proofNeedRun.projectId,
    proofIntegrityRun: {
      schemaVersion: 'proof-integrity-run/v1',
      policyVersion: 'proof-integrity-policy/v1',
      id: 'proof-integrity-run-runtime',
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
      createdByClientId: 'api-client-proof-runtime',
      createdAt,
      runHash: hash('1'),
    },
    proofNeedRun,
    sources: [{
      evaluation,
      proofNeedItem,
      sourceArtifactId: proofNeedItem.selectedEvidence.sourceArtifactId,
      sourceMediaType: input.sourceMediaType ?? 'video',
      contextRequired: input.contextRequired ?? false,
    }],
    formats: input.formats ?? [...OUTPUT_ASPECT_RATIOS],
    rhythm: input.rhythm ?? 'measured',
    overrides: input.overrides ?? [],
    createdByClientId: 'api-client-proof-runtime',
    createdAt,
  }
}

function planFor(mode, format, extra = {}) {
  const run = createProofModeRun(fixture({
    id: `proof-mode-run-${mode}`,
    formats: [format],
    sourceMediaType: mode === 'proof-card' ? 'image' : 'video',
    overrides: [{
      proofNeedItemId: 'proof-need-item-runtime',
      format,
      mode,
      expectedEvaluationHash: hash('d'),
    }],
    ...extra,
  }))
  return run.plans[0]
}

test('T-FR-132 keeps the fifteen format/mode combinations distinct without aliases', () => {
  assert.equal(PROOF_MODE_VISUAL_GOLDENS.length, 15)
  assert.equal(
    PROOF_MODE_VISUAL_GOLDENS.length,
    OUTPUT_ASPECT_RATIOS.length * PROOF_MODES.length,
  )
  assert.equal(
    new Set(PROOF_MODE_VISUAL_GOLDENS.map((golden) => golden.id)).size,
    15,
  )
  assert.equal(
    new Set(
      PROOF_MODE_VISUAL_GOLDENS.map((golden) => golden.layout.layoutHash),
    ).size,
    15,
    'every format/mode pair must produce its own layout — no aliased modes',
  )
  const treatments = new Map()
  for (const golden of PROOF_MODE_VISUAL_GOLDENS) {
    const { layout, mode } = golden
    treatments.set(
      mode,
      (treatments.get(mode) ?? new Set()).add(layout.backgroundTreatment),
    )
    if (mode === 'cutaway') {
      assert.equal(layout.presenterRegion, undefined, golden.id)
      assert.deepEqual(
        [
          layout.evidenceRegion.x,
          layout.evidenceRegion.y,
          layout.evidenceRegion.width,
          layout.evidenceRegion.height,
        ],
        [0, 0, layout.canvas.width, layout.canvas.height],
        `${golden.id} cutaway must fill the canvas`,
      )
    }
    if (mode === 'split-screen') {
      assert.ok(layout.presenterRegion, golden.id)
      assert.ok(
        layout.presenterRegion.width > 0 &&
          layout.presenterRegion.height > 0,
        golden.id,
      )
      const overlaps =
        layout.presenterRegion.x <
          layout.evidenceRegion.x + layout.evidenceRegion.width &&
        layout.evidenceRegion.x <
          layout.presenterRegion.x + layout.presenterRegion.width &&
        layout.presenterRegion.y <
          layout.evidenceRegion.y + layout.evidenceRegion.height &&
        layout.evidenceRegion.y <
          layout.presenterRegion.y + layout.presenterRegion.height
      assert.equal(overlaps, false, `${golden.id} split regions overlap`)
    }
    if (mode === 'proof-card') {
      assert.equal(layout.presenterRegion, undefined, golden.id)
      assert.ok(
        layout.evidenceRegion.width < layout.canvas.width &&
          layout.evidenceRegion.height < layout.canvas.height,
        `${golden.id} proof card must be inset`,
      )
    }
  }
  assert.deepEqual(
    [...treatments.entries()]
      .map(([mode, values]) => [mode, [...values]])
      .toSorted((left, right) => left[0].localeCompare(right[0])),
    [
      ['cutaway', ['source']],
      ['proof-card', ['solid']],
      ['split-screen', ['dimmed-source']],
    ],
  )
})

test('T-FR-132 compiles every format/mode pair into a distinct durable render input', () => {
  const inputs = []
  for (const mode of PROOF_MODES) {
    for (const format of OUTPUT_ASPECT_RATIOS) {
      const plan = planFor(mode, format)
      assert.equal(plan.mode, mode)
      assert.equal(plan.format, format)
      const media = assets(plan.sourceMediaType)
      const input = compileProofModeRenderInput({
        plan,
        projectVersionId: 'project-version-proof-runtime',
        renderer: RENDERER,
        presenter: media.presenter,
        evidence: media.evidence,
      })
      assert.equal(input.schemaVersion, 'render-input/v1')
      assert.equal(input.output.width, plan.layout.canvas.width)
      assert.equal(input.output.height, plan.layout.canvas.height)
      assert.equal(
        input.output.durationInFrames,
        plan.timing.timelineEntryFrame + plan.timing.targetDurationFrames,
      )
      assert.deepEqual(
        input.assets.map((asset) => [asset.id, asset.role, asset.ordinal]),
        [
          [PROOF_MODE_RENDER_ASSET_IDS.presenter, 'presenter', 0],
          [PROOF_MODE_RENDER_ASSET_IDS.evidence, 'proof-evidence', 1],
        ],
      )
      const scene = input.props.scenes[0]
      assert.equal(scene.type, 'proof-presentation')
      assert.equal(scene.props.mode, mode)
      assert.equal(scene.props.proofModePlanHash, plan.planHash)
      assert.equal(
        scene.props.evidenceAssetId,
        PROOF_MODE_RENDER_ASSET_IDS.evidence,
      )
      assert.equal(scene.props.attribution, scene.props.verbalAttribution)
      assert.deepEqual(scene.props.qualifiers, scene.props.verbalQualifiers)
      assert.equal(scene.fromFrame, plan.timing.timelineEntryFrame)
      assert.equal(
        scene.toFrame,
        plan.timing.timelineEntryFrame + plan.timing.targetDurationFrames,
      )
      const compiled = compileApolloVideoRenderProps({
        ...input,
        assets: input.assets.map((asset) => ({
          ...asset,
          uri: `file:///proof/${asset.id}`,
        })),
      })
      const compiledScene = compiled.scenes[0]
      assert.equal(compiledScene.props.evidenceSrc, `file:///proof/${PROOF_MODE_RENDER_ASSET_IDS.evidence}`)
      assert.equal('evidenceAssetId' in compiledScene.props, false)
      inputs.push([`${format}/${mode}`, input.inputHash])
    }
  }
  assert.equal(inputs.length, 15)
  assert.equal(
    new Set(inputs.map(([, value]) => value)).size,
    15,
    'each format/mode combination must produce its own render input hash',
  )
})

test('T-FR-132 manual override binds evaluation, mode, format, range and hash', () => {
  const override = {
    proofNeedItemId: 'proof-need-item-runtime',
    format: '9:16',
    mode: 'split-screen',
    expectedEvaluationHash: hash('d'),
  }
  const run = createProofModeRun(fixture({
    id: 'proof-mode-run-override',
    overrides: [override],
  }))
  const overridden = run.plans.filter((plan) =>
    plan.selection === 'manual-override')
  assert.equal(overridden.length, 1)
  const [plan] = overridden
  assert.equal(plan.format, '9:16')
  assert.equal(plan.mode, 'split-screen')
  assert.deepEqual(plan.reasonCodes, ['MANUAL_OVERRIDE'])
  assert.equal(plan.proofIntegrityEvaluationHash, override.expectedEvaluationHash)
  assert.equal(plan.proofNeedItemId, override.proofNeedItemId)
  assert.equal(plan.proofIntegrityEvaluationId, 'proof-integrity-evaluation-runtime')
  assert.deepEqual(plan.timing.sourceContextRangeMs, [500, 4_500])
  for (const other of run.plans.filter((candidate) =>
    candidate.format !== '9:16')) {
    assert.equal(
      other.selection,
      'automatic',
      'an override must not leak into another format',
    )
  }
  const input = compileProofModeRenderInput({
    plan,
    projectVersionId: 'project-version-proof-runtime',
    renderer: RENDERER,
    ...assets(plan.sourceMediaType),
  })
  const scene = input.props.scenes[0]
  assert.equal(scene.props.mode, 'split-screen')
  assert.equal(scene.props.proofModePlanId, plan.id)
  assert.equal(
    scene.props.sourceStartFrame,
    Math.round(plan.timing.sourceContextRangeMs[0] * input.output.fps / 1_000),
  )
  assert.ok(scene.props.presenterRegion)
  for (const stale of [hash('9'), hash('0'), `${hash('d').slice(0, 63)}e`]) {
    assert.throws(
      () => createProofModeRun(fixture({
        id: 'proof-mode-run-stale-override',
        overrides: [{ ...override, expectedEvaluationHash: stale }],
      })),
      /stale evaluation/,
      `divergent hash ${stale.slice(0, 8)} must be rejected`,
    )
  }
  assert.throws(
    () => createProofModeRun(fixture({
      id: 'proof-mode-run-unknown-item',
      overrides: [{ ...override, proofNeedItemId: 'proof-need-item-other' }],
    })),
    /without approved evidence/,
  )
})

test('T-FR-132 drives a proof render input through the durable artifact-render operation', async () => {
  const plan = planFor('cutaway', '9:16')
  const input = compileProofModeRenderInput({
    plan,
    projectVersionId: 'project-version-proof-runtime',
    renderer: RENDERER,
    ...assets(plan.sourceMediaType),
  })
  const materialized = Object.freeze({
    ...input,
    assets: Object.freeze(input.assets.map((asset) => Object.freeze({
      ...asset,
      uri: `file:///proof/${asset.id}`,
    }))),
  })
  const authorizationId = 'authorization-proof-runtime'
  const artifactId = 'artifact-proof-output'
  const manifestId = 'manifest-proof-output'
  const outputKey = 'workspaces/proof/9x16-cutaway.mp4'
  const receipt = Object.freeze({
    schemaVersion: 'materialized-render-input-receipt/v1',
    authorizationId,
    artifactId,
    manifestId,
    inputHash: materialized.inputHash,
    revalidationHash: hash('e'),
    assetCount: materialized.assets.length,
    revalidatedAt: createdAt,
    validUntil: '2026-07-29T16:30:00.000Z',
  })
  const rendered = []
  const render = renderAuthorizedInputService({
    materialize: async () => Object.freeze({
      receipt,
      getRenderInput: () => materialized,
      toJSON: () => receipt,
    }),
    renderer: {
      async recover() { return null },
      async stage(value, options) {
        rendered.push({ value, outputKey: options.outputKey })
        return Object.freeze({
          async commit() {
            return Object.freeze({
              schemaVersion: 'committed-render-receipt/v1',
              outputKey: options.outputKey,
              inputHash: value.inputHash,
              outputSha256: hash('5'),
              byteSize: 12_345,
              committedAt: createdAt,
            })
          },
          async discard() {},
        })
      },
    },
    outputKeyFor: () => outputKey,
  })
  const phases = []
  const heartbeats = []
  let checkpoint
  let status = 'queued'
  const operation = {
    id: 'operation-proof-runtime',
    workspaceId: 'workspace-proof-runtime',
    clientId: 'api-client-proof-runtime',
    type: 'artifact-render',
    status: 'queued',
    phase: 'materializing',
    attempt: 1,
    maxAttempts: 1,
    target: { type: 'media-artifact', id: artifactId, manifestId },
  }
  let claimed = false
  const worker = runNextPublicOperationService({
    operations: {
      async claimNext(request) {
        if (claimed || request.type !== 'artifact-render') return null
        claimed = true
        return {
          operation,
          context: {
            kind: 'artifact-render',
            authorizationId,
            inputHash: materialized.inputHash,
          },
          lease: {
            owner: request.leaseOwner,
            attempt: 1,
            heartbeatAt: request.now,
            expiresAt: request.leaseUntil,
          },
        }
      },
      async heartbeat(request) {
        heartbeats.push(request.leaseUntil)
        return true
      },
      async advancePhase(request) {
        phases.push(request.phase)
        return true
      },
      async succeed() {
        status = 'succeeded'
        return { operation: { ...operation, status } }
      },
      async failOrRetry() {
        status = 'failed'
        return { operation: { ...operation, status } }
      },
    },
    checkpoints: {
      async findByOperationId() { return checkpoint ?? null },
      async record(value) {
        checkpoint = value
        return { checkpoint: value, replayed: false }
      },
    },
    render,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
  })

  assert.deepEqual(await worker('worker-proof-runtime'), {
    operationId: 'operation-proof-runtime',
    status: 'succeeded',
  })
  assert.equal(status, 'succeeded')
  assert.deepEqual(phases, ['rendering', 'verifying', 'persisting'])
  assert.ok(heartbeats.length >= 2, 'lease must be renewed before each phase')
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].outputKey, outputKey)
  assert.equal(rendered[0].value.inputHash, input.inputHash)
  assert.equal(
    rendered[0].value.props.scenes[0].props.proofModePlanHash,
    plan.planHash,
    'the durable operation must render the compiled proof scene itself',
  )
  assert.equal(checkpoint.outputKey, outputKey)
  assert.equal(checkpoint.output.inputHash, input.inputHash)
})
