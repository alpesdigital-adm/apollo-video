import assert from 'node:assert/strict'
import test from 'node:test'

import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import {
  createScriptAlignmentRun,
  hydrateScriptAlignmentRun,
  importScriptDocument,
  reviewScriptAlignmentRun,
} from '../../src/v2/domain/script-alignment.ts'

function transcript(text, options = {}) {
  const words = text.split(/\s+/).filter(Boolean).map((word, index) => ({
    word,
    start: index * .24,
    end: index * .24 + .2,
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
      confidence: .97,
    }],
    provider: 'fixture',
    model: options.model ?? 'alignment-v1',
  })
}

function source(id, text, roleHint) {
  const mediaTranscript = transcript(text, { model: id })
  return {
    transcriptId: `transcript-${id}`,
    sourceArtifactId: `artifact-${id}`,
    transcriptHash: mediaTranscript.transcriptHash,
    language: mediaTranscript.language,
    ...(roleHint ? { roleHint } : {}),
    transcript: mediaTranscript,
  }
}

const documentText = [
  'HOOK 1: Pare de perder dinheiro com anuncios.',
  'HOOK 2: Descubra como vender todos os dias.',
  '',
  'CORPO 1: Voce precisa alinhar oferta, publico e mensagem.',
  'A explicacao continua sem apagar a primeira linha.',
  'PROVA 1: Mais de cem clientes aplicaram este metodo.',
  'CTA 1: Clique no link e agende uma conversa.',
  'CTA 2: Baixe o guia secreto no aplicativo azul.',
].join('\n')

test('T-FR-081 imports labeled blocks while preserving exact source and order', () => {
  const document = importScriptDocument({
    title: 'Roteiro 2-1-2',
    locale: 'pt-BR',
    rawText: documentText,
  })
  assert.equal(document.blocks.length, 6)
  assert.deepEqual(
    document.blocks.map((block) => block.role),
    ['hook', 'hook', 'body', 'proof', 'cta', 'cta'],
  )
  assert.equal(
    document.blocks[2].plannedText,
    'Voce precisa alinhar oferta, publico e mensagem.\n' +
      'A explicacao continua sem apagar a primeira linha.',
  )
  assert.equal(
    document.blocks[2].normalizedText,
    'voce precisa alinhar oferta publico e mensagem ' +
      'a explicacao continua sem apagar a primeira linha',
  )
  assert.equal(document.rawText, documentText)
  assert.deepEqual(
    document.blocks.map((block) => block.documentOrder),
    [0, 1, 2, 3, 4, 5],
  )
  assert.match(document.documentHash, /^[a-f0-9]{64}$/)
})

test('T-FR-081 aligns multiple grouped recordings and exposes exact, near, partial, missing and extras', () => {
  const document = importScriptDocument({
    title: 'Roteiro gravado em grupos',
    locale: 'pt-BR',
    rawText: documentText,
  })
  const run = createScriptAlignmentRun({
    id: 'script-alignment-fixture',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document,
    sources: [
      source(
        'hooks',
        'Preparando Pare de perder dinheiro com anuncios ' +
          'Descubra como vender diariamente Encerrando',
        'hook',
      ),
      source(
        'body',
        'Voce precisa alinhar oferta publico e mensagem ' +
          'A explicacao continua sem apagar a primeira linha ' +
          'Dezenas de clientes aplicaram este metodo',
        'body',
      ),
      source(
        'cta',
        'Clique no link e agende uma conversa Obrigado por assistir',
        'cta',
      ),
    ],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T21:10:00.000Z',
  })

  assert.equal(run.alignments.length, 6)
  assert.ok(run.alignments.some((alignment) => alignment.kind === 'exact'))
  assert.ok(run.alignments.some((alignment) =>
    alignment.kind === 'near' || alignment.kind === 'partial'))
  assert.ok(run.alignments.some((alignment) => alignment.kind === 'missing'))
  assert.ok(run.extraTakes.length > 0)
  assert.ok(run.summary.reviewRequiredCount > 0)
  assert.equal(run.status, 'review-required')
  assert.ok(run.alignments.every((alignment) =>
    alignment.selectedCandidate === null ||
    alignment.selectedCandidate.evidenceWordIndices.length > 0))
  assert.ok(run.alignments.some((alignment) =>
    alignment.selectedCandidate?.deviations.some((deviation) =>
      deviation.kind === 'number-claim-change')))
  assert.equal(hydrateScriptAlignmentRun(run).runHash, run.runHash)
  assert.equal(
    hydrateScriptAlignmentRun(
      JSON.parse(stableSerialize(run)),
    ).runHash,
    run.runHash,
  )
})

