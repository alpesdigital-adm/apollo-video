import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  EDIT_COMMAND_IMPACT_SCHEMAS,
  EDIT_COMMAND_POLICIES,
  EDIT_COMMAND_RENDER_POLICIES,
  EDIT_COMMAND_TYPES,
  editCommandPolicy,
  editCommandRenderPolicy,
  editCommandTypesByRenderPolicy,
  isEditCommandType,
  requireEditCommandType,
} from '../../src/v2/domain/edit-command-registry.ts'
import { createEditCommand } from '../../src/v2/domain/edit-command.ts'
import {
  createManualCommandImpact,
  createReviewPatchCommandImpact,
  parseCommandImpact,
} from '../../src/v2/domain/command-impact.ts'
import {
  createEditorialCutImpact,
  parseEditorialCutImpact,
} from '../../src/v2/domain/editorial-cut-impact.ts'
import {
  createDirectorRunImpact,
  parseDirectorRunImpact,
} from '../../src/v2/domain/director-run-impact.ts'
import {
  createCompareActionImpact,
  parseCompareActionImpact,
} from '../../src/v2/domain/compare-action-impact.ts'
import {
  createProjectLutSelectionImpact,
  parseProjectLutSelectionImpact,
} from '../../src/v2/domain/project-lut-selection-impact.ts'
import {
  createProjectPolicyOverridesImpact,
  parseProjectPolicyOverridesImpact,
} from '../../src/v2/domain/project-policy-overrides-impact.ts'
import {
  createProjectSubtitleConfigurationImpact,
  parseProjectSubtitleConfigurationImpact,
} from '../../src/v2/domain/project-subtitle-configuration.ts'
import { subtitlePresetReference } from '../../src/v2/domain/subtitle-system.ts'
import {
  createSourceTranscriptReplacementImpact,
  parseSourceTranscriptReplacementImpact,
} from '../../src/v2/domain/source-transcript-replacement.ts'
import { materializeManualEditPlan } from '../../src/v2/domain/manual-editing.ts'

const workspaceId = 'workspace-registry-1'
const projectId = 'project-registry-1'
const baseVersionId = 'project-version-registry-1'
const resultVersionId = 'project-version-registry-2'
const createdAt = '2026-07-31T19:00:00.000Z'
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)
const durationFrames = 180

function plan(versionId = baseVersionId) {
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
      clips: [
        { id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1 },
        { id: 'clip-2', sourceArtifactId: 'source-1', sourceInFrame: 90, sourceOutFrame: 180, timelineInFrame: 90, timelineOutFrame: 180, rate: 1 },
      ],
    }],
    overlayTracks: [],
    subtitleTracks: [{
      id: 'captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom',
      faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32,
      cues: [{ id: 'cue-1', startFrame: 15, endFrame: 45, text: 'Texto original', anchor: 'bottom' }],
    }],
    audioTracks: [], effectTracks: [], markers: [], transitions: [],
    protectedElements: [], localeVariantRefs: [], formatVariantRefs: [], lineageRefs: ['source-1'],
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
    composition: { layout: 'fit', background: 'black', foregroundScale: 1, verticalPosition: 0.5 },
    director: { plannerVersion: 'registry-test', decisions: [], assumptions: [] },
    createdAt,
  }
}

const outputs = [
  { artifactId: 'artifact-proxy-9x16', kind: 'proxy', sourceVersionId: baseVersionId, variantId: '9:16' },
  { artifactId: 'artifact-final-9x16', kind: 'final', sourceVersionId: baseVersionId, variantId: '9:16' },
]

function manualImpact(overrides = {}) {
  const beforeEditPlan = plan()
  const operation = { kind: 'inspect', clipId: 'clip-1', patch: { text: 'Texto revisado' } }
  const afterEditPlan = materializeManualEditPlan({
    editPlan: beforeEditPlan, operation, newVersionId: resultVersionId, createdAt,
    availableAssetIds: ['source-1'], variantId: '9:16',
  })
  return createManualCommandImpact({
    commandId: 'edit-command-registry-manual',
    baseVersionId,
    resultVersionId,
    variantId: '9:16',
    targetId: 'clip-1',
    action: 'apply',
    operation,
    beforeEditPlan,
    afterEditPlan,
    outputReferences: outputs,
    ...overrides,
  })
}

