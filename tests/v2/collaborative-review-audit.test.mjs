import assert from 'node:assert/strict'
import test from 'node:test'

import { proposeReviewPatchService } from '../../src/v2/application/review-patch.ts'
import { proposeReviewPatchBatchService } from '../../src/v2/application/review-patch-batch.ts'
import { authenticatedActor } from './helpers/authentication-audit.mjs'

const workspaceId = 'workspace-collaborative-review'
const projectId = 'project-collaborative-review'
const versionId = 'version-collaborative-review'
const annotation = Object.freeze({
  id: 'annotation-collaborative-review',
  projectVersionId: versionId,
  proxyArtifactId: 'artifact-collaborative-review',
  proxyHash: 'a'.repeat(64),
  frame: 30,
  timeRangeMs: Object.freeze([1000, 1000]),
  screenshotRef: 'data:image/jpeg;base64,/9j/2Q==',
  scope: 'point',
  targetIds: Object.freeze(['subtitle:cue-1']),
  applicationScope: Object.freeze({
    kind: 'scene',
    targetIds: Object.freeze(['scene:clip-1']),
    formatIds: Object.freeze(['9:16']),
    localeIds: Object.freeze(['pt-BR']),
    recipeIds: Object.freeze(['proxy-review']),
    global: false,
  }),
  affectedCount: 1,
  text: 'Reposicionar a legenda abaixo do rosto.',
  author: Object.freeze({ id: 'reviewer-origin', name: 'reviewer-origin', type: 'user' }),
  status: 'open',
  createdAt: '2026-08-05T12:00:00.000Z',
})
const currentVersion = Object.freeze({
  id: versionId,
  workspaceId,
  projectId,
  sequence: 1,
  snapshotRefs: Object.freeze({
    brief: 'brief-collaborative-review',
    editPlan: 'edit-plan-collaborative-review',
    policies: 'policies-collaborative-review',
  }),
  baseHash: 'b'.repeat(64),
  createdBy: 'client-collaborative-review',
  createdAt: '2026-08-05T12:00:00.000Z',
})
const actor = authenticatedActor({
  clientId: 'client-collaborative-review',
  credentialId: 'credential-collaborative-review',
  workspaceId,
})
const otherCredential = authenticatedActor({
  clientId: actor.clientId,
  credentialId: 'credential-collaborative-other',
  workspaceId,
})

function proposalRepositoryFixture() {
  const idempotency = new Map()
  return {
    async readProposalContext() {
      return Object.freeze({
        annotation,
        currentVersion,
        editPlan: Object.freeze({ protectedElements: [] }),
        editPlanHash: 'c'.repeat(64),
        policies: Object.freeze({}),
        availableAssetIds: Object.freeze([]),
        renderVariantIds: Object.freeze(['9:16']),
        outputReferences: Object.freeze([]),
      })
    },
    async findProposalIdempotent({ idempotencyKey }) {
      return idempotency.get(idempotencyKey) ?? null
    },
    async createProposal(input) {
      idempotency.set(input.idempotencyKey, Object.freeze({
        requestFingerprint: input.requestFingerprint,
        proposal: input.proposal,
      }))
      return input.proposal
    },
  }
}

test('T-FR-242 review proposal is credential-bound before editorial application', async () => {
  const repository = proposalRepositoryFixture()
  let sequence = 0
  const propose = proposeReviewPatchService({
    repository,
    clock: () => new Date('2026-08-05T12:01:00.000Z'),
    createId: (kind) => `${kind}-${++sequence}`,
  })
  const request = {
    workspaceId,
    projectId,
    annotationId: annotation.id,
    actor,
    idempotencyKey: 'collaborative-proposal-key',
  }
  const first = await propose(request)
  const replay = await propose(request)
  assert.equal(first.proposal.status, 'ready')
  assert.equal(first.proposal.authenticationAudit.credentialId, actor.credentialId)
  assert.equal(replay.replayed, true)
  await assert.rejects(
    () => propose({ ...request, actor: otherCredential }),
    (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const secondAnnotation = Object.freeze({
    ...annotation,
    id: 'annotation-collaborative-review-second',
  })
  const secondProposal = Object.freeze({
    ...first.proposal,
    id: 'review-patch-proposal-second',
    annotationId: secondAnnotation.id,
    patch: Object.freeze({
      ...first.proposal.patch,
      id: 'patch-collaborative-review-second',
      annotationIds: Object.freeze([secondAnnotation.id]),
    }),
  })
  const batchIdempotency = new Map()
  const batchRepository = {
    async readProposalSet() {
      return Object.freeze({
        currentVersion,
        editPlan: Object.freeze({}),
        editPlanHash: 'c'.repeat(64),
        availableAssetIds: Object.freeze([]),
        renderVariantIds: Object.freeze(['9:16']),
        outputReferences: Object.freeze([]),
        entries: Object.freeze([
          Object.freeze({ annotation, proposal: first.proposal }),
          Object.freeze({ annotation: secondAnnotation, proposal: secondProposal }),
        ]),
      })
    },
    async findBatchIdempotent({ idempotencyKey }) {
      return batchIdempotency.get(idempotencyKey) ?? null
    },
    async createBatch(input) {
      batchIdempotency.set(input.idempotencyKey, Object.freeze({
        requestFingerprint: input.requestFingerprint,
        batch: input.batch,
      }))
      return input.batch
    },
  }
  let batchSequence = 0
  const proposeBatch = proposeReviewPatchBatchService({
    repository: batchRepository,
    clock: () => new Date('2026-08-05T12:02:00.000Z'),
    createId: (kind) => `${kind}-${++batchSequence}`,
  })
  const batchRequest = {
    workspaceId,
    projectId,
    proposalIds: [first.proposal.id, secondProposal.id],
    actor,
    idempotencyKey: 'collaborative-batch-key',
  }
  const firstBatch = await proposeBatch(batchRequest)
  const batchReplay = await proposeBatch(batchRequest)
  assert.equal(firstBatch.batch.authenticationAudit.contextHash, first.proposal.authenticationAudit.contextHash)
  assert.equal(batchReplay.replayed, true)
  await assert.rejects(
    () => proposeBatch({ ...batchRequest, actor: otherCredential }),
    (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})
