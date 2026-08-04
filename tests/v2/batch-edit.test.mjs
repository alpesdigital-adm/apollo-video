import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commitBatchEditService,
  createBatchEditPreflightService,
} from '../../src/v2/application/batch-edits.ts'
import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  createBatchEditCommand,
  createBatchEditItemState,
  createBatchEditPolicy,
  createBatchEditPreflight,
  hydrateBatchEditCommand,
  hydrateBatchEditPreflight,
} from '../../src/v2/domain/batch-edit.ts'
import {
  HmacPreflightCommitTokenIssuer,
} from '../../src/v2/infrastructure/security/preflight-commit-token.ts'
import { batchActorAuditData, hydrateBatchActorAudit } from '../../src/v2/infrastructure/prisma/batch-actor-audit.ts'

const workspaceId = 'batch-edit-workspace'
const batchId = 'batch-edit-batch'
const projectId = 'batch-edit-project'
const clientId = 'batch-edit-client'
const createdAt = '2026-07-28T12:40:00.000Z'
const definitionHash = 'a'.repeat(64)

function authenticatedActor(credentialId = 'batch-edit-credential') {
  const auditContext = createExternalAuditContext({
    clientId,
    credentialId,
    workspaceId,
    environment: 'production',
  })
  return Object.freeze({
    clientId,
    credentialId,
    workspaceId,
    environment: 'production',
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

test('T-FR-242 batch audit tuple is canonical and fails closed on missing or tampered persistence', () => {
  const actor = authenticatedActor()
  const audit = materializeActorAuditContext(actor)
  const stored = {
    workspaceId,
    ...batchActorAuditData(audit, workspaceId, clientId),
    delegatedUserId: null,
    delegatedIdentityId: null,
    workspaceRole: null,
  }
  assert.deepEqual(hydrateBatchActorAudit(stored, clientId), audit)
  assert.throws(
    () => hydrateBatchActorAudit({ ...stored, actorContextHash: '0'.repeat(64) }, clientId),
    /audit hash is inconsistent/,
  )
  assert.throws(
    () => hydrateBatchActorAudit({ ...stored, actorCredentialId: null }, clientId),
    /predates credential-bound audit/,
  )
})

function policy(overrides = {}) {
  return createBatchEditPolicy({
    workspaceId,
    updatedByClientId: clientId,
    updatedAt: createdAt,
    ...overrides,
  })
}

function state(itemId, options = {}) {
  return createBatchEditItemState({
    workspaceId,
    batchId,
    itemId,
    createdByClientId: clientId,
    createdAt,
    ...options,
  })
}

function contexts(options = {}) {
  return [
    {
      itemId: 'item-vertical-one',
      recipeId: 'recipe-one',
      variantId: 'variant-vertical',
      outputSpecId: '9:16',
      locale: 'pt-BR',
      state: state('item-vertical-one', options.first),
    },
    {
      itemId: 'item-square-one',
      recipeId: 'recipe-one',
      variantId: 'variant-square',
      outputSpecId: '1:1',
      locale: 'pt-BR',
      state: state('item-square-one', options.second),
    },
    {
      itemId: 'item-vertical-two',
      recipeId: 'recipe-two',
      variantId: 'variant-vertical',
      outputSpecId: '9:16',
      locale: 'pt-BR',
      state: state('item-vertical-two', options.third),
    },
  ]
}

function preflightInput(overrides = {}) {
  const items = overrides.items ?? contexts()
  return {
    id: overrides.id ?? 'batch-edit-preflight-one',
    workspaceId,
    projectId,
    batchId,
    batchRevision: 1,
    batchDefinitionHash: definitionHash,
    policy: overrides.policy ?? policy(),
    mode: overrides.mode ?? 'all-or-nothing',
    operation: overrides.operation ?? {
      type: 'replace-cta',
      valueRef: 'cta-new',
    },
    recipeIds: overrides.recipeIds ??
      [...new Set(items.map((item) => item.recipeId))],
    outputSpecIds: overrides.outputSpecIds ??
      [...new Set(items.map((item) => item.outputSpecId))],
    itemIds: overrides.itemIds ??
      items.map((item) => item.itemId),
    availableRecipeIds: ['recipe-one', 'recipe-two'],
    availableOutputSpecIds: ['9:16', '1:1'],
    availableItemIds: [
      'item-vertical-one',
      'item-square-one',
      'item-vertical-two',
    ],
    items,
    budgetRemainingMinorUnits:
      overrides.budgetRemainingMinorUnits ?? 10_000,
    createdByClientId: clientId,
    createdAt,
  }
}

test('T-FR-086 previews exact recipe, format and target scope for CTA, subtitle and Brand Kit', () => {
  const expectations = [
    ['replace-cta', 'cta-campaign-b', 4, 125],
    ['subtitle-style', 'subtitle-bold-v2', 2, 25],
    ['brand-kit', 'brand-kit-snapshot-v7', 3, 75],
  ]
  for (const [type, valueRef, invalidatedSteps, unitCost] of expectations) {
    const run = createBatchEditPreflight(preflightInput({
      id: `batch-edit-preflight-${type}`,
      operation: { type, valueRef },
    }))
    assert.equal(run.status, 'ready')
    assert.equal(run.affectedItemCount, 3)
    assert.equal(run.applicableItemCount, 3)
    assert.equal(run.protectedConflictCount, 0)
    assert.equal(run.invalidationCount, invalidatedSteps * 3)
    assert.equal(run.estimatedCostMinorUnits, unitCost * 3)
    assert.equal(run.sampleDiff.length, 3)
    assert.deepEqual(run.scope.recipeIds, [
      'recipe-one',
      'recipe-two',
    ])
    assert.deepEqual(run.scope.outputSpecIds, ['1:1', '9:16'])
    assert.ok(run.impacts.every((item) =>
      item.invalidatedSteps.length === invalidatedSteps))
    assert.equal(
      hydrateBatchEditPreflight(run).preflightHash,
      run.preflightHash,
    )
  }
})

test('T-FR-086 blocks atomic protected edits and makes skip-failures explicit', () => {
  const items = contexts({
    second: { protectedOperations: ['replace-cta'] },
  })
  const atomic = createBatchEditPreflight(preflightInput({
    id: 'batch-edit-preflight-atomic',
    items,
    mode: 'all-or-nothing',
  }))
  assert.equal(atomic.status, 'blocked')
  assert.equal(atomic.protectedConflictCount, 1)
  assert.equal(atomic.confirmationExpiresAt, undefined)
  assert.throws(
    () => createBatchEditCommand({
      id: 'batch-edit-command-blocked',
      preflight: atomic,
      currentStates: items.map((item) => item.state),
      createdByClientId: clientId,
      createdAt: '2026-07-28T12:41:00.000Z',
    }),
    /not committable/,
  )

  const partial = createBatchEditPreflight(preflightInput({
    id: 'batch-edit-preflight-partial',
    items,
    mode: 'skip-failures',
  }))
  assert.equal(partial.status, 'partial-ready')
  assert.equal(partial.applicableItemCount, 2)
  assert.equal(partial.estimatedCostMinorUnits, 250)
  assert.equal(
    partial.impacts.find((item) =>
      item.itemId === 'item-square-one').disposition,
    'protected',
  )
  const command = createBatchEditCommand({
    id: 'batch-edit-command-partial',
    preflight: partial,
    currentStates: items.map((item) => item.state),
    createdByClientId: clientId,
    createdAt: '2026-07-28T12:41:00.000Z',
  })
  assert.equal(command.status, 'partial')
  assert.equal(command.appliedItemCount, 2)
  assert.equal(command.skippedItemCount, 1)
  assert.equal(command.newStates.length, 2)
  assert.equal(command.invalidationCount, 8)
  assert.equal(command.costMinorUnits, 250)
  assert.equal(
    command.resultItems.find((item) =>
      item.itemId === 'item-square-one').status,
    'skipped',
  )
  assert.ok(command.newStates.every((item) =>
    item.directives.ctaRef === 'cta-new' &&
    item.sourceCommandId === command.id))
  assert.equal(
    hydrateBatchEditCommand(command).commandHash,
    command.commandHash,
  )
})

test('T-FR-086 exposes sampled diff, no-change and budget failures without committing', () => {
  const existing = contexts({
    first: { directives: { subtitleStyleId: 'subtitle-bold-v2' } },
  })
  const noChange = createBatchEditPreflight(preflightInput({
    id: 'batch-edit-preflight-no-change',
    items: [existing[0]],
    recipeIds: ['recipe-one'],
    outputSpecIds: ['9:16'],
    itemIds: ['item-vertical-one'],
    operation: {
      type: 'subtitle-style',
      valueRef: 'subtitle-bold-v2',
    },
  }))
  assert.equal(noChange.status, 'no-change')
  assert.equal(noChange.unchangedItemCount, 1)
  assert.equal(noChange.estimatedCostMinorUnits, 0)
  assert.deepEqual(noChange.sampleDiff[0].before, {
    mode: 'override',
    valueRef: 'subtitle-bold-v2',
  })
  assert.ok(noChange.warningCodes.includes('NO_EFFECTIVE_CHANGE'))

  const budget = createBatchEditPreflight(preflightInput({
    id: 'batch-edit-preflight-budget',
    operation: {
      type: 'brand-kit',
      valueRef: 'brand-kit-snapshot-v7',
    },
    budgetRemainingMinorUnits: 100,
  }))
  assert.equal(budget.status, 'blocked')
  assert.equal(budget.budgetExceeded, true)
  assert.equal(budget.estimatedCostMinorUnits, 225)
  assert.ok(budget.warningCodes.includes('BUDGET_EXCEEDED'))
  assert.equal(budget.confirmationExpiresAt, undefined)
})

test('T-FR-086 rejects hidden scope, state drift and persisted tampering', () => {
  const items = contexts()
  assert.throws(
    () => createBatchEditPreflight(preflightInput({
      id: 'batch-edit-preflight-hidden-scope',
      items: [items[0]],
      recipeIds: ['recipe-one', 'recipe-two'],
      outputSpecIds: ['9:16'],
      itemIds: ['item-vertical-one'],
    })),
    /explicitly and exactly match/,
  )
  const run = createBatchEditPreflight(preflightInput({
    id: 'batch-edit-preflight-drift',
    items,
  }))
  const changed = createBatchEditItemState({
    workspaceId,
    batchId,
    itemId: items[0].itemId,
    revision: 2,
    directives: { brandKitSnapshotId: 'brand-kit-external-change' },
    previousStateHash: items[0].state.stateHash,
    sourceCommandId: 'external-command',
    createdByClientId: clientId,
    createdAt: '2026-07-28T12:40:30.000Z',
  })
  assert.throws(
    () => createBatchEditCommand({
      id: 'batch-edit-command-stale',
      preflight: run,
      currentStates: [
        changed,
        items[1].state,
        items[2].state,
      ],
      createdByClientId: clientId,
      createdAt: '2026-07-28T12:41:00.000Z',
    }),
    /changed after preflight/,
  )
  assert.throws(
    () => hydrateBatchEditPreflight({
      ...run,
      estimatedCostMinorUnits: run.estimatedCostMinorUnits + 1,
    }),
    /inconsistent/,
  )
})

test('T-FR-086 application service binds signed commit, actor, scope and idempotency to one immutable preflight', async () => {
  const itemContexts = contexts()
  const itemStates = new Map(
    itemContexts.map((item) => [item.itemId, item.state]),
  )
  const preflights = new Map()
  const preflightReplays = new Map()
  const commands = new Map()
  const commandReplays = new Map()
  let storedPolicy
  let preflightSequence = 0
  let commandSequence = 0

  const repository = {
    async loadPreflightContext(input) {
      assert.equal(input.expectedBatchRevision, 1)
      assert.equal(input.expectedBatchDefinitionHash, definitionHash)
      return {
        projectId,
        batchRevision: 1,
        batchDefinitionHash: definitionHash,
        availableRecipeIds: ['recipe-one', 'recipe-two'],
        availableOutputSpecIds: ['1:1', '9:16'],
        availableItemIds: itemContexts.map((item) => item.itemId),
        items: itemContexts.filter((item) =>
          input.itemIds.includes(item.itemId)),
        budgetRemainingMinorUnits: 10_000,
      }
    },
    async loadCommitStates(input) {
      return input.itemIds.map((itemId) => itemStates.get(itemId))
    },
    async readPolicy() {
      return storedPolicy ?? null
    },
    async ensurePolicy(value) {
      storedPolicy = value
      return value
    },
    async findPreflightReplay({ idempotencyKey }) {
      return preflightReplays.get(idempotencyKey) ?? null
    },
    async createPreflight(record) {
      preflights.set(record.run.id, record)
      preflightReplays.set(record.idempotencyKey, {
        run: record.run,
        requestFingerprint: record.requestFingerprint,
      })
      return { run: record.run, replayed: false }
    },
    async readPreflightRecord({ preflightId }) {
      return preflights.get(preflightId) ?? null
    },
    async listPreflights() {
      return {
        preflights: [...preflights.values()].map((entry) => entry.run),
      }
    },
    async findCommandReplay({ idempotencyKey }) {
      return commandReplays.get(idempotencyKey) ?? null
    },
    async commit(record) {
      for (const next of record.command.newStates) {
        itemStates.set(next.itemId, next)
      }
      commands.set(record.command.id, record.command)
      commandReplays.set(record.idempotencyKey, {
        command: record.command,
        requestFingerprint: record.requestFingerprint,
      })
      return { command: record.command, replayed: false }
    },
    async readCommand({ commandId }) {
      return commands.get(commandId) ?? null
    },
    async listCommands() {
      return { commands: [...commands.values()] }
    },
  }
  const issuer = new HmacPreflightCommitTokenIssuer(
    'batch-edit-application-test-secret-32-bytes',
  )
  const clock = () => new Date(createdAt)
  const createPreflight = createBatchEditPreflightService({
    repository,
    tokenIssuer: issuer,
    clock,
    createPreflightId: () =>
      `batch-edit-service-preflight-${++preflightSequence}`,
  })
  const request = {
    workspaceId,
    batchId,
    expectedBatchRevision: 1,
    expectedBatchDefinitionHash: definitionHash,
    recipeIds: ['recipe-two', 'recipe-one'],
    outputSpecIds: ['9:16', '1:1'],
    itemIds: itemContexts.map((item) => item.itemId).toReversed(),
    operation: {
      type: 'subtitle-style',
      valueRef: 'subtitle-editorial-v3',
    },
    actor: authenticatedActor(),
    idempotencyKey: 'batch-edit-preflight-idempotency',
  }
  const preview = await createPreflight(request)
  assert.equal(preview.replayed, false)
  assert.equal(preview.run.status, 'ready')
  assert.ok(preview.commitToken)
  assert.equal(
    preflights.get(preview.run.id).authenticationAudit.credentialId,
    'batch-edit-credential',
  )
  assert.deepEqual(preview.run.scope.recipeIds, [
    'recipe-one',
    'recipe-two',
  ])
  assert.deepEqual(preview.run.scope.outputSpecIds, ['1:1', '9:16'])

  const previewReplay = await createPreflight(request)
  assert.equal(previewReplay.replayed, true)
  assert.equal(previewReplay.run.preflightHash, preview.run.preflightHash)
  assert.equal(previewReplay.commitToken, preview.commitToken)
  await assert.rejects(
    () => createPreflight({
      ...request,
      actor: authenticatedActor('batch-edit-other-credential'),
    }),
    /different batch edit preflight request/,
  )

  const commit = commitBatchEditService({
    repository,
    tokenIssuer: issuer,
    clock,
    createCommandId: () =>
      `batch-edit-service-command-${++commandSequence}`,
  })
  const commitRequest = {
    workspaceId,
    batchId,
    preflightId: preview.run.id,
    expectedPreflightHash: preview.run.preflightHash,
    expectedScopeHash: preview.run.scope.scopeHash,
    commitToken: preview.commitToken,
    actor: authenticatedActor(),
    idempotencyKey: 'batch-edit-command-idempotency',
  }
  await assert.rejects(
    () => commit({
      ...commitRequest,
      commitToken: `${preview.commitToken}tampered`,
      idempotencyKey: 'batch-edit-command-tampered',
    }),
    /token is invalid/,
  )
  await assert.rejects(
    () => commit({
      ...commitRequest,
      expectedScopeHash: 'f'.repeat(64),
      idempotencyKey: 'batch-edit-command-stale-scope',
    }),
    /explicit scope is stale/,
  )

  const committed = await commit(commitRequest)
  assert.equal(committed.replayed, false)
  assert.equal(committed.command.appliedItemCount, 3)
  assert.equal(committed.command.invalidationCount, 6)
  assert.ok(committed.command.newStates.every((item) =>
    item.directives.subtitleStyleId === 'subtitle-editorial-v3'))

  const committedReplay = await commit(commitRequest)
  assert.equal(committedReplay.replayed, true)
  assert.equal(
    committedReplay.command.commandHash,
    committed.command.commandHash,
  )
  assert.equal(commandSequence, 1)
})