function reviewPatchImpact(commandType) {
  return createReviewPatchCommandImpact({
    commandType,
    commandId: `edit-command-registry-${commandType}`,
    baseVersionId,
    resultVersionId,
    variantIds: ['9:16'],
    operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }],
    invalidatedRangesMs: [[1000, 1000]],
    beforeEditPlan: plan(),
    afterEditPlan: plan(resultVersionId),
    outputReferences: outputs,
  })
}

function editorialCutImpact() {
  return createEditorialCutImpact({
    commandId: 'edit-command-registry-cut',
    baseVersionId,
    resultVersionId,
    sourceTranscriptId: 'media-transcript-registry-1',
    sourceTranscriptHash: hashA,
    affectedEndFrame: durationFrames,
    renderEndFrame: 120,
    proxyVariantId: '9:16',
    outputReferences: outputs,
  })
}

function directorRunImpact() {
  return createDirectorRunImpact({
    commandId: 'edit-command-registry-director',
    baseVersionId,
    resultVersionId,
    sourceTranscriptId: 'media-transcript-registry-1',
    sourceTranscriptHash: hashA,
    plannerVersion: '1.0.0',
    criticVersion: '1.0.0',
    affectedEndFrame: durationFrames,
    renderEndFrame: 120,
    proxyVariantId: '9:16',
    outputReferences: outputs,
  })
}

function lutSelectionImpact(frames = durationFrames) {
  return createProjectLutSelectionImpact({
    commandId: 'edit-command-registry-lut',
    baseVersionId,
    resultVersionId,
    selectionId: 'project-lut-selection-registry-1',
    selectionHash: hashA,
    resolvedMode: 'none',
    intensity: 1,
    durationFrames: frames,
    proxyVariantId: '9:16',
    outputReferences: frames > 0 ? outputs : [],
  })
}

function subtitleConfigurationImpact(frames = durationFrames) {
  return createProjectSubtitleConfigurationImpact({
    commandId: 'edit-command-registry-subtitle',
    baseVersionId,
    resultVersionId,
    variantId: '9:16',
    configurationId: 'project-subtitle-configuration-registry-1',
    configurationHash: hashA,
    action: 'set',
    requestedMode: 'manual',
    origin: 'project',
    resolvedPresetId: 'caps-stroke',
    resolvedPresetHash: subtitlePresetReference('caps-stroke').presetHash,
    transcriptHash: hashB,
    durationFrames: frames,
    affectedArtifacts: frames > 0 ? outputs : [],
  })
}

function sourceTranscriptImpact() {
  return createSourceTranscriptReplacementImpact({
    commandId: 'edit-command-registry-transcript',
    baseVersionId,
    resultVersionId,
    previousTranscriptId: 'media-transcript-registry-1',
    previousTranscriptHash: hashA,
    replacementTranscriptId: 'media-transcript-registry-2',
    replacementTranscriptHash: hashB,
    durationFrames,
    outputReferences: outputs,
  })
}

function projectPolicyImpact() {
  return createProjectPolicyOverridesImpact({
    commandId: 'edit-command-registry-project-policy',
    baseVersionId,
    resultVersionId,
    policySnapshotId: 'project-policy-snapshot-registry-1',
    policySnapshotHash: hashA,
    previousResolvedHash: hashA,
    resultResolvedHash: hashB,
    durationFrames,
    outputReferences: outputs,
  })
}

function compareActionImpact(action = 'accept') {
  return createCompareActionImpact({
    commandId: 'edit-command-registry-compare',
    baseVersionId,
    resultVersionId: baseVersionId,
    action,
  })
}

/** Real impact document plus its real parser, per registered Command type. */
const IMPACT_FIXTURES = {
  'compare-action': { build: () => compareActionImpact(), parse: parseCompareActionImpact },
  'manual-edit': { build: () => manualImpact(), parse: parseCommandImpact },
  'apply-review-patch': { build: () => reviewPatchImpact('apply-review-patch'), parse: parseCommandImpact },
  'apply-review-patch-batch': { build: () => reviewPatchImpact('apply-review-patch-batch'), parse: parseCommandImpact },
  'remove-spoken-content': { build: editorialCutImpact, parse: parseEditorialCutImpact },
  'run-director': { build: directorRunImpact, parse: parseDirectorRunImpact },
  'set-project-lut-selection': { build: () => lutSelectionImpact(), parse: parseProjectLutSelectionImpact },
  'set-project-subtitle-mode': { build: () => subtitleConfigurationImpact(), parse: parseProjectSubtitleConfigurationImpact },
  'replace-source-transcript': { build: sourceTranscriptImpact, parse: parseSourceTranscriptReplacementImpact },
  'set-project-policy-overrides': { build: projectPolicyImpact, parse: parseProjectPolicyOverridesImpact },
}

