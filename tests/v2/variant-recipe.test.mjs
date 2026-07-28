import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createVariantRecipeService,
} from '../../src/v2/application/variant-recipes.ts'
import {
  createVariantPortfolioPreflightService,
} from '../../src/v2/application/variant-portfolio-preflights.ts'
import { createCompatibilityGraph } from '../../src/v2/domain/compatibility-graph.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import {
  createScriptAlignmentRun,
  importScriptDocument,
} from '../../src/v2/domain/script-alignment.ts'
import { createTakeLibraryRun } from '../../src/v2/domain/take-library.ts'
import {
  createVariantPortfolioPolicy,
  createVariantPortfolioPreflight,
  hydrateVariantPortfolioPreflight,
} from '../../src/v2/domain/variant-portfolio-preflight.ts'
import {
  createVariantRecipe,
  hydrateVariantRecipe,
} from '../../src/v2/domain/variant-recipe.ts'
import {
  parseCreateVariantRecipeBody,
} from '../../src/v2/public-api/variant-recipe-contract.ts'
import {
  parseCreateVariantPortfolioPreflightBody,
} from '../../src/v2/public-api/variant-portfolio-preflight-contract.ts'
import {
  HmacPreflightCommitTokenIssuer,
} from '../../src/v2/infrastructure/security/preflight-commit-token.ts'

const lines = {
  hook: 'Pare agora e descubra o erro que bloqueia suas vendas',
  body: 'O metodo organiza sua mensagem para atrair clientes certos',
  proof: 'Mais de cem profissionais aplicaram o metodo com clareza',
  cta: 'Clique no botao e fale com nossa equipe no WhatsApp',
}

function graphFixture(
  id = 'recipe-graph-fixture',
  configuredBlocks,
) {
  const blocks = configuredBlocks ?? [
    { role: 'hook', text: lines.hook },
    { role: 'body', text: lines.body },
    { role: 'proof', text: lines.proof },
    { role: 'cta', text: lines.cta },
  ]
  const spoken = blocks.map((block) => block.text).join(' ')
  const words = spoken.split(/\s+/).map((word, index) => ({
    word,
    start: index * .25,
    end: index * .25 + .2,
  }))
  const transcript = createMediaTranscript({
    language: 'pt-BR',
    text: spoken,
    words,
    segments: [{
      id: 1,
      start: 0,
      end: words.at(-1).end,
      text: spoken,
      confidence: .98,
    }],
    provider: 'fixture',
    model: 'variant-recipe-v1',
  })
  const alignment = createScriptAlignmentRun({
    id: `alignment-${id}`,
    workspaceId: 'workspace-recipe',
    projectId: 'project-recipe',
    batchId: 'batch-recipe',
    document: importScriptDocument({
      title: 'Variant recipe',
      locale: 'pt-BR',
      rawText: blocks.map((block, index) =>
        `${block.role.toUpperCase()} ${index + 1}: ${block.text}.`,
      ).join('\n'),
    }),
    sources: [{
      transcriptId: 'transcript-recipe',
      sourceArtifactId: 'artifact-recipe-master',
      transcriptHash: transcript.transcriptHash,
      language: transcript.language,
      transcript,
    }],
    createdByClientId: 'client-recipe',
    createdAt: '2026-07-28T03:00:00.000Z',
  })
  const candidates = configuredBlocks
    ? alignment.alignments.flatMap((entry) =>
        entry.selectedCandidate ? [entry.selectedCandidate] : [])
    : [
        ...new Map(alignment.alignments.flatMap((entry) => [
          ...(entry.selectedCandidate ? [entry.selectedCandidate] : []),
          ...entry.alternatives,
        ]).map((candidate) => [candidate.id, candidate])).values(),
      ]
  const library = createTakeLibraryRun({
    id: `library-${id}`,
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations: candidates.map((candidate) => ({
      sourceKind: 'alignment-candidate',
      sourceId: candidate.id,
      expectedSourceHash: candidate.candidateHash,
      dimensions: [
        'completeness',
        'performance',
        'audio',
        'video',
        'integrity',
      ].map((dimension) => ({
        dimension,
        score: .95,
        evaluatorVersion: 'variant-recipe-golden/v1',
        evidenceRefs: [`recipe-${dimension}`],
      })),
    })),
    createdByClientId: 'client-recipe',
    createdAt: '2026-07-28T03:01:00.000Z',
  })
  const eligible = library.takes.filter((take) =>
    ['primary', 'alternate'].includes(take.status) &&
    ['hook', 'body', 'proof', 'cta'].includes(take.assignment.role))
  return createCompatibilityGraph({
    id,
    workspaceId: library.workspaceId,
    projectId: library.projectId,
    batchId: library.batchId,
    takeLibrary: library,
    contexts: eligible.map((take) => ({
      takeId: take.id,
      expectedTakeHash: take.takeHash,
      offerId: 'offer-apollo',
      audienceTags: ['especialistas'],
      claims: [{ key: 'resultado', value: 'clareza' }],
      personaId: 'persona-especialista',
      locale: 'pt-BR',
      desiredAction: 'whatsapp',
      continuityProvides: [`role-${take.assignment.role}`],
      continuityRequires: [],
      narrativeTags: ['lead-generation', 'clareza'],
      tone: .6,
      energy: .6,
      visual: .5,
      experiment: .5,
      evidenceRefs: [take.takeHash, take.sourceHash],
    })),
    createdByClientId: 'client-recipe',
    createdAt: '2026-07-28T03:02:00.000Z',
  })
}

