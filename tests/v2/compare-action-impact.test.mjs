import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { decideVersionComparisonService } from '../../src/v2/application/version-compare.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import {
  createCompareActionImpact,
  parseCompareActionImpact,
} from '../../src/v2/domain/compare-action-impact.ts'
import { versionComparisonFromEditPlans } from '../../src/v2/domain/manual-editing.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const workspaceId = 'workspace-compare-1'
const projectId = 'project-compare-1'
const beforeVersionId = 'project-version-compare-1'
const afterVersionId = 'project-version-compare-2'
const commandId = 'edit-command-compare-1'
const baseHash = 'a'.repeat(64)
const createdAt = '2026-07-31T20:00:00.000Z'

function impact(action = 'accept', overrides = {}) {
  return createCompareActionImpact({
    commandId,
    baseVersionId: afterVersionId,
    resultVersionId: afterVersionId,
    action,
    ...overrides,
  })
}

/** A stored document: canonically serialized and read back, key order and all. */
function persisted(document) {
  return JSON.parse(stableSerialize(document))
}

test('T-F0-027 the compare action impact is an explicit zero with a preserved version', () => {
  const document = impact()
  assert.equal(document.schemaVersion, 'compare-action-impact/v1')
  assert.equal(document.commandType, 'compare-action')
  assert.equal(document.commandId, commandId)
  assert.equal(document.action, 'accept')
  assert.equal(document.baseVersionId, afterVersionId)
  assert.equal(document.resultVersionId, afterVersionId, 'accept creates no version')
  assert.equal(document.renderSemanticsChanged, false)
  assert.deepEqual([...document.changeKinds], ['review-state'])
  for (const field of [
    'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders',
  ]) {
    assert.deepEqual([...document[field]], [], `${field} must be empty`)
    assert.ok(Object.isFrozen(document[field]), `${field} must be frozen`)
  }
  assert.ok(Object.isFrozen(document))
  assert.match(document.impactHash, /^[a-f0-9]{64}$/)
})

test('T-F0-027 the impact hash is content-addressed over the whole body', () => {
  assert.equal(impact('accept').impactHash, impact('accept').impactHash)
  assert.notEqual(impact('accept').impactHash, impact('reopen').impactHash)
  assert.notEqual(
    impact('accept').impactHash,
    impact('accept', { commandId: 'edit-command-compare-2' }).impactHash,
  )
  assert.notEqual(
    impact('accept').impactHash,
    impact('accept', { baseVersionId: beforeVersionId, resultVersionId: beforeVersionId }).impactHash,
  )
})

