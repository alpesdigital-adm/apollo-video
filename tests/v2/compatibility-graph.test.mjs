import assert from 'node:assert/strict'
import test from 'node:test'

import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import {
  createScriptAlignmentRun,
  importScriptDocument,
} from '../../src/v2/domain/script-alignment.ts'
import { createTakeLibraryRun } from '../../src/v2/domain/take-library.ts'
import {
  COMPATIBILITY_HARD_REASON_CODES,
  COMPATIBILITY_SOFT_DIMENSIONS,
  createCompatibilityGraph,
  hydrateCompatibilityGraph,
} from '../../src/v2/domain/compatibility-graph.ts'

const lines = {
  hook: 'Pare agora e descubra o erro que bloqueia suas vendas',
  body: 'O método organiza sua mensagem para atrair clientes certos',
  proof: 'Mais de cem profissionais aplicaram o método com clareza',
  cta: 'Clique no botão e fale com nossa equipe no WhatsApp',
}

function transcript(text) {
  const words = text.split(/\s+/).filter(Boolean).map((word, index) => ({
    word,
    start: index * .25,
    end: index * .25 + .2,
  }))
  return createMediaTranscript({
    language: 'pt-BR',
    text,
    words,
    segments: [{
      id: 1,
      start: 0,
      end: words.at(-1)?.end ?? 0,
      text,
      confidence: .98,
    }],
    provider: 'fixture',
    model: 'compatibility-graph-v1',
  })
}

function libraryFixture() {
  const rawText = [
    `HOOK 1: ${lines.hook}.`,
    `BODY 1: ${lines.body}.`,
    `PROOF 1: ${lines.proof}.`,
    `CTA 1: ${lines.cta}.`,
  ].join('\n')
  const spoken = [
    lines.hook,
    lines.body,
    lines.proof,
    lines.cta,
  ].join(' ')
  const mediaTranscript = transcript(spoken)
  const alignment = createScriptAlignmentRun({
    id: 'script-alignment-compatibility',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document: importScriptDocument({
      title: 'Roteiro completo',
      locale: 'pt-BR',
      rawText,
    }),
    sources: [{
      transcriptId: 'transcript-compatibility',
      sourceArtifactId: 'artifact-compatibility',
      transcriptHash: mediaTranscript.transcriptHash,
      language: mediaTranscript.language,
      transcript: mediaTranscript,
    }],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-28T01:00:00.000Z',
  })
  const sources = alignment.alignments.flatMap((entry) => [
    ...(entry.selectedCandidate ? [entry.selectedCandidate] : []),
    ...entry.alternatives,
  ])
  const evaluations = [
    ...new Map(sources.map((candidate) => [
      candidate.id,
      candidate,
    ])).values(),
  ].map((candidate) => ({
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
      score: .92,
      evaluatorVersion: 'golden-evaluator/v1',
      evidenceRefs: [`evidence-${dimension}`],
    })),
  }))
  const library = createTakeLibraryRun({
    id: 'take-library-compatibility',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations,
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-28T01:01:00.000Z',
  })
  assert.deepEqual(
    [...new Set(library.takes
      .filter((take) => ['primary', 'alternate'].includes(take.status))
      .map((take) => take.assignment.role))].sort(),
    ['body', 'cta', 'hook', 'proof'],
  )
  return library
}

function context(take, patch = {}) {
  return {
    takeId: take.id,
    expectedTakeHash: take.takeHash,
    offerId: 'offer-apollo',
    audienceTags: ['especialistas'],
    claims: [{ key: 'resultado', value: 'clareza' }],
    personaId: 'persona-especialista',
    locale: 'pt-BR',
    desiredAction: 'whatsapp',
    continuityProvides: [
      `role-${take.assignment.role}`,
      ...(take.assignment.role === 'body' ? ['mecanismo-explicado'] : []),
    ],
    continuityRequires: [],
    narrativeTags: ['clareza', 'vendas'],
    tone: .55,
    energy: .62,
    visual: .5,
    experiment: .4,
    evidenceRefs: [take.takeHash, take.sourceHash],
    ...patch,
  }
}