function selection(graph, includeProof = true) {
  const node = (role) => graph.nodes.find((entry) =>
    entry.role === role)
  return {
    selection: {
      hookNodeId: node('hook').id,
      bodyNodeId: node('body').id,
      ...(includeProof ? { proofNodeId: node('proof').id } : {}),
      ctaNodeId: node('cta').id,
    },
    orderedNodeIds: [
      node('hook').id,
      node('body').id,
      ...(includeProof ? [node('proof').id] : []),
      node('cta').id,
    ],
  }
}

function createInput(graph, patch = {}) {
  return {
    id: `variant-recipe-${graph.id}`,
    workspaceId: graph.workspaceId,
    projectId: graph.projectId,
    batchId: graph.batchId,
    objective: 'lead-generation',
    compatibilityGraph: graph,
    ...selection(graph),
    assumptions: [{
      code: 'MESSAGE_ORDER_VERIFIED',
      statement: 'The accepted graph preserves the intended promise and action.',
      evidenceRefs: [graph.runHash],
    }],
    createdByClientId: 'client-recipe',
    createdAt: '2026-07-28T03:03:00.000Z',
    ...patch,
  }
}

test('T-FR-084 compiles a complete H+B+proof+CTA recipe with scores and exact order', () => {
  const graph = graphFixture('recipe-graph-complete')
  const recipe = createVariantRecipe(createInput(graph))
  assert.deepEqual(
    recipe.orderedNodeIds,
    Object.values(recipe.selection),
  )
  assert.equal(recipe.summary.selectedTakeCount, 4)
  assert.equal(recipe.summary.includesProof, true)
  assert.equal(recipe.compatibilityEdgeIds.length, 3)
  assert.equal(recipe.scores.dimensions.length, 4)
  assert.ok(recipe.scores.minimumEdgeScore >= 70)
  assert.ok(recipe.scores.totalScore >= 70)
})

