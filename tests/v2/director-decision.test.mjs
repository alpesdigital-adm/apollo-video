import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDirectorDecision,
  createDirectorDecisionLog,
  parseDirectorDecisionLog,
  traceDecisionToFrames,
} from '../../src/v2/domain/director-decision.ts'
import {
  listDirectorDecisionsService,
  readDirectorDecisionService,
} from '../../src/v2/application/read-director-decisions.ts'
import { PrismaDirectorDecisionLogRepository } from '../../src/v2/infrastructure/prisma/director-decision-log-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { authenticatedActor } from './helpers/authentication-audit.mjs'

const storyPlan = {
  id: 'story-snapshot-1', schemaVersion: 1, objective: 'sale', targetDurationMs: { min: 1_000, max: 4_000 },
  acts: [{ id: 'opening-act', role: 'opening', blockIds: ['node-proof'] }],
  blocks: [{ id: 'node-proof', actId: 'opening-act', role: 'proof', intent: 'prove', dependencies: [], sourceCandidateIds: ['clip-proof'], durationTargetMs: { min: 1_000, ideal: 2_000, max: 3_000 }, content: { claimIds: ['claim-1'], qualifierIds: [], proofIds: ['proof-1'] }, presentation: 'source-video' }],
}
const plannedDecision = { id: 'decision-1', category: 'narrative', choice: 'use-testimony', reason: 'Best supported claim.', evidenceRefs: ['perception:obs-9'], confidence: .91, alternatives: ['use-broll'] }

function logFixture() {
  return createDirectorDecisionLog({ workspaceId: 'workspace-1', projectId: 'project-1', runId: 'run-1', commandId: 'command-7', resultVersionId: 'version-2', actor: { type: 'api-client', id: 'client-1' }, storyPlan, decisions: [plannedDecision], createdAt: '2026-07-17T20:00:00.000Z' })
}

function actor(overrides = {}) {
  return authenticatedActor({ workspaceId: 'workspace-1', clientId: 'client-1', credentialId: 'credential-1', scopes: ['projects:read'], ...overrides })
}

test('T-FR-065 creates a content-addressed decision log with immutable run, plan, command and result bindings', () => {
  const log = logFixture()
  const decision = log.entries[0]
  assert.equal(decision.runId, 'run-1')
  assert.deepEqual(decision.planNodeIds, ['node-proof'])
  assert.equal(decision.commandId, 'command-7')
  assert.deepEqual(decision.resultTarget, { projectVersionId: 'version-2', artifactRole: 'final-output' })
  assert.deepEqual(decision.actor, { type: 'api-client', id: 'client-1' })
  assert.deepEqual(decision.candidates.map(({ id, outcome }) => ({ id, outcome })), [{ id: 'use-testimony', outcome: 'selected' }, { id: 'use-broll', outcome: 'rejected' }])
  assert.deepEqual(decision.evidence, [{ ref: 'perception:obs-9' }])
  assert.equal(decision.confidence, .91)
  assert.equal(decision.score, .91)
  assert.deepEqual(decision.cost, { estimated: 0, actual: 0, currency: 'credits', source: 'deterministic-local' })
  assert.match(decision.decisionHash, /^[a-f0-9]{64}$/)
  assert.match(log.logHash, /^[a-f0-9]{64}$/)
  assert.ok(Object.isFrozen(log.entries) && Object.isFrozen(decision))
})

test('T-FR-065 rejects ambiguous candidates and detects persisted-log tampering', () => {
  const log = logFixture()
  const input = { ...log.entries[0], candidates: [{ id: 'a-candidate', outcome: 'selected', reason: 'a' }, { id: 'b-candidate', outcome: 'selected', reason: 'b' }] }
  delete input.schemaVersion
  delete input.decisionHash
  assert.throws(() => createDirectorDecision(input), /exactly one selected/)
  assert.deepEqual(parseDirectorDecisionLog(JSON.parse(JSON.stringify(log))), log)
  const tampered = JSON.parse(JSON.stringify(log))
  tampered.entries[0].confidence = .1
  assert.throws(() => parseDirectorDecisionLog(tampered), /hash/)
})