function goldenContexts(library) {
  return library.takes
    .filter((take) => ['primary', 'alternate'].includes(take.status))
    .map((take) => {
      if (take.assignment.role === 'proof') {
        return context(take, {
          narrativeTags: ['depoimento', 'resultado'],
          tone: .75,
        })
      }
      if (take.assignment.role === 'cta') {
        return context(take, {
          offerId: 'offer-outro',
          audienceTags: ['enterprise'],
          claims: [{ key: 'resultado', value: 'velocidade' }],
          personaId: 'persona-enterprise',
          locale: 'en-US',
          desiredAction: 'download',
          continuityRequires: ['disclaimer-obrigatorio'],
        })
      }
      return context(take)
    })
}

test('T-FR-083 builds eligible hook, body, proof and CTA nodes from canonical takes', () => {
  const library = libraryFixture()
  const graph = createCompatibilityGraph({
    id: 'compatibility-graph-golden',
    workspaceId: library.workspaceId,
    projectId: library.projectId,
    batchId: library.batchId,
    takeLibrary: library,
    contexts: goldenContexts(library),
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-28T01:02:00.000Z',
  })
  assert.deepEqual(
    [...new Set(graph.nodes.map((node) => node.role))].sort(),
    ['body', 'cta', 'hook', 'proof'],
  )
  assert.ok(graph.nodes.every((node) =>
    node.takeHash &&
    node.sourceHash &&
    node.contextHash &&
    node.nodeHash))
  assert.equal(graph.summary.nodeCount, graph.nodes.length)
})

test('T-FR-083 golden graph preserves accepted, blocked and borderline edges with evidence', () => {
  const library = libraryFixture()
  const graph = createCompatibilityGraph({
    id: 'compatibility-graph-decisions',
    workspaceId: library.workspaceId,
    projectId: library.projectId,
    batchId: library.batchId,
    takeLibrary: library,
    contexts: goldenContexts(library),
    acceptThreshold: 90,
    reviewThreshold: 40,
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-28T01:03:00.000Z',
  })
  assert.ok(graph.edges.some((edge) => edge.decision === 'accepted'))
  assert.ok(graph.edges.some((edge) => edge.decision === 'borderline'))
  assert.ok(graph.edges.some((edge) => edge.decision === 'blocked'))
  assert.equal(
    graph.summary.acceptedCount +
    graph.summary.borderlineCount +
    graph.summary.blockedCount,
    graph.summary.edgeCount,
  )
  assert.ok(graph.edges.every((edge) =>
    edge.softScores.length === COMPATIBILITY_SOFT_DIMENSIONS.length &&
    edge.reasonCodes.length >= 1 &&
    edge.evidence.evidenceHash &&
    edge.edgeHash))
  assert.deepEqual(
    graph.edges.find((edge) =>
      edge.relation === 'body-cta').hardFailures
      .map((failure) => failure.code)
      .sort(),
    [...COMPATIBILITY_HARD_REASON_CODES].sort(),
  )
})

test('T-FR-083 hard failures override soft score and each soft dimension is weighted', () => {
  const library = libraryFixture()
  const contexts = goldenContexts(library).map((entry) => ({
    ...entry,
    narrativeTags: ['mesma-narrativa'],
    tone: .5,
    energy: .5,
    visual: .5,
    experiment: .5,
  }))
  const graph = createCompatibilityGraph({
    id: 'compatibility-graph-hard-priority',
    workspaceId: library.workspaceId,
    projectId: library.projectId,
    batchId: library.batchId,
    takeLibrary: library,
    contexts,
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-28T01:04:00.000Z',
  })
  const blocked = graph.edges.find((edge) =>
    edge.relation === 'body-cta')
  assert.ok(blocked.softScore >= 70)
  assert.equal(blocked.decision, 'blocked')
  assert.equal(blocked.eligible, false)
  assert.deepEqual(
    blocked.softScores.map((score) => score.dimension),
    [...COMPATIBILITY_SOFT_DIMENSIONS],
  )
  assert.equal(
    Number(blocked.softScores.reduce((sum, score) =>
      sum + score.weight, 0).toFixed(6)),
    1,
  )
})