function command(type, overrides = {}) {
  return createEditCommand({
    id: 'edit-command-registry-1',
    workspaceId,
    projectId,
    baseVersionId,
    baseHash: hashA,
    author: { type: 'api-client', id: 'api-client-1' },
    type,
    scope: { project: true },
    payload: { schemaVersion: 2 },
    idempotencyKey: 'request-registry-1',
    createdAt,
    ...overrides,
  })
}

test('T-F0-027 the registry is frozen, exhaustive and internally consistent', () => {
  assert.ok(Object.isFrozen(EDIT_COMMAND_POLICIES))
  assert.equal(EDIT_COMMAND_TYPES.length, 10)
  assert.deepEqual([...EDIT_COMMAND_TYPES], Object.keys(EDIT_COMMAND_POLICIES).toSorted())

  for (const type of EDIT_COMMAND_TYPES) {
    const policy = editCommandPolicy(type)
    assert.ok(Object.isFrozen(policy), `${type} policy must be frozen`)
    assert.ok(EDIT_COMMAND_RENDER_POLICIES.includes(policy.renderPolicy), `${type} render policy`)
    assert.equal(
      policy.requiresImpact,
      policy.impactSchema !== null,
      `${type} must require an impact exactly when it declares an impact schema`,
    )
    if (policy.impactSchema !== null) {
      assert.ok(EDIT_COMMAND_IMPACT_SCHEMAS.includes(policy.impactSchema), `${type} impact schema`)
    }
    if (policy.renderPolicy === 'deferred') {
      assert.notEqual(policy.deferralReason, null, `${type} must say what unblocks its render`)
    }
    if (policy.renderPolicy === 'no-render') {
      // A no-render type still owes an impact document — an explicit zero, not
      // the absence of a policy. Nothing about it may be deferred.
      assert.equal(policy.requiresImpact, true)
      assert.notEqual(policy.impactSchema, null)
      assert.equal(policy.supportsRenderFreeImpact, true)
      assert.equal(policy.deferralReason, null)
    }
    assert.match(policy.evidence, /\.ts:\d+/, `${type} must cite the code proving its policy`)
  }

  // Mutating the registry cannot widen the closed set of Command types.
  assert.throws(() => {
    EDIT_COMMAND_POLICIES['future-command'] = { renderPolicy: 'no-render' }
  }, TypeError)
  assert.equal(isEditCommandType('future-command'), false)
})

test('T-F0-027 the latest PostgreSQL Command constraint matches the canonical registry', async () => {
  const migrationsRoot = fileURLToPath(new URL('../../prisma/v2/migrations/', import.meta.url))
  const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .toReversed()
  let constraintSql
  let constraintMigration
  for (const migration of migrations) {
    const sql = await readFile(`${migrationsRoot}/${migration}/migration.sql`, 'utf8')
    if (sql.includes('ADD CONSTRAINT "edit_commands_type_check"')) {
      constraintSql = sql
      constraintMigration = migration
      break
    }
  }
  assert.ok(constraintSql, 'edit_commands_type_check must be declared by a migration')
  const match = constraintSql.match(/ADD CONSTRAINT "edit_commands_type_check"[\s\S]*?CHECK \("type" IN \(([\s\S]*?)\)\)/)
  assert.ok(match, `${constraintMigration} must declare a closed IN constraint`)
  const persistedTypes = [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]).toSorted()
  assert.deepEqual(persistedTypes, [...EDIT_COMMAND_TYPES])
})

