import assert from 'node:assert/strict'

import { assertDirectorSnapshotContent } from '../../../src/v2/application/director-snapshot-identity.ts'
import { replaceSourceTranscriptService } from '../../../src/v2/application/replace-source-transcript.ts'
import { runProjectDirectorService } from '../../../src/v2/application/run-project-director.ts'
import { calculateVersionHash } from '../../../src/v2/application/version-hash.ts'
import { operationalBundlePlanV3 } from '../../../src/v2/domain/output-version-bundle.ts'
import { createProductionBrief } from '../../../src/v2/domain/production-brief.ts'
import { childCommandOf } from '../../../src/v2/domain/project-output-state-transition.ts'
import { createSourceTranscriptArtifactInvalidations } from '../../../src/v2/domain/source-transcript-replacement.ts'
import { createEvidenceBoundBriefCompiler } from '../../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { ingestedWorld, recompiledChild, worldActor } from './output-world.mjs'

/**
 * The physical retiming journeys (transcript-rate, wave9, wave10) start from a sealed ProjectVersion3/State3, the same way
 * the product does, instead of the retired contract-one Version they used to hand-assemble. The world is the pure W66
 * builder (outputWorld/ingestedWorld/recompiledChild): the recording IS the suite's master (its artifact id, storage key,
 * digest and size), and the head carries the suite's compiled EditPlan. Persistence is the only thing replaced.
 */

/** The sealed head of a project whose single recording is `master` and whose EditPlan is `plan`. */
export async function sealedMasterHead({ workspaceId, projectId, clientId, credentialId, environment = 'production', master, plan, suffix = 'journey-base' }) {
  const actor = worldActor({ workspaceId, clientId, credentialId, environment })
  const world = await ingestedWorld({
    actor, ids: { project: projectId }, slug: master.artifactId, sourceDurationSeconds: master.durationSeconds,
    ...(master.sourceKey ? { sourceKey: master.sourceKey } : {}),
    ...(master.sourceSha256 ? { sourceSha256: master.sourceSha256 } : {}),
    ...(master.sourceByteSize ? { sourceByteSize: master.sourceByteSize } : {}),
  })
  const head = recompiledChild(world.parent, actor, () => structuredClone(plan), { suffix })
  return Object.freeze({ world, actor, head })
}

/** Replacement context over a sealed parent: the plan and its hash are read out of the parent's own snapshot. */
export class SealedReplacementRepository {
  constructor({ parent, currentTranscript, replacement, outputReferences }) {
    this.parent = parent
    this.currentTranscript = currentTranscript
    this.replacement = replacement
    this.outputReferences = outputReferences
  }

  committed
  async findIdempotentResult() { return this.committed ?? null }
  async readContext() {
    const snapshot = operationalBundlePlanV3(this.parent)
    return {
      parent: this.parent, editPlan: JSON.parse(snapshot.contentJson), editPlanHash: snapshot.contentHash,
      currentTranscript: this.currentTranscript,
      replacementTranscript: this.replacement,
      outputReferences: this.outputReferences(this.parent.version.id),
    }
  }

  async commitOrReplay(input) {
    const { bundle } = input, command = bundle.origin.command
    const result = {
      command, version: bundle.version, editPlan: JSON.parse(bundle.editPlanSnapshot.contentJson), impact: command.payload.impact,
      invalidations: createSourceTranscriptArtifactInvalidations({ impact: command.payload.impact, createdAt: command.createdAt }),
      replayed: false, snapshot: bundle.editPlanSnapshot, bundle,
    }
    this.committed = { requestFingerprint: bundle.origin.requestFingerprint, result }
    return result
  }
}

