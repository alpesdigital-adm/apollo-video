import assert from 'node:assert/strict'
import test from 'node:test'

import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import {
  createScriptAlignmentRun,
  importScriptDocument,
} from '../../src/v2/domain/script-alignment.ts'
import {
  createTakeLibraryRun,
  hydrateTakeLibraryRun,
  selectTakeManually,
} from '../../src/v2/domain/take-library.ts'

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
      confidence: .97,
    }],
    provider: 'fixture',
    model: 'take-library-v1',
  })
}

function alignmentFixture() {
  const mediaTranscript = transcript(
    'Pare agora e preste atencao intervalo ' +
    'Pare agora e preste atencao intervalo ' +
    'Pare agora e preste atencao ' +
    'Clique no link para falar com nossa equipe',
  )
  return createScriptAlignmentRun({
    id: 'script-alignment-take-library',
    workspaceId: 'workspace-fixture',
    projectId: 'project-fixture',
    batchId: 'batch-fixture',
    document: importScriptDocument({
      title: 'Roteiro com retakes',
      locale: 'pt-BR',
      rawText: 'HOOK 1: Pare agora e preste atencao.',
    }),
    sources: [{
      transcriptId: 'transcript-retakes',
      sourceArtifactId: 'artifact-retakes',
      transcriptHash: mediaTranscript.transcriptHash,
      language: mediaTranscript.language,
      roleHint: 'hook',
      transcript: mediaTranscript,
    }],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:00:00.000Z',
  })
}

function measuredDimensions(score, integrity = score) {
  return [
    'completeness',
    'performance',
    'audio',
    'video',
    'integrity',
  ].map((dimension) => ({
    dimension,
    score: dimension === 'integrity' ? integrity : score,
    evaluatorVersion: 'golden-evaluator/v1',
    evidenceRefs: [`evidence-${dimension}-${String(score).replace('.', '-')}`],
    reasonCodes: [],
  }))
}

function evaluatedSources(alignment) {
  const candidates = alignment.alignments.flatMap((entry) => [
    ...(entry.selectedCandidate ? [entry.selectedCandidate] : []),
    ...entry.alternatives,
  ])
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [
      candidate.id,
      candidate,
    ])).values(),
  ]
  return [
    ...uniqueCandidates.map((candidate, index) => ({
      sourceKind: 'alignment-candidate',
      sourceId: candidate.id,
      expectedSourceHash: candidate.candidateHash,
      dimensions: measuredDimensions(
        index === 0 ? .94 : Math.max(.68, .82 - index * .04),
      ),
    })),
    ...alignment.extraTakes.map((extra, index) => ({
      sourceKind: 'extra-take',
      sourceId: extra.id,
      expectedSourceHash: extra.extraHash,
      dimensions: measuredDimensions(.72, index === 0 ? .2 : .72),
      inferredIntention: {
        role: 'cta',
        label: 'cta:falar-com-equipe',
        confidence: .91,
        evidenceRefs: ['intention-evaluator-result'],
      },
    })),
  ]
}

test('T-FR-082 groups consecutive retakes by ScriptBlock with mandatory unique boundaries', () => {
  const alignment = alignmentFixture()
  assert.ok(alignment.alignments[0].alternatives.length >= 1)
  const library = createTakeLibraryRun({
    id: 'take-library-fixture',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations: evaluatedSources(alignment),
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:01:00.000Z',
  })
  const hookGroup = library.groups.find((group) =>
    group.scriptBlockId === alignment.document.blocks[0].id)
  assert.ok(hookGroup)
  assert.ok(hookGroup.takeIds.length >= 2)
  const hookTakes = library.takes.filter((take) =>
    take.groupId === hookGroup.id)
  assert.equal(
    new Set(hookTakes.map((take) => take.retakeBoundaryId)).size,
    hookTakes.length,
  )
  assert.ok(hookTakes.every((take) =>
    take.retakeBoundaryId.startsWith('retake-boundary-')))
  assert.deepEqual(
    [...hookTakes].sort((left, right) =>
      left.sourceRangeMs[0] - right.sourceRangeMs[0]),
    hookTakes,
  )
  assert.equal(hookGroup.assignmentKind, 'script-block')
  assert.equal(hookGroup.role, 'hook')
  assert.ok(library.takes.every((take) =>
    take.assignment.confidence >= 0 &&
    take.assignment.confidence <= 1))
})

test('T-FR-082 scores five dimensions and preserves primary, alternate, rejected and review states', () => {
  const alignment = alignmentFixture()
  const library = createTakeLibraryRun({
    id: 'take-library-score-fixture',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations: evaluatedSources(alignment),
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:02:00.000Z',
  })
  assert.ok(library.takes.every((take) =>
    take.evaluations.map((entry) => entry.dimension).join(',') ===
    'completeness,performance,audio,video,integrity'))
  assert.ok(library.takes.some((take) => take.status === 'primary'))
  assert.ok(library.takes.some((take) => take.status === 'alternate'))
  assert.ok(library.takes.some((take) => take.status === 'rejected'))

  const withoutMeasurements = createTakeLibraryRun({
    id: 'take-library-review-fixture',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations: [],
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:03:00.000Z',
  })
  assert.ok(withoutMeasurements.takes.some((take) =>
    take.status === 'needs-review'))
  assert.ok(withoutMeasurements.summary.unavailableDimensionCount > 0)
  assert.equal(withoutMeasurements.status, 'review-required')
})