test('T-F0-027 every registered type is produced by an application service and vice versa', async () => {
  const applicationRoot = fileURLToPath(new URL('../../src/v2/application/', import.meta.url))
  const entries = await readdir(applicationRoot, { withFileTypes: true, recursive: true })
  const discovered = new Set()
  let callSites = 0
  const actorTypes = new Set(['user', 'director', 'system', 'api-client'])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const source = await readFile(`${entry.parentPath}/${entry.name}`, 'utf8')
    for (const match of source.matchAll(/createEditCommand\s*(?:<[^>]*>)?\s*\(\{/g)) {
      callSites += 1
      const window = source.slice(match.index, match.index + 2000)
      const literals = [...window.matchAll(/\btype:\s*'([^']+)'/g)]
        .map((item) => item[1])
        .filter((value) => !actorTypes.has(value))
      assert.ok(literals.length > 0, `createEditCommand call site without a literal type in ${entry.name}`)
      const type = literals[0]
      assert.ok(
        isEditCommandType(type),
        `${entry.name} creates unregistered Command type "${type}" — declare its invalidation policy first`,
      )
      discovered.add(type)
    }
  }
  assert.equal(callSites, 10, 'expected one createEditCommand call site per Command type')
  assert.deepEqual([...discovered].toSorted(), [...EDIT_COMMAND_TYPES])
})

test('T-F0-027 each impact-bearing type produces a document its declared parser accepts', () => {
  for (const type of EDIT_COMMAND_TYPES) {
    const policy = editCommandPolicy(type)
    if (!policy.requiresImpact) {
      assert.equal(IMPACT_FIXTURES[type], undefined, `${type} declares no impact but has a fixture`)
      continue
    }
    const fixture = IMPACT_FIXTURES[type]
    assert.ok(fixture, `${type} requires an impact but the gate has no fixture for it`)
    const impact = fixture.build()
    assert.equal(impact.schemaVersion, policy.impactSchema, `${type} impact schema mismatch`)
    assert.equal(impact.commandType, type, `${type} impact commandType mismatch`)
    const parsed = fixture.parse(JSON.parse(JSON.stringify(impact)))
    assert.equal(parsed.impactHash, impact.impactHash)
  }
})

test('T-F0-027 partial-range types narrow renders to the edited region', () => {
  assert.deepEqual(
    [...editCommandTypesByRenderPolicy('partial-range')],
    ['apply-review-patch', 'apply-review-patch-batch', 'manual-edit'],
  )
  for (const type of editCommandTypesByRenderPolicy('partial-range')) {
    const impact = IMPACT_FIXTURES[type].build()
    assert.equal(impact.minimalRenders.length > 0, true, `${type} must request a render`)
    const ranges = impact.minimalRenders.flatMap((render) => render.ranges)
    assert.ok(
      ranges.some((range) => range.startFrame > 0 || range.endFrame < durationFrames),
      `${type} must be able to invalidate less than the whole timeline`,
    )
  }
})

test('T-F0-027 full-timeline types always invalidate from frame zero', () => {
  assert.deepEqual(
    [...editCommandTypesByRenderPolicy('full-timeline')],
    ['remove-spoken-content', 'run-director', 'set-project-lut-selection', 'set-project-subtitle-mode'],
  )
  for (const type of editCommandTypesByRenderPolicy('full-timeline')) {
    const impact = IMPACT_FIXTURES[type].build()
    assert.deepEqual(impact.affectedRanges, [{ startFrame: 0, endFrame: durationFrames }], type)
    for (const render of impact.minimalRenders) {
      for (const range of render.ranges) {
        assert.equal(range.startFrame, 0, `${type} minimal render must start at frame zero`)
      }
    }
  }
})

test('T-F0-027 deferred types enqueue no render before their unblocking event', () => {
  assert.deepEqual([...editCommandTypesByRenderPolicy('deferred')], ['replace-source-transcript', 'set-project-policy-overrides'])
  const policy = editCommandPolicy('replace-source-transcript')
  assert.equal(policy.deferralReason, 'director-run')

  const impact = sourceTranscriptImpact()
  assert.equal(impact.renderBlockedUntilDirectorRun, true)
  assert.equal(Object.hasOwn(impact, 'minimalRenders'), false, 'a deferred impact cannot request a render')
  assert.equal(Object.hasOwn(impact, 'renderSemanticsChanged'), false)
  assert.deepEqual([...impact.requiredRecomputations], ['perception', 'treatment', 'story', 'edit-plan', 'proxy', 'final'])
  const parsed = parseSourceTranscriptReplacementImpact(JSON.parse(JSON.stringify(impact)))
  assert.equal(Object.hasOwn(parsed, 'minimalRenders'), false)

  const policyImpact = projectPolicyImpact()
  assert.equal(editCommandPolicy('set-project-policy-overrides').deferralReason, 'director-run')
  assert.equal(policyImpact.renderBlockedUntilDirectorRun, true)
  assert.equal(Object.hasOwn(policyImpact, 'minimalRenders'), false)
  assert.deepEqual([...policyImpact.requiredRecomputations], ['treatment', 'story', 'edit-plan', 'proxy', 'final'])
  assert.equal(parseProjectPolicyOverridesImpact(JSON.parse(JSON.stringify(policyImpact))).impactHash, policyImpact.impactHash)

  // The LUT selection defers within full-timeline until a timeline exists.
  assert.equal(editCommandPolicy('set-project-lut-selection').deferralReason, 'timeline')
  const beforeTimeline = lutSelectionImpact(0)
  assert.equal(beforeTimeline.renderDeferredUntilTimeline, true)
  assert.deepEqual([...beforeTimeline.minimalRenders], [])
  assert.deepEqual([...beforeTimeline.affectedRanges], [])
  assert.deepEqual([...beforeTimeline.affectedArtifacts], [])
  assert.equal(lutSelectionImpact().renderDeferredUntilTimeline, false)

  // The subtitle mode defers the same way, and never widens past its own variant.
  assert.equal(editCommandPolicy('set-project-subtitle-mode').deferralReason, 'timeline')
  const subtitleBeforeTimeline = subtitleConfigurationImpact(0)
  assert.equal(subtitleBeforeTimeline.renderDeferredUntilTimeline, true)
  assert.deepEqual([...subtitleBeforeTimeline.minimalRenders], [])
  assert.deepEqual([...subtitleBeforeTimeline.affectedRanges], [])
  assert.deepEqual([...subtitleBeforeTimeline.affectedArtifacts], [])
  const subtitleImpact = subtitleConfigurationImpact()
  assert.equal(subtitleImpact.renderDeferredUntilTimeline, false)
  assert.deepEqual([...subtitleImpact.affectedVariantIds], ['9:16'])
  assert.deepEqual([...subtitleImpact.minimalRenders], [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: durationFrames }] }])
})