test('T-FR-083 scopes node and edge identities to each immutable graph run', () => {
  const library = libraryFixture()
  const shared = {
    workspaceId: library.workspaceId,
    projectId: library.projectId,
    batchId: library.batchId,
    takeLibrary: library,
    contexts: goldenContexts(library),
    createdByClientId: 'client-fixture',
  }
  const first = createCompatibilityGraph({
    ...shared,
    id: 'compatibility-graph-first-run',
    createdAt: '2026-07-28T01:04:30.000Z',
  })
  const recalculated = createCompatibilityGraph({
    ...shared,
    id: 'compatibility-graph-recalculated',
    createdAt: '2026-07-28T01:04:31.000Z',
  })

  assert.deepEqual(first.summary, recalculated.summary)
  assert.equal(
    first.nodes.some((node) =>
      recalculated.nodes.some((candidate) => candidate.id === node.id)),
    false,
  )
  assert.equal(
    first.edges.some((edge) =>
      recalculated.edges.some((candidate) => candidate.id === edge.id)),
    false,
  )
  assert.deepEqual(
    first.edges.map((edge) => ({
      relation: edge.relation,
      decision: edge.decision,
      softScore: edge.softScore,
      hardCodes: edge.hardFailures.map((failure) => failure.code),
    })),
    recalculated.edges.map((edge) => ({
      relation: edge.relation,
      decision: edge.decision,
      softScore: edge.softScore,
      hardCodes: edge.hardFailures.map((failure) => failure.code),
    })),
  )
})

test('T-FR-083 rejects stale/missing contexts and detects aggregate tampering', () => {
  const library = libraryFixture()
  const contexts = goldenContexts(library)
  assert.throws(
    () => createCompatibilityGraph({
      id: 'compatibility-graph-missing',
      workspaceId: library.workspaceId,
      projectId: library.projectId,
      batchId: library.batchId,
      takeLibrary: library,
      contexts: contexts.slice(1),
      createdByClientId: 'client-fixture',
      createdAt: '2026-07-28T01:05:00.000Z',
    }),
    /Every eligible take requires/,
  )
  assert.throws(
    () => createCompatibilityGraph({
      id: 'compatibility-graph-stale',
      workspaceId: library.workspaceId,
      projectId: library.projectId,
      batchId: library.batchId,
      takeLibrary: library,
      contexts: contexts.map((entry, index) => index === 0
        ? { ...entry, expectedTakeHash: '0'.repeat(64) }
        : entry),
      createdByClientId: 'client-fixture',
      createdAt: '2026-07-28T01:06:00.000Z',
    }),
    /changed before compatibility/,
  )
  const graph = createCompatibilityGraph({
    id: 'compatibility-graph-tamper',
    workspaceId: library.workspaceId,
    projectId: library.projectId,
    batchId: library.batchId,
    takeLibrary: library,
    contexts,
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-28T01:07:00.000Z',
  })
  const tampered = structuredClone(graph)
  tampered.edges[0].reasonCodes = ['COMPATIBLE', 'INVENTED_REASON']
  assert.throws(
    () => hydrateCompatibilityGraph(tampered),
    /integrity validation/,
  )
  assert.deepEqual(hydrateCompatibilityGraph(graph), graph)
})

// ---- ADR-160 F8. A context the requester did not state is unspecified; the check that needs it is not evaluable; nothing is guessed. ----

function bareContext(take) {
  return {
    takeId: take.id,
    expectedTakeHash: take.takeHash,
    claims: [],
    continuityProvides: [`role-${take.assignment.role}`, ...(take.assignment.role === 'body' ? ['mecanismo-explicado'] : [])],
    continuityRequires: [],
    evidenceRefs: [take.takeHash, take.sourceHash],
  }
}