test('T-FR-085 persists a bounded and diverse preflight without materializing the Cartesian product', () => {
  const graph = graphFixture('portfolio-preflight-graph')
  const policy = createVariantPortfolioPolicy({
    workspaceId: graph.workspaceId,
    defaultRecipeLimit: 1,
    maxRecipeLimit: 2,
    minHookCoverage: 1,
    minBodyCoverage: 1,
    minCtaCoverage: 1,
    updatedByClientId: 'client-recipe',
    updatedAt: '2026-07-28T03:03:00.000Z',
  })
  const run = createVariantPortfolioPreflight({
    id: 'portfolio-preflight-run',
    workspaceId: graph.workspaceId,
    projectId: graph.projectId,
    batchId: graph.batchId,
    objective: 'lead-generation',
    compatibilityGraph: graph,
    policy,
    requestedRecipeCount: 2,
    batchVariantCount: 2,
    budgetRemainingMinorUnits: 10_000,
    confirmationExpiresAt: '2026-07-28T03:20:00.000Z',
    existingRecipes: [],
    createdByClientId: 'client-recipe',
    createdAt: '2026-07-28T03:04:00.000Z',
  })

  assert.equal(run.theoreticalCandidateCount, '2')
  assert.equal(run.productMaterialized, false)
  assert.equal(run.estimates.jobsCreated, 0)
  assert.equal(run.confirmation.required, true)
  assert.equal(run.effectiveRecipeLimit, 1)
  assert.equal(run.selectedRecipeCount, 1)
  assert.equal(run.coverage.complete, true)
  assert.deepEqual(hydrateVariantPortfolioPreflight(run), run)

  const confirmed = createVariantPortfolioPreflight({
    ...run,
    id: 'portfolio-preflight-confirmed',
    compatibilityGraph: graph,
    policy,
    confirmationSatisfied: true,
    confirmationExpiresAt: undefined,
    budgetRemainingMinorUnits: 0,
    existingRecipes: [{
      recipeId: 'variant-recipe-reusable',
      orderedNodeIds: run.selected[0].orderedNodeIds,
      runHash: 'a'.repeat(64),
    }],
    createdAt: '2026-07-28T03:05:00.000Z',
  })
  assert.equal(confirmed.confirmation.satisfied, true)
  assert.equal(confirmed.confirmation.required, false)
  assert.equal(confirmed.estimates.reusedRecipeCount, 1)
  assert.equal(confirmed.estimates.estimatedCostMinorUnits, 0)
  assert.equal(confirmed.exclusions.budgetCount, 1)
  assert.ok(
    Number(confirmed.eligibleCandidateCount) >=
    confirmed.selectedRecipeCount,
  )
})

test('T-FR-085 counts 6 hooks x 3 bodies x 3 CTAs as 54 without building a Cartesian array', () => {
  const graph = graphFixture(
    'portfolio-preflight-54-graph',
    [
      ...[
        'Pare e descubra por que sua agenda continua vazia toda semana',
        'Existe um erro invisivel afastando seus melhores clientes hoje',
        'Voce ainda perde vendas por repetir esta abordagem ultrapassada',
        'A oportunidade mais simples do mercado esta diante dos seus olhos',
        'Poucos especialistas perceberam esta mudanca decisiva no comportamento',
        'Seu proximo cliente procura exatamente esta resposta neste momento',
      ].map((text) => ({ role: 'hook', text })),
      ...[
        'Nosso metodo organiza promessa mecanismo e evidencia em uma sequencia objetiva',
        'A estrategia conecta diagnostico posicionamento e oferta sem depender de improviso',
        'O processo transforma conhecimento disperso em uma mensagem comercial coerente',
      ].map((text) => ({ role: 'body', text })),
      ...[
        'Clique no botao abaixo e converse diretamente com nossa equipe especializada',
        'Preencha o formulario para receber uma analise personalizada do seu caso',
        'Agende sua conversa e escolha o melhor horario disponivel no calendario',
      ].map((text) => ({ role: 'cta', text })),
    ],
  )
  const policy = createVariantPortfolioPolicy({
    workspaceId: graph.workspaceId,
    defaultRecipeLimit: 5,
    maxRecipeLimit: 20,
    minHookCoverage: 3,
    minBodyCoverage: 3,
    minCtaCoverage: 3,
    maxRecipesPerSemanticCluster: 20,
    updatedByClientId: 'client-recipe',
    updatedAt: '2026-07-28T03:03:00.000Z',
  })
  const run = createVariantPortfolioPreflight({
    id: 'portfolio-preflight-54-run',
    workspaceId: graph.workspaceId,
    projectId: graph.projectId,
    batchId: graph.batchId,
    objective: 'lead-generation',
    compatibilityGraph: graph,
    policy,
    requestedRecipeCount: 20,
    batchVariantCount: 1,
    budgetRemainingMinorUnits: 10_000,
    confirmationExpiresAt: '2026-07-28T03:20:00.000Z',
    createdByClientId: 'client-recipe',
    createdAt: '2026-07-28T03:04:00.000Z',
  })
  assert.equal(run.theoreticalCandidateCount, '54')
  assert.equal(run.eligibleCandidateCount, '54')
  assert.equal(run.scannedCandidateCount, 54)
  assert.equal(run.selectedRecipeCount, 5)
  assert.equal(run.productMaterialized, false)
  assert.equal(run.estimates.jobsCreated, 0)
  assert.ok(run.coverage.achieved.hooks >= 3)
  assert.ok(run.coverage.achieved.bodies >= 3)
  assert.ok(run.coverage.achieved.ctas >= 3)
})