test('T-F0-027 no-render types carry an explicit zero impact and preserve their version', () => {
  assert.deepEqual([...editCommandTypesByRenderPolicy('no-render')], ['compare-action'])
  const policy = editCommandPolicy('compare-action')
  assert.equal(policy.impactSchema, 'compare-action-impact/v1')
  assert.equal(policy.requiresImpact, true)
  assert.notEqual(editCommandRenderPolicy('compare-action'), 'partial-range')

  for (const action of ['accept', 'reopen']) {
    const impact = compareActionImpact(action)
    assert.equal(impact.action, action)
    assert.equal(impact.renderSemanticsChanged, false)
    assert.equal(impact.resultVersionId, impact.baseVersionId, 'the compared versions are preserved')
    assert.deepEqual([...impact.changeKinds], ['review-state'])
    for (const field of ['dependencyTypes', 'affectedRanges', 'affectedVariantIds', 'affectedArtifacts', 'minimalRenders']) {
      assert.deepEqual([...impact[field]], [], `${field} must stay empty for a no-render Command`)
    }
    assert.match(impact.impactHash, /^[a-f0-9]{64}$/)
  }
  // Distinct decisions are distinct documents: the hash is content-addressed.
  assert.notEqual(compareActionImpact('accept').impactHash, compareActionImpact('reopen').impactHash)

  // No other impact parser in the domain accepts a compare-action document, and
  // the compare-action parser accepts no other type.
  const borrowed = { ...JSON.parse(JSON.stringify(manualImpact())), commandType: 'compare-action' }
  assert.throws(() => parseCommandImpact(borrowed), /Stored Command impact is invalid/)
  for (const [type, { parse }] of Object.entries(IMPACT_FIXTURES)) {
    if (type === 'compare-action') continue
    assert.throws(() => parse(JSON.parse(JSON.stringify(compareActionImpact()))))
  }
  assert.throws(() => parseCompareActionImpact(JSON.parse(JSON.stringify(manualImpact()))))

  const persisted = command('compare-action', {
    payload: {
      schemaVersion: 2, action: 'accept', beforeVersionId: baseVersionId,
      afterVersionId: resultVersionId, impact: compareActionImpact(),
    },
  })
  assert.equal(persisted.payload.impact.impactHash, compareActionImpact().impactHash)
})

test('T-F0-027 createEditCommand refuses a type without a registered policy', () => {
  for (const type of ['compare-actions', 'apply-color-grade', 'Manual-Edit', 'toString', 'constructor']) {
    assert.equal(isEditCommandType(type), false, `${type} must not be registered`)
    assert.throws(() => command(type), (error) => {
      assert.equal(error.name, 'DomainError')
      assert.equal(error.code, 'INVALID_COMMAND')
      assert.match(error.message, /not registered in the command invalidation policy registry/)
      assert.equal(error.details.type, type)
      return true
    }, `createEditCommand must fail closed for ${type}`)
  }
  assert.throws(() => requireEditCommandType(undefined), /not registered/)
  assert.equal(editCommandRenderPolicy('apply-color-grade'), null)
})