function graphOf(library, contexts, id = 'compatibility-graph-unspecified') {
  return createCompatibilityGraph({
    id, workspaceId: library.workspaceId, projectId: library.projectId, batchId: library.batchId, takeLibrary: library,
    contexts, createdByClientId: 'client-fixture', createdAt: '2026-07-28T01:02:00.000Z',
  })
}

test('F8 a request that states nothing about the semantics yields unspecified contexts, no check and no dimension invented', () => {
  const library = libraryFixture()
  const takes = library.takes.filter((take) => ['primary', 'alternate'].includes(take.status))
  const graph = graphOf(library, takes.map(bareContext))
  assert.equal(graph.schemaVersion, 'compatibility-graph/v2')
  for (const node of graph.nodes) {
    assert.deepEqual(node.unspecified, ['audienceTags', 'desiredAction', 'energy', 'experiment', 'locale', 'narrativeTags', 'offerId', 'personaId', 'tone', 'visual'])
    assert.equal(node.offerId, 'unspecified')
    assert.equal(node.personaId, 'unspecified')
    assert.equal(node.locale, 'und')
    assert.deepEqual(node.audienceTags, ['unspecified'])
    assert.deepEqual(node.narrativeTags, ['unspecified'])
    assert.equal('desiredAction' in node, false)
    for (const field of ['tone', 'energy', 'visual', 'experiment']) assert.equal(node[field], null, `${field} is not 0.5 or any other number: it was not stated`)
  }
  for (const edge of graph.edges) {
    // Nothing that could not be checked is reported as passed or as failed.
    assert.deepEqual(edge.hardFailures, [])
    const checks = edge.notEvaluable.map((item) => item.check).sort()
    assert.deepEqual(checks, ['AUDIENCE_CONFLICT', 'LOCALE_MISMATCH', 'OFFER_MISMATCH', 'PERSONA_MISMATCH', ...(edge.relation.endsWith('cta') ? ['CTA_ACTION_MISMATCH'] : [])].sort())
    assert.ok(edge.reasonCodes.includes('CONTEXT_NOT_EVALUABLE'))
    // The duration alone does not carry a decision: the link is left to the owner, neither approved nor blocked by the Apollo.
    assert.equal(edge.decision, 'borderline')
    assert.equal(edge.eligible, false)
    assert.ok(edge.reasonCodes.includes('CONTEXT_REQUIRED_FOR_DECISION'))
    assert.equal(edge.reasonCodes.includes('LOW_SOFT_SCORE') || edge.reasonCodes.includes('COMPATIBLE'), false)
    // Only the duration (read from the takes themselves) is scored, and it carries the whole weight.
    const scored = edge.softScores.filter((score) => score.score !== null)
    assert.deepEqual(scored.map((score) => score.dimension), ['duration'])
    assert.equal(edge.softScores.filter((score) => score.score === null).every((score) => score.weight === 0 && score.reasonCode.endsWith('_NOT_EVALUABLE')), true)
    assert.equal(edge.softScore, Number((scored[0].score * 100).toFixed(3)))
  }
  assert.equal(graph.summary.notEvaluableEdgeCount, graph.edges.length)
  assert.equal(hydrateCompatibilityGraph(JSON.parse(JSON.stringify(graph))).runHash, graph.runHash)
})

test('F8 a check is made as soon as both takes state what it needs, and only that check', () => {
  const library = libraryFixture()
  const takes = library.takes.filter((take) => ['primary', 'alternate'].includes(take.status))
  const graph = graphOf(library, takes.map((take) => ({
    ...bareContext(take),
    offerId: 'offer-apollo',
    locale: take.assignment.role === 'cta' ? 'en-US' : 'pt-BR',
  })), 'compatibility-graph-partial')
  const toCta = graph.edges.filter((edge) => edge.relation.endsWith('cta'))
  assert.ok(toCta.length > 0)
  for (const edge of graph.edges) {
    assert.equal(edge.notEvaluable.some((item) => item.check === 'OFFER_MISMATCH'), false, 'both state the offer: the check is made')
    assert.equal(edge.notEvaluable.some((item) => item.check === 'LOCALE_MISMATCH'), false)
    assert.equal(edge.notEvaluable.some((item) => item.check === 'PERSONA_MISMATCH'), true)
  }
  assert.ok(toCta.every((edge) => edge.hardFailures.some((failure) => failure.code === 'LOCALE_MISMATCH') && edge.decision === 'blocked'))
  assert.ok(graph.nodes.every((node) => !node.unspecified.includes('offerId') && !node.unspecified.includes('locale')))
})