test('T-F0-027 the factory refuses a compare action that would replace its version', () => {
  assert.throws(
    () => createCompareActionImpact({
      commandId, baseVersionId: afterVersionId, resultVersionId: beforeVersionId, action: 'accept',
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT')
      assert.match(error.message, /preserves its base version/)
      return true
    },
  )
  for (const action of ['restore', 'apply', '', undefined]) {
    assert.throws(() => createCompareActionImpact({
      commandId, baseVersionId: afterVersionId, resultVersionId: afterVersionId, action,
    }), /Compare action is invalid/)
  }
  for (const badId of ['', 'ab', 'has space', 42, null]) {
    assert.throws(() => createCompareActionImpact({
      commandId: badId, baseVersionId: afterVersionId, resultVersionId: afterVersionId, action: 'accept',
    }), /commandId is invalid/)
  }
})

test('T-F0-027 the parser accepts a canonical round trip and nothing else', () => {
  const document = impact('reopen')
  const parsed = parseCompareActionImpact(persisted(document))
  assert.equal(parsed.impactHash, document.impactHash)
  assert.equal(parsed.action, 'reopen')

  for (const value of [null, undefined, 'text', 42, [], [document]]) {
    assert.throws(() => parseCompareActionImpact(value), /must be an object/)
  }
})

test('T-F0-027 a tampered compare action impact fails closed', () => {
  const stored = persisted(impact())
  const cases = {
    'flipped render semantics': { ...stored, renderSemanticsChanged: true },
    'borrowed command type': { ...stored, commandType: 'manual-edit' },
    'borrowed schema version': { ...stored, schemaVersion: 'command-impact/v1' },
    'flipped action without rehash': { ...stored, action: 'reopen' },
    'replaced version': { ...stored, resultVersionId: beforeVersionId },
    'smuggled artifact': {
      ...stored,
      affectedArtifacts: [{ artifactId: 'artifact-1', sourceVersionId: afterVersionId, variantId: '9:16', kind: 'proxy' }],
    },
    'smuggled range': { ...stored, affectedRanges: [{ startFrame: 0, endFrame: 180 }] },
    'smuggled render': { ...stored, minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [] }] },
    'smuggled dependency': { ...stored, dependencyTypes: ['visual'] },
    'smuggled variant': { ...stored, affectedVariantIds: ['9:16'] },
    'foreign change kind': { ...stored, changeKinds: ['director-replan'] },
    'forged hash': { ...stored, impactHash: 'b'.repeat(64) },
    'unhashed field': { ...stored, extra: true },
    'missing field': Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'action')),
  }
  for (const [name, document] of Object.entries(cases)) {
    assert.throws(() => parseCompareActionImpact(document), (error) => {
      assert.equal(error.name, 'DomainError', name)
      assert.equal(error.code, 'PERSISTENCE_CONFLICT', name)
      return true
    }, `${name} must fail closed`)
  }
})

function editPlan(versionId, durationFrames) {
  return {
    schemaVersion: 2,
    state: 'compiled',
    id: `edit-plan-${versionId}`,
    projectVersionId: versionId,
    fps: 30,
    durationFrames,
    sources: [{ id: 'source-1', artifactId: 'source-1', kind: 'video', durationSeconds: 6 }],
    videoTracks: [{
      id: 'base-video',
      kind: 'base-video',
      clips: [{
        id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0,
        sourceOutFrame: durationFrames, timelineInFrame: 0, timelineOutFrame: durationFrames, rate: 1,
      }],
    }],
    overlayTracks: [],
    subtitleTracks: [],
    audioTracks: [], effectTracks: [], markers: [], transitions: [],
    protectedElements: [], localeVariantRefs: [], formatVariantRefs: [], lineageRefs: ['source-1'],
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 0 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
    composition: { layout: 'fit', background: 'black', foregroundScale: 1, verticalPosition: 0.5 },
    director: { plannerVersion: 'compare-test', decisions: [], assumptions: [] },
    createdAt,
  }
}

/**
 * Fakes that record everything the decision touches. A render enqueue or an
 * artifact invalidation would have to appear here to exist at all.
 */
function harness() {
  const versions = {
    [beforeVersionId]: { sequence: 1, editPlan: editPlan(beforeVersionId, 180), editPlanHash: 'c'.repeat(64) },
    [afterVersionId]: { sequence: 2, editPlan: editPlan(afterVersionId, 120), editPlanHash: 'd'.repeat(64) },
  }
  const enqueuedRenders = []
  const artifactInvalidations = []
  const committed = []
  const stored = new Map()
  const manualEditRepository = {
    async readContext({ targetVersionId }) {
      const target = versions[targetVersionId]
      if (!target) return null
      return {
        version: { id: afterVersionId, baseHash, sequence: 2 },
        targetVersion: {
          version: { id: targetVersionId, sequence: target.sequence },
          editPlan: target.editPlan,
          editPlanHash: target.editPlanHash,
        },
      }
    },
    async enqueueProxyRender(input) {
      enqueuedRenders.push(input)
    },
    async recordArtifactInvalidations(input) {
      artifactInvalidations.push(input)
    },
  }
  const comparisonRepository = {
    async findIdempotentDecision({ idempotencyKey }) {
      return stored.get(idempotencyKey) ?? null
    },
    async commitDecision(bundle) {
      committed.push(bundle)
      // Persistence round trip: what the reader gets back is what was serialized.
      const payload = JSON.parse(stableSerialize(bundle.command.payload))
      const result = Object.freeze({
        command: Object.freeze({ ...bundle.command, payload }),
        projectStatus: bundle.projectStatus,
        comparison: payload.comparison,
        impact: parseCompareActionImpact(payload.impact),
        replayed: false,
      })
      stored.set(bundle.command.idempotencyKey, {
        requestFingerprint: bundle.requestFingerprint,
        result,
      })
      return result
    },
  }
  let commandSequence = 0
  const decide = decideVersionComparisonService({
    comparisonRepository,
    manualEditRepository,
    clock: () => new Date(createdAt),
    createCommandId: () => `edit-command-compare-${++commandSequence}`,
    createEventId: randomUUID,
  })
  return { decide, enqueuedRenders, artifactInvalidations, committed, stored }
}