test('T-FR-082 groups unplanned material by evidenced inferred intention without deleting it', () => {
  const alignment = alignmentFixture()
  assert.ok(alignment.extraTakes.length >= 1)
  const library = createTakeLibraryRun({
    id: 'take-library-intention-fixture',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations: evaluatedSources(alignment),
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:04:00.000Z',
  })
  const extras = library.takes.filter((take) =>
    take.sourceKind === 'extra-take')
  assert.equal(extras.length, alignment.extraTakes.length)
  assert.ok(extras.every((take) =>
    take.assignment.kind === 'inferred-intention' &&
    take.assignment.role === 'cta' &&
    take.assignment.evidenceRefs.includes(
      'intention-evaluator-result',
    )))
  assert.ok(extras.every((take) =>
    alignment.extraTakes.some((extra) =>
      extra.id === take.sourceId && extra.extraHash === take.sourceHash)))
})

test('T-FR-082 manually selects and protects one take with explicit protected replacement', () => {
  const alignment = alignmentFixture()
  const library = createTakeLibraryRun({
    id: 'take-library-selection-fixture',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations: evaluatedSources(alignment),
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:05:00.000Z',
  })
  const group = library.groups.find((candidate) =>
    candidate.takeIds.length >= 2)
  assert.ok(group)
  const alternate = library.takes.find((take) =>
    take.groupId === group.id && take.status === 'alternate')
  assert.ok(alternate)
  const first = selectTakeManually({
    run: library,
    selectionId: 'take-selection-one',
    expectedRevision: 1,
    groupId: group.id,
    takeId: alternate.id,
    protect: true,
    note: 'Melhor entrega confirmada no review.',
    actorClientId: 'client-reviewer',
    createdAt: '2026-07-27T23:06:00.000Z',
  })
  const selected = first.run.takes.find((take) =>
    take.id === alternate.id)
  assert.equal(selected.status, 'primary')
  assert.equal(selected.protected, true)
  assert.equal(selected.selectionSource, 'manual')
  assert.equal(
    first.run.groups.find((candidate) => candidate.id === group.id)
      .protectedTakeId,
    alternate.id,
  )
  const replacement = first.run.takes.find((take) =>
    take.groupId === group.id &&
    take.id !== alternate.id &&
    take.status !== 'rejected')
  assert.ok(replacement)
  assert.throws(
    () => selectTakeManually({
      run: first.run,
      selectionId: 'take-selection-stale-protection',
      expectedRevision: 2,
      groupId: group.id,
      takeId: replacement.id,
      protect: true,
      actorClientId: 'client-reviewer',
      createdAt: '2026-07-27T23:07:00.000Z',
    }),
    /exact current ID/,
  )
  const second = selectTakeManually({
    run: first.run,
    selectionId: 'take-selection-two',
    expectedRevision: 2,
    groupId: group.id,
    takeId: replacement.id,
    protect: true,
    replacedProtectedTakeId: alternate.id,
    actorClientId: 'client-reviewer',
    createdAt: '2026-07-27T23:07:00.000Z',
  })
  assert.equal(second.run.revision, 3)
  assert.equal(second.run.summary.protectedCount, 1)
  assert.equal(
    second.run.takes.find((take) => take.id === replacement.id).protected,
    true,
  )
  assert.equal(
    second.run.takes.find((take) => take.id === alternate.id).protected,
    false,
  )
})

test('T-FR-082 rejects stale evidence, duplicate dimensions, rejected selection and hash tampering', () => {
  const alignment = alignmentFixture()
  const evaluations = evaluatedSources(alignment)
  assert.throws(
    () => createTakeLibraryRun({
      id: 'take-library-stale-source',
      workspaceId: alignment.workspaceId,
      projectId: alignment.projectId,
      batchId: alignment.batchId,
      alignment,
      evaluations: [{
        ...evaluations[0],
        expectedSourceHash: 'f'.repeat(64),
      }],
      createdByClientId: 'client-fixture',
      createdAt: '2026-07-27T23:08:00.000Z',
    }),
    /changed before evaluation/,
  )
  assert.throws(
    () => createTakeLibraryRun({
      id: 'take-library-duplicate-dimension',
      workspaceId: alignment.workspaceId,
      projectId: alignment.projectId,
      batchId: alignment.batchId,
      alignment,
      evaluations: [{
        ...evaluations[0],
        dimensions: [
          evaluations[0].dimensions[0],
          evaluations[0].dimensions[0],
        ],
      }],
      createdByClientId: 'client-fixture',
      createdAt: '2026-07-27T23:08:00.000Z',
    }),
    /duplicates/,
  )
  const library = createTakeLibraryRun({
    id: 'take-library-integrity-fixture',
    workspaceId: alignment.workspaceId,
    projectId: alignment.projectId,
    batchId: alignment.batchId,
    alignment,
    evaluations,
    createdByClientId: 'client-fixture',
    createdAt: '2026-07-27T23:08:00.000Z',
  })
  const rejected = library.takes.find((take) =>
    take.status === 'rejected')
  assert.ok(rejected)
  assert.throws(
    () => selectTakeManually({
      run: library,
      selectionId: 'take-selection-rejected',
      expectedRevision: 1,
      groupId: rejected.groupId,
      takeId: rejected.id,
      protect: true,
      actorClientId: 'client-reviewer',
      createdAt: '2026-07-27T23:09:00.000Z',
    }),
    /Rejected take/,
  )
  assert.equal(
    hydrateTakeLibraryRun(
      JSON.parse(stableSerialize(library)),
    ).runHash,
    library.runHash,
  )
  assert.throws(
    () => hydrateTakeLibraryRun({
      ...library,
      takes: [{
        ...library.takes[0],
        spokenText: 'conteudo adulterado',
      }, ...library.takes.slice(1)],
    }),
    /integrity validation/,
  )
})