test('F8 a graph with every context stated scores exactly as before and carries no not-evaluable entry', () => {
  const library = libraryFixture()
  const graph = graphOf(library, goldenContexts(library), 'compatibility-graph-all-stated')
  for (const edge of graph.edges) {
    assert.deepEqual(edge.notEvaluable, [])
    assert.equal(edge.softScores.every((score) => score.score !== null && score.weight > 0), true)
    assert.equal(edge.reasonCodes.includes('CONTEXT_NOT_EVALUABLE'), false)
    const expected = Number((edge.softScores.reduce((sum, score) => sum + score.score * score.weight, 0) * 100).toFixed(3))
    assert.equal(edge.softScore, expected)
  }
  assert.equal(graph.summary.notEvaluableEdgeCount, 0)
})

test('F8 the unspecified list, the sentinels and the not-evaluable entries are sealed: tampering is refused', () => {
  const library = libraryFixture()
  const takes = library.takes.filter((take) => ['primary', 'alternate'].includes(take.status))
  const wire = JSON.parse(JSON.stringify(graphOf(library, takes.map(bareContext))))
  const lie = structuredClone(wire)
  lie.nodes[0].unspecified = lie.nodes[0].unspecified.filter((field) => field !== 'tone')
  assert.throws(() => hydrateCompatibilityGraph(lie), (error) => error.code === 'INVALID_ARGUMENT')
  const invented = structuredClone(wire)
  invented.nodes[0].tone = 0.5
  assert.throws(() => hydrateCompatibilityGraph(invented), (error) => error.code === 'INVALID_ARGUMENT')
  const dropped = structuredClone(wire)
  dropped.edges[0].notEvaluable = []
  assert.throws(() => hydrateCompatibilityGraph(dropped), (error) => error.code === 'INVALID_ARGUMENT')
})

test('ADR-160: what was stated carries a decision only from the weight of the strongest single signal; below it the owner decides', () => {
  const library = libraryFixture()
  const takes = library.takes.filter((take) => ['primary', 'alternate'].includes(take.status))
  const withOnly = (patch) => graphOf(library, takes.map((take) => ({ ...bareContext(take), ...patch })), 'compatibility-graph-one-signal')
  // experiment alone (weight 0.10) does not carry it; the edges stay with the owner.
  const weak = withOnly({ experiment: 0.5 })
  assert.ok(weak.edges.every((edge) => edge.decision === 'borderline' && edge.reasonCodes.includes('CONTEXT_REQUIRED_FOR_DECISION')))
  // narrative alone (0.30), or tone + energy (0.15 + 0.15), does: the thresholds apply and no owner-only code is added.
  for (const patch of [{ narrativeTags: ['clareza'] }, { tone: 0.6, energy: 0.6 }]) {
    const graph = withOnly(patch)
    assert.ok(graph.edges.every((edge) => !edge.reasonCodes.includes('CONTEXT_REQUIRED_FOR_DECISION')), JSON.stringify(patch))
    assert.ok(graph.edges.every((edge) => edge.decision === 'blocked' || edge.decision === 'accepted' || edge.decision === 'borderline'))
  }
  // A hard failure is still a block, with or without context.
  const clash = graphOf(library, takes.map((take) => ({ ...bareContext(take), locale: take.assignment.role === 'cta' ? 'en-US' : 'pt-BR' })), 'compatibility-graph-clash')
  assert.ok(clash.edges.filter((edge) => edge.hardFailures.length > 0).every((edge) => edge.decision === 'blocked'))
})