test('T-F0-027 an impact belonging to another type is rejected by the declared parser', () => {
  const manual = JSON.parse(JSON.stringify(manualImpact()))
  const cut = JSON.parse(JSON.stringify(editorialCutImpact()))
  const director = JSON.parse(JSON.stringify(directorRunImpact()))
  const transcript = JSON.parse(JSON.stringify(sourceTranscriptImpact()))
  const lut = JSON.parse(JSON.stringify(lutSelectionImpact()))

  assert.throws(() => parseCommandImpact(cut))
  assert.throws(() => parseCommandImpact(director))
  assert.throws(() => parseCommandImpact(transcript))
  assert.throws(() => parseCommandImpact(lut))
  assert.throws(() => parseEditorialCutImpact(manual))
  assert.throws(() => parseDirectorRunImpact(cut))
  assert.throws(() => parseProjectLutSelectionImpact(cut))
  assert.throws(() => parseSourceTranscriptReplacementImpact(cut))

  const subtitle = JSON.parse(JSON.stringify(subtitleConfigurationImpact()))
  assert.throws(() => parseCommandImpact(subtitle))
  assert.throws(() => parseProjectLutSelectionImpact(subtitle))
  assert.throws(() => parseProjectSubtitleConfigurationImpact(lut))
  assert.throws(() => parseProjectSubtitleConfigurationImpact({ ...subtitle, commandType: 'set-project-lut-selection' }))
  assert.throws(() => parseProjectSubtitleConfigurationImpact({ ...subtitle, transcriptHash: hashA }), 'the transcript binding is part of the identity')
  assert.throws(() => parseProjectSubtitleConfigurationImpact({ ...subtitle, resolvedPresetHash: hashA }), 'the versioned preset reference is part of the identity')
  assert.throws(() => parseProjectSubtitleConfigurationImpact({ ...subtitle, origin: 'disabled' }))
  assert.throws(() => parseProjectSubtitleConfigurationImpact({ ...subtitle, minimalRenders: [] }))
  assert.equal(parseProjectSubtitleConfigurationImpact(subtitle).impactHash, subtitleConfigurationImpact().impactHash)

  // Tampering with the declared identity of a valid document is rejected too.
  assert.throws(() => parseCommandImpact({ ...manual, commandType: 'run-director' }))
  assert.throws(() => parseCommandImpact({ ...manual, schemaVersion: 'director-run-impact/v1' }))
  assert.throws(() => parseEditorialCutImpact({ ...cut, commandType: 'manual-edit' }))
  assert.throws(() => parseDirectorRunImpact({ ...director, schemaVersion: 'command-impact/v1' }))
  assert.throws(() => parseSourceTranscriptReplacementImpact({ ...transcript, renderBlockedUntilDirectorRun: false }))
  assert.throws(() => parseProjectLutSelectionImpact({ ...lut, minimalRenders: [] }))

  const compare = JSON.parse(JSON.stringify(compareActionImpact()))
  assert.throws(() => parseCompareActionImpact({ ...compare, commandType: 'manual-edit' }))
  assert.throws(() => parseCompareActionImpact({ ...compare, renderSemanticsChanged: true }))
  assert.throws(() => parseCompareActionImpact({ ...compare, action: 'reopen' }))
  assert.throws(() => parseCompareActionImpact({ ...compare, resultVersionId }))
  assert.throws(() => parseCompareActionImpact({ ...compare, affectedArtifacts: [outputs[0]] }))
  assert.throws(() => parseCompareActionImpact({ ...compare, impactHash: hashB }))
})

test('T-F0-027 proxy range reuse derives its allowlist from the registry', async () => {
  const repository = fileURLToPath(
    new URL('../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts', import.meta.url),
  )
  const source = await readFile(repository, 'utf8')
  assert.match(source, /editCommandRenderPolicy\(command\.type\) !== 'partial-range'/)
  assert.doesNotMatch(
    source,
    /\['manual-edit', 'apply-review-patch', 'apply-review-patch-batch'\]/,
    'the hardcoded partial-range allowlist must not reappear next to the registry',
  )
})