test('T-FR-065 traces a decision to exact half-open final frame ranges and fails closed without lineage', () => {
  const decision = logFixture().entries[0]
  const trace = traceDecisionToFrames({ decision, artifactId: 'artifact-final-1', projectVersionId: 'version-2', fps: 30, planNodeSourceIds: ['clip-proof'], frameMap: [{ clipId: 'clip-proof', frame: 2 }, { clipId: 'other-clip', frame: 3 }, { clipId: 'clip-proof', frame: 1 }, { clipId: 'clip-proof', frame: 5 }] })
  assert.deepEqual(trace.frameRanges, [{ fromFrame: 1, toFrame: 3, rangeMs: [33, 100] }, { fromFrame: 5, toFrame: 6, rangeMs: [166, 200] }])
  assert.equal(trace.artifactId, 'artifact-final-1')
  assert.throws(() => traceDecisionToFrames({ decision, artifactId: 'artifact-final-1', projectVersionId: 'version-2', fps: 30, planNodeSourceIds: ['clip-proof'], frameMap: [] }), /no final-frame lineage/)
  assert.throws(() => traceDecisionToFrames({ decision, artifactId: 'artifact-final-1', projectVersionId: 'stale-version', fps: 30, planNodeSourceIds: ['clip-proof'], frameMap: [] }), /stale/)
})

test('T-FR-065 exposes compact and detailed read projections with scoped authorization and explicit unavailable lineage', async () => {
  const log = logFixture()
  const repository = { loadLog: async () => log, loadLineage: async () => ({ status: 'unavailable', reason: 'FINAL_ARTIFACT_NOT_READY' }) }
  const listed = await listDirectorDecisionsService({ repository })({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1', actor: actor() })
  assert.equal(listed.decisions.length, 1)
  assert.equal(listed.decisions[0].summary, 'use-testimony: Best supported claim.')
  assert.equal('evidence' in listed.decisions[0], false)
  const detail = await readDirectorDecisionService({ repository })({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1', decisionId: 'decision-1', actor: actor() })
  assert.deepEqual(detail.lineage, { status: 'unavailable', reason: 'FINAL_ARTIFACT_NOT_READY' })
  await assert.rejects(() => listDirectorDecisionsService({ repository })({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1', actor: actor({ scopes: [] }) }), /scope/)
  await assert.rejects(() => listDirectorDecisionsService({ repository })({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1', actor: actor({ workspaceId: 'workspace-2' }) }), /workspace/)
})

test('T-FR-065 Prisma projection binds workspace, resolves the immutable final artifact and exact RenderElementMap frames', async () => {
  const log = logFixture()
  const map = buildRenderElementMap({ proxyHash: 'a'.repeat(64), fps: 30, durationFrames: 10, canvas: { width: 1080, height: 1920 }, source: { width: 1080, height: 1920 }, clips: [{ id: 'clip-proof', sourceArtifactId: 'source-1', timelineInFrame: 1, timelineOutFrame: 4 }] })
  const run = { id: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', commandId: 'command-7', resultVersionId: 'version-2', decisionLogJson: stableSerialize(log), decisionLogHash: log.logHash, storySnapshot: { contentJson: stableSerialize(storyPlan), contentHash: calculateCanonicalHash(storyPlan) } }
  const queries = []
  const client = {
    v2DirectorRun: { findFirst: async (query) => { queries.push(query); return query.include ? run : run } },
    v2ProjectFinalExportOperation: { findFirst: async () => ({ outputArtifactId: 'artifact-final-1', proxyArtifactId: 'artifact-proxy-1', projectVersionId: 'version-2' }) },
    v2MediaArtifact: { findFirst: async () => ({ id: 'artifact-final-1' }) },
    v2RenderElementMap: { findFirst: async () => ({ id: 'map-1', workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-2', proxyArtifactId: 'artifact-proxy-1', proxyHash: map.proxyHash, mapHash: renderElementMapHash(map), schemaVersion: map.schemaVersion, fps: map.fps, durationFrames: map.durationFrames, canvasWidth: map.canvas.width, canvasHeight: map.canvas.height, elementsJson: JSON.stringify(map.elements), createdAt: new Date('2026-07-17T20:01:00.000Z') }) },
  }
  const repository = new PrismaDirectorDecisionLogRepository(client)
  const loaded = await repository.loadLog({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1' })
  assert.equal(loaded.logHash, log.logHash)
  const context = await repository.loadLineage({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1', decisionId: 'decision-1' })
  assert.equal(context.status, 'ready')
  assert.deepEqual([...new Set(context.frameMap.map(({ frame }) => frame))], [1, 2, 3])
  assert.deepEqual(queries[0].where, { id: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1' })
  const detail = await readDirectorDecisionService({ repository })({ workspaceId: 'workspace-1', projectId: 'project-1', directorRunId: 'run-1', decisionId: 'decision-1', actor: actor() })
  assert.deepEqual(detail.lineage.trace.frameRanges, [{ fromFrame: 1, toFrame: 4, rangeMs: [33, 134] }])
})