/** The Director's context for this journey: the sealed replacement is the head it plans from. */
export class SealedDirectorRepository {
  constructor({ parent, editPlan, transcript, sourceRights, outputReferences }) {
    this.snapshotRows = new Map()
    this.parent = parent
    this.editPlan = editPlan
    this.transcript = transcript
    this.sourceRights = sourceRights
    this.outputReferences = outputReferences
    this.records = new Map()
  }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey }) {
    return this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId }) {
    if (workspaceId !== this.parent.version.workspaceId || projectId !== this.parent.version.projectId) return null
    return {
      workspaceId,
      project: { id: projectId, objective: 'discovery', format: '9:16', locale: 'pt-BR' },
      parent: this.parent,
      currentVersion: this.parent.version,
      brief: {
        objective: 'discovery',
        desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
        productionBrief: createProductionBrief({ ownerText: 'Tom: direto, natural e sem efeitos gratuitos.' }),
      },
      policies: { automaticZoom: false, faceProtection: true, guardrails: [] },
      editPlan: this.editPlan,
      currentDurationFrames: this.editPlan.durationFrames,
      proxyVariantId: '9:16',
      sourceRights: { state: 'present', status: 'approved', consentStatus: 'not-required', ...this.sourceRights },
      outputReferences: this.outputReferences(this.parent.version.id),
      transcript: {
        id: this.transcript.id, sourceArtifactId: this.transcript.sourceArtifactId, language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3', transcriptHash: this.transcript.transcriptHash,
      },
    }
  }

  async commitWithCanonicalSnapshots(scope, prepare) {
    // Controlled in-memory transaction: explicit canonical store, no PG claim.
    const rows = new Map(this.snapshotRows)
    const resolve = async (candidates) => candidates.map((candidate) => {
      assert.equal(candidate.workspaceId, scope.workspaceId)
      assert.equal(candidate.projectId, scope.projectId)
      const key = JSON.stringify([candidate.projectId, candidate.kind, candidate.contentHash])
      const stored = rows.get(key)
      if (stored) {
        assertDirectorSnapshotContent(candidate, stored)
        return stored
      }
      rows.set(key, candidate)
      return candidate
    })
    const commit = await prepare(resolve)
    const sealed = childCommandOf(commit.bundle)
    assert.equal(sealed.command.baseVersionId, scope.baseVersionId)
    assert.equal(sealed.command.baseHash, scope.baseHash)
    assert.equal(sealed.requestFingerprint, scope.requestFingerprint)
    this.lastCommit = commit
    const result = Object.freeze({
      run: commit.run, command: sealed.command, version: commit.bundle.version, replayed: false,
      bundle: commit.bundle, snapshots: Object.freeze([commit.bundle.editPlanSnapshot]),
    })
    this.records.set(`${sealed.command.workspaceId}:${sealed.command.projectId}:${sealed.command.idempotencyKey}`, {
      requestFingerprint: sealed.requestFingerprint, result,
    })
    this.snapshotRows = rows
    return result
  }
}

/**
 * Replacement -> Director over a sealed head. Returns what the render half of every journey reads: the replacement, the
 * PERSISTED directed EditPlan snapshot and plan, and the sealed bundles in order (`chain`) for tests that re-read them.
 */
export async function replaceThenDirect({
  head, actor, currentTranscript, replacement, outputReferences, sourceRights, directorTranscript = replacement,
  replaceClock, directorClock, replaceIds, directorIdSuffix = '-director', idempotency, reason,
}) {
  const replacementRepository = new SealedReplacementRepository({
    parent: head,
    currentTranscript,
    replacement: { id: replacement.id, transcriptHash: replacement.transcript.transcriptHash, sourceArtifactId: replacement.sourceArtifactId, transcript: replacement.transcript },
    outputReferences,
  })
  let replaceCounter = 0
  const replaceService = replaceSourceTranscriptService({
    repository: replacementRepository,
    clock: replaceClock,
    createId: (kind) => replaceIds ? replaceIds(kind, ++replaceCounter) : `${kind}-retimed-${++replaceCounter}`,
    createEventId: () => '123e4567-e89b-42d3-a456-426614174020',
  })
  const replaced = await replaceService({
    workspaceId: head.version.workspaceId, projectId: head.version.projectId,
    baseVersionId: head.version.id, baseHash: head.version.baseHash,
    replacementTranscriptId: replacement.id, expectedTranscriptHash: replacement.transcript.transcriptHash,
    actor, idempotencyKey: idempotency.replace,
  })
  const persisted = JSON.parse(replaced.snapshot.contentJson)
  const directorRepository = new SealedDirectorRepository({
    parent: replaced.bundle, editPlan: persisted,
    transcript: { id: directorTranscript.id, sourceArtifactId: directorTranscript.sourceArtifactId, transcriptHash: persisted.retimedTranscript.sourceTranscriptHash },
    sourceRights, outputReferences,
  })
  const counters = new Map()
  let event = 0
  const runDirector = runProjectDirectorService({
    repository: directorRepository,
    clock: directorClock,
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}${directorIdSuffix}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
  })
  const directed = await runDirector({
    workspaceId: head.version.workspaceId, projectId: head.version.projectId,
    baseVersionId: replaced.version.id, baseHash: replaced.version.baseHash,
    actor, idempotency: { key: idempotency.director }, reason,
  })
  const editPlanSnapshot = directed.bundle.editPlanSnapshot
  const directedPlan = JSON.parse(editPlanSnapshot.contentJson)
  assert.equal(editPlanSnapshot.contentHash, calculateVersionHash(directedPlan))
  return { replacement: replaced, persisted, directed, directedPlan, editPlanSnapshot, replacementRepository, directorRepository, chain: [replaced.bundle, directed.bundle] }
}