function request(action, overrides = {}) {
  return {
    workspaceId,
    projectId,
    beforeVersionId,
    afterVersionId,
    mode: 'split',
    action,
    baseVersionId: afterVersionId,
    baseHash,
    expectedRevision: 2,
    actor: { type: 'api-client', id: 'client-compare-1' },
    idempotencyKey: `compare-${action}-key`,
    ...overrides,
  }
}

test('T-F0-027 accept and reopen persist schemaVersion 2 with the zero impact', async () => {
  for (const [action, projectStatus] of [['accept', 'reviewing-proxy'], ['reopen', 'revising']]) {
    const context = harness()
    const result = await context.decide(request(action))
    assert.equal(result.projectStatus, projectStatus)
    assert.equal(result.replayed, false)
    assert.equal(result.command.type, 'compare-action')
    assert.equal(result.command.payload.schemaVersion, 2)
    assert.equal(result.command.payload.action, action)

    const document = result.command.payload.impact
    assert.equal(document.schemaVersion, 'compare-action-impact/v1')
    assert.equal(document.commandId, result.command.id)
    assert.equal(document.action, action)
    assert.equal(document.baseVersionId, afterVersionId)
    assert.equal(document.resultVersionId, afterVersionId)
    assert.equal(document.renderSemanticsChanged, false)
    assert.deepEqual([...document.affectedArtifacts], [])
    assert.equal(result.impact.impactHash, document.impactHash, 'the service and the reader agree')

    const [bundle] = context.committed
    assert.deepEqual(
      Object.keys(bundle).toSorted(),
      ['command', 'event', 'projectStatus', 'requestFingerprint'],
      'a compare decision commits nothing but the Command, its status and its event',
    )
    assert.equal(bundle.event.data.commandImpactHash, document.impactHash)
    assert.equal(bundle.event.data.artifactInvalidationCount, 0)
    assert.equal(bundle.event.data.versionsPreserved, true)
    assert.equal(bundle.event.data.compareAction, action)

    assert.deepEqual(context.enqueuedRenders, [], `${action} must enqueue no render`)
    assert.deepEqual(context.artifactInvalidations, [], `${action} must invalidate no artifact`)
  }
})

test('T-F0-027 replaying a compare decision returns the stored impact unchanged', async () => {
  const context = harness()
  const first = await context.decide(request('accept'))
  const replay = await context.decide(request('accept'))
  assert.equal(replay.replayed, true)
  assert.equal(replay.command.id, first.command.id)
  assert.equal(replay.impact.impactHash, first.impact.impactHash)
  assert.equal(context.committed.length, 1, 'a replay commits nothing new')
  assert.deepEqual(context.enqueuedRenders, [])
})