test('T-FR-081 keeps monotonic evidence and does not silently reorder planned blocks', () => {
  const document = importScriptDocument({
    title: 'Roteiro fora de ordem',
    locale: 'pt-BR',
    rawText: [
      'HOOK 1: Primeiro conceito exclusivo.',
      'HOOK 2: Segundo exemplo diferente.',
    ].join('\n'),
  })
  const run = createScriptAlignmentRun({
    id: 'script-alignment-out-of-order',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document,
    sources: [
      source(
        'out-of-order',
        'Segundo exemplo diferente Primeiro conceito exclusivo',
        'hook',
      ),
    ],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T21:11:00.000Z',
  })
  const selected = run.alignments
    .map((alignment) => alignment.selectedCandidate)
    .filter(Boolean)
  for (let index = 1; index < selected.length; index += 1) {
    assert.ok(
      selected[index].evidenceWordIndices[0] >
      selected[index - 1].evidenceWordIndices.at(-1),
    )
  }
  assert.ok(run.alignments.some((alignment) =>
    alignment.kind === 'missing' || alignment.kind === 'partial'))
})

test('T-FR-081 marks repeated equally-scored takes ambiguous and resolves an explicit alternative', () => {
  const document = importScriptDocument({
    title: 'Roteiro repetido',
    locale: 'pt-BR',
    rawText: 'HOOK 1: Pare agora e preste atencao.',
  })
  const run = createScriptAlignmentRun({
    id: 'script-alignment-ambiguous',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document,
    sources: [
      source(
        'repeated',
        'Pare agora e preste atencao intervalo ' +
          'Pare agora e preste atencao',
        'hook',
      ),
    ],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T21:12:00.000Z',
  })
  const alignment = run.alignments[0]
  assert.equal(alignment.ambiguous, true)
  assert.equal(alignment.reviewStatus, 'review-required')
  assert.ok(alignment.alternatives.length > 0)

  const reviewed = reviewScriptAlignmentRun({
    run,
    expectedRevision: 1,
    reviewId: 'script-review-alternative',
    actorClientId: 'client-reviewer',
    decisions: [
      {
        targetKind: 'block',
        blockId: alignment.blockId,
        resolution: 'select-alternative',
        candidateId: alignment.alternatives[0].id,
        note: 'Segundo take escolhido por performance.',
      },
      ...run.extraTakes.map((extra) => ({
        targetKind: 'extra-take',
        extraTakeId: extra.id,
        resolution: 'reject-extra',
        note: 'Intervalo e repeticao fora da composicao.',
      })),
    ],
    createdAt: '2026-07-27T21:13:00.000Z',
  })
  assert.equal(reviewed.revision, 2)
  assert.equal(reviewed.alignments[0].reviewStatus, 'accepted')
  assert.equal(
    reviewed.alignments[0].selectedCandidate.id,
    alignment.alternatives[0].id,
  )
  assert.equal(reviewed.reviews.length, 1)
  assert.equal(reviewed.status, 'reviewed')
  assert.ok(reviewed.extraTakes.every((extra) =>
    extra.reviewStatus === 'rejected'))
  assert.match(reviewed.reviews[0].reviewHash, /^[a-f0-9]{64}$/)
  assert.throws(
    () => reviewScriptAlignmentRun({
      run: reviewed,
      expectedRevision: 1,
      reviewId: 'script-review-stale',
      actorClientId: 'client-reviewer',
      decisions: [{
        targetKind: 'block',
        blockId: alignment.blockId,
        resolution: 'accept',
      }],
      createdAt: '2026-07-27T21:14:00.000Z',
    }),
    /revision is stale/,
  )
})

test('T-FR-081 keeps a spoken error outside the selected corrected take', () => {
  const document = importScriptDocument({
    title: 'Roteiro com correção de fala',
    locale: 'pt-BR',
    rawText: 'BODY 1: Use a mensagem correta para vender.',
  })
  const run = createScriptAlignmentRun({
    id: 'script-alignment-spoken-error',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document,
    sources: [
      source(
        'spoken-error',
        'Use a oferta errada desculpa volta Use a mensagem correta para vender',
        'body',
      ),
    ],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T21:14:30.000Z',
  })

  assert.equal(
    run.alignments[0].selectedCandidate?.spokenText,
    'Use a mensagem correta para vender',
  )
  assert.ok(run.extraTakes.some((extra) =>
    extra.spokenText.includes('oferta errada desculpa volta')))
  assert.ok(run.extraTakes.every((extra) =>
    extra.reviewStatus === 'review-required'))
})

test('T-FR-081 fails closed on unlabeled input and persisted integrity drift', () => {
  assert.throws(
    () => importScriptDocument({
      title: 'Sem marcadores',
      locale: 'pt-BR',
      rawText: 'Uma frase sem papel identificado.',
    }),
    /identifiable block label/,
  )
  const document = importScriptDocument({
    title: 'Roteiro simples',
    locale: 'pt-BR',
    rawText: 'CTA: Agende uma conversa.',
  })
  const run = createScriptAlignmentRun({
    id: 'script-alignment-integrity',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document,
    sources: [source('integrity', 'Agende uma conversa', 'cta')],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T21:15:00.000Z',
  })
  assert.throws(
    () => hydrateScriptAlignmentRun({
      ...run,
      summary: { ...run.summary, exactCount: 99 },
    }),
    /integrity validation/,
  )
})