test('T-FR-085 application binds signed expansion confirmation to graph, policy, budget and actor', async () => {
  const graph = graphFixture('portfolio-preflight-service-graph')
  const stored = new Map()
  let policy
  let sequence = 0
  const repository = {
    async loadCreationContext(input) {
      assert.equal(
        input.expectedCompatibilityGraphRunHash,
        graph.runHash,
      )
      return {
        projectId: graph.projectId,
        objective: 'lead-generation',
        compatibilityGraph: graph,
        batchVariantCount: 2,
        budgetRemainingMinorUnits: 10_000,
        existingRecipes: [],
      }
    },
    async readPolicy() {
      return policy ?? null
    },
    async ensurePolicy(value) {
      policy = createVariantPortfolioPolicy({
        ...value,
        defaultRecipeLimit: 1,
        maxRecipeLimit: 2,
        minHookCoverage: 1,
        minBodyCoverage: 1,
        minCtaCoverage: 1,
      })
      return policy
    },
    async findCreateReplay({ idempotencyKey }) {
      return stored.get(idempotencyKey) ?? null
    },
    async create(record) {
      stored.set(record.idempotencyKey, {
        run: record.run,
        requestFingerprint: record.requestFingerprint,
      })
      return { run: record.run, replayed: false }
    },
  }
  const issuer = new HmacPreflightCommitTokenIssuer(
    'variant-portfolio-test-secret-32-bytes-minimum',
  )
  const service = createVariantPortfolioPreflightService({
    repository,
    tokenIssuer: issuer,
    clock: () => new Date('2026-07-28T03:10:00.000Z'),
    createRunId: () =>
      `portfolio-preflight-service-${++sequence}`,
  })
  const request = {
    workspaceId: graph.workspaceId,
    batchId: graph.batchId,
    compatibilityGraphId: graph.id,
    expectedCompatibilityGraphRunHash: graph.runHash,
    requestedRecipeCount: 2,
    actor: { type: 'api-client', id: 'client-recipe' },
  }
  const initial = await service({
    ...request,
    idempotencyKey: 'portfolio-initial-key',
  })
  assert.equal(initial.run.confirmation.required, true)
  assert.ok(initial.confirmationToken)
  assert.equal(initial.run.estimates.jobsCreated, 0)

  const confirmed = await service({
    ...request,
    confirmationToken: initial.confirmationToken,
    idempotencyKey: 'portfolio-confirm-key',
  })
  assert.equal(confirmed.run.confirmation.required, false)
  assert.equal(confirmed.run.confirmation.satisfied, true)
  assert.equal(confirmed.run.effectiveRecipeLimit, 2)

  await assert.rejects(
    () => service({
      ...request,
      requireProof: true,
      confirmationToken: initial.confirmationToken,
      idempotencyKey: 'portfolio-stale-key',
    }),
    /no longer matches|hash is stale/,
  )
})