test('T-F0-027 a stale base is rejected before any impact is built', async () => {
  const context = harness()
  await assert.rejects(
    () => context.decide(request('accept', { expectedRevision: 1 })),
    (error) => {
      assert.equal(error.code, 'VERSION_CONFLICT')
      return true
    },
  )
  await assert.rejects(
    () => context.decide(request('accept', { baseHash: 'e'.repeat(64) })),
    (error) => {
      assert.equal(error.code, 'VERSION_CONFLICT')
      return true
    },
  )
  await assert.rejects(
    () => context.decide(request('accept', { baseVersionId: beforeVersionId })),
    (error) => {
      assert.equal(error.code, 'VERSION_CONFLICT')
      return true
    },
  )
  assert.deepEqual(context.committed, [])
})

test('T-F0-027 the compare decision path never reaches a render or an invalidation', async () => {
  const sources = await Promise.all([
    '../../src/v2/application/version-compare.ts',
    '../../src/v2/infrastructure/prisma/version-compare-repository.ts',
  ].map((path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')))
  for (const source of sources) {
    assert.doesNotMatch(source, /v2CommandArtifactInvalidation/)
    assert.doesNotMatch(source, /ProxyRender/)
    assert.doesNotMatch(source, /enqueue/i)
  }
})

test('T-F0-027 and T-FR-236 preserve accept impact and expose restored version state under result schema v4', () => {
  const capability = FOUNDATION_CAPABILITIES
    .find((item) => item.id === 'apollo.projects.version-comparisons.act')
  assert.equal(capability.version, '4.0.0')
  assert.equal(
    capability.outputSchemaRef,
    'apollo://schemas/project-version-comparison-action-result/v4',
  )
  // The previous major stays published for clients that have not migrated.
  assert.equal(
    getPublicSchema('apollo://schemas/project-version-comparison-action-result/v3').ref,
    'apollo://schemas/project-version-comparison-action-result/v3',
  )
  assert.equal(
    getPublicSchema('apollo://schemas/project-version-comparison-action-request/v1').ref,
    'apollo://schemas/project-version-comparison-action-request/v1',
  )

  const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
  const validate = ajv.compile(getPublicSchema(capability.outputSchemaRef).schema)
  const document = impact()
  const body = {
    data: {
      action: 'accept',
      command: {
        id: commandId,
        type: 'compare-action',
        baseVersionId: afterVersionId,
        scope: { project: true },
        payload: { schemaVersion: 2, action: 'accept', impact: document },
        createdAt,
      },
      projectStatus: 'reviewing-proxy',
      comparison: JSON.parse(JSON.stringify(versionComparisonFromEditPlans({
        before: { id: beforeVersionId, editPlan: editPlan(beforeVersionId, 180) },
        after: { id: afterVersionId, editPlan: editPlan(afterVersionId, 120) },
        mode: 'split',
      }))),
      impact: document,
      versionsPreserved: true,
      replayed: false,
    },
    meta: { apiVersion: 'v1' },
  }
  assert.equal(validate(body), true, ajv.errorsText(validate.errors))

  // The impact is not decorative: a render-bearing document is refused.
  assert.equal(
    validate({ ...body, data: { ...body.data, impact: { ...document, renderSemanticsChanged: true } } }),
    false,
  )
  assert.equal(
    validate({ ...body, data: { ...body.data, impact: { ...document, affectedArtifacts: [{ artifactId: 'a-1' }] } } }),
    false,
  )
  const { impact: _removed, ...withoutImpact } = body.data
  assert.equal(validate({ ...body, data: withoutImpact }), false, 'impact is required in v4')

  const examples = publicSchemaExamples(getPublicSchema(capability.outputSchemaRef))
  assert.equal(examples.length, 2)
  for (const example of examples) {
    assert.equal(validate(example), true, ajv.errorsText(validate.errors))
  }
  const restore = structuredClone(examples.find((example) => example.data.action === 'restore'))
  assert.equal(restore.data.version.visibleState.label, 'current')
  restore.data.version.visibleState.label = 'superseded'
  assert.equal(validate(restore), false)
})