test('T-FR-085 public preflight contract is exact and never accepts caller-side confirmation booleans', () => {
  const graph = graphFixture('portfolio-preflight-contract-graph')
  assert.deepEqual(
    parseCreateVariantPortfolioPreflightBody({
      compatibilityGraphId: graph.id,
      expectedCompatibilityGraphRunHash: graph.runHash,
      requestedRecipeCount: 12,
      requireProof: true,
    }),
    {
      compatibilityGraphId: graph.id,
      expectedCompatibilityGraphRunHash: graph.runHash,
      requestedRecipeCount: 12,
      requireProof: true,
    },
  )
  assert.throws(
    () => parseCreateVariantPortfolioPreflightBody({
      compatibilityGraphId: graph.id,
      expectedCompatibilityGraphRunHash: graph.runHash,
      requestedRecipeCount: 50,
      confirmedExpansion: true,
    }),
    /unexpected fields/,
  )
})

test('T-FR-084 compiles a short proofless recipe only for an objective allowed by versioned policy', () => {
  const graph = graphFixture('recipe-graph-short')
  const recipe = createVariantRecipe(createInput(graph, {
    ...selection(graph, false),
  }))
  assert.equal(recipe.summary.selectedTakeCount, 3)
  assert.equal(recipe.summary.includesProof, false)
  assert.equal(recipe.proofPolicy.effectiveRequirement, 'optional')
  assert.ok(recipe.assumptions.some((entry) =>
    entry.code === 'PROOF_OMITTED_BY_POLICY'))
  assert.throws(
    () => createVariantRecipe(createInput(graph, {
      id: 'variant-recipe-sale-without-proof',
      objective: 'sale',
      ...selection(graph, false),
    })),
    /requires proof/,
  )
})

test('T-FR-084 records lineage to every ScriptBlock, take and immutable source segment', () => {
  const graph = graphFixture('recipe-graph-lineage')
  const recipe = createVariantRecipe(createInput(graph))
  assert.equal(recipe.lineage.length, 4)
  assert.ok(recipe.lineage.every((entry) =>
    entry.usage === 'primary' &&
    entry.scriptBlockId &&
    entry.takeId &&
    entry.takeHash &&
    entry.sourceSegmentId &&
    entry.sourceHash &&
    entry.lineageHash))
  assert.equal(recipe.scores.lineageCompletenessScore, 100)
})

test('T-FR-084 compiles StoryPlan and EditPlan by reference without duplicating masters', () => {
  const graph = graphFixture('recipe-graph-compiled')
  const recipe = createVariantRecipe(createInput(graph))
  assert.equal(recipe.storyPlan.blocks.length, 4)
  assert.equal(recipe.editPlan.videoTracks[0].clips.length, 4)
  assert.equal(recipe.editPlan.masterReferences.length, 1)
  assert.equal(recipe.editPlan.materializesSources, false)
  assert.equal(recipe.editPlan.duplicatesMasters, false)
  assert.equal(
    recipe.editPlan.videoTracks[0].clips.at(-1)
      .timelineRangeFrames[1],
    recipe.editPlan.durationFrames,
  )
})

test('T-FR-084 supports a bounded cold open and rejects tampered compiled lineage', () => {
  const graph = graphFixture('recipe-graph-cold-open')
  const proof = graph.nodes.find((node) => node.role === 'proof')
  const recipe = createVariantRecipe(createInput(graph, {
    coldOpen: {
      nodeId: proof.id,
      sourceRangeMs: [
        proof.sourceRangeMs[0],
        Math.min(proof.sourceRangeMs[1], proof.sourceRangeMs[0] + 900),
      ],
      returnAtRole: 'hook',
    },
  }))
  assert.equal(recipe.summary.hasColdOpen, true)
  assert.equal(recipe.coldOpen.returnAtRole, 'hook')
  assert.equal(
    recipe.coldOpen.sourceSegmentId,
    recipe.sourceSegments[0].id,
  )
  assert.match(recipe.coldOpen.coldOpenHash, /^[a-f0-9]{64}$/)
  assert.equal(recipe.lineage[0].usage, 'cold-open')
  assert.equal(recipe.storyPlan.blocks[0].presentation, 'cold-open-reference')
  assert.equal(recipe.editPlan.videoTracks[0].clips.length, 5)
  assert.doesNotThrow(() => hydrateVariantRecipe(recipe))
  assert.throws(
    () => hydrateVariantRecipe({
      ...recipe,
      editPlan: {
        ...recipe.editPlan,
        duplicatesMasters: true,
      },
    }),
    /invalid envelope/,
  )
  assert.throws(
    () => createVariantRecipe(createInput(graph, {
      coldOpen: {
        nodeId: proof.id,
        sourceRangeMs: [
          proof.sourceRangeMs[0],
          proof.sourceRangeMs[0] + 900,
        ],
        returnAtRole: 'body',
      },
    })),
    /must be hook/,
  )
})

test('T-FR-084 public contract is exact and restricts cold-open return semantics', () => {
  const graph = graphFixture('recipe-graph-contract')
  const selected = selection(graph)
  const parsed = parseCreateVariantRecipeBody({
    compatibilityGraphId: graph.id,
    expectedCompatibilityGraphRunHash: graph.runHash,
    ...selected,
    assumptions: [{
      code: 'CONTRACT_EVIDENCE',
      statement: 'Contract fixture preserves explicit evidence.',
      evidenceRefs: [graph.runHash],
    }],
    requireProof: true,
  })
  assert.deepEqual(parsed.selection, selected.selection)
  assert.deepEqual(parsed.orderedNodeIds, selected.orderedNodeIds)
  assert.throws(
    () => parseCreateVariantRecipeBody({
      compatibilityGraphId: graph.id,
      expectedCompatibilityGraphRunHash: graph.runHash,
      ...selected,
      unknown: true,
    }),
    /unknown fields/,
  )
  assert.throws(
    () => parseCreateVariantRecipeBody({
      compatibilityGraphId: graph.id,
      expectedCompatibilityGraphRunHash: graph.runHash,
      ...selected,
      coldOpen: {
        nodeId: selected.selection.proofNodeId,
        sourceRangeMs: [0, 500],
        returnAtRole: 'body',
      },
    }),
    /must be hook/,
  )
})

test('T-FR-084 application service binds graph hash, batch objective, actor and idempotency fingerprint', async () => {
  const graph = graphFixture('recipe-graph-service')
  const selected = selection(graph)
  let replay = null
  let persistedRecord = null
  const repository = {
    async findCreateReplay(input) {
      assert.equal(input.workspaceId, graph.workspaceId)
      return replay
    },
    async loadCreationContext(input) {
      assert.equal(input.batchId, graph.batchId)
      assert.equal(input.compatibilityGraphId, graph.id)
      assert.equal(
        input.expectedCompatibilityGraphRunHash,
        graph.runHash,
      )
      assert.equal(input.actorClientId, 'client-recipe')
      return {
        projectId: graph.projectId,
        objective: 'lead-generation',
        compatibilityGraph: graph,
      }
    },
    async create(record) {
      persistedRecord = record
      replay = {
        run: record.run,
        requestFingerprint: record.requestFingerprint,
      }
      return { run: record.run, replayed: false }
    },
  }
  const execute = createVariantRecipeService({
    repository,
    clock: () => new Date('2026-07-28T03:04:00.000Z'),
    createRunId: () => 'variant-recipe-service',
  })
  const request = {
    workspaceId: graph.workspaceId,
    batchId: graph.batchId,
    compatibilityGraphId: graph.id,
    expectedCompatibilityGraphRunHash: graph.runHash,
    ...selected,
    actor: { type: 'api-client', id: 'client-recipe' },
    idempotencyKey: 'variant-service-idempotency',
  }
  const created = await execute(request)
  assert.equal(created.replayed, false)
  assert.equal(created.run.objective, 'lead-generation')
  assert.match(persistedRecord.requestFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(
    persistedRecord.run.compatibilityGraphRunHash,
    graph.runHash,
  )
  const replayed = await execute(request)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.run.id, created.run.id)
  await assert.rejects(
    execute({
      ...request,
      requireProof: true,
    }),
    /different variant recipe request/,
  )
})
