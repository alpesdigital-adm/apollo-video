import assert from 'node:assert/strict'
import test from 'node:test'
import { OUTPUT_CONSUMPTION_PURPOSES, PUBLISHED_CONSUMPTION_REASONS, outputConsumptionSealHashV3, outputConsumptionSealV3, outputConsumptionVerdictV3,
  outputEntryAspectRatio, outputVariantsOf, publishedConsumptionReason, requireOutputVariant } from '../../src/v2/domain/output-consumption.ts'
import { presentPublicDomainError } from '../../src/v2/public-api/error-presenter.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

// The verdict reads only a State's shape, so these are the minimal State documents it can see. Real bundles are proven by the PG suites.
const RATIOS = { 'variant-1': '9:16', 'variant-2': '16:9' }
const specOf = (variantId) => ({ output: { aspectRatio: RATIOS[variantId] ?? '1:1' } })
const materialized = (variantId, schemaVersion = 'output-materialization/v1') => ({
  variantId, outputSpecRevisionId: `revision-${variantId}`, specHash: 'a'.repeat(64), spec: specOf(variantId),
  consumption: { status: 'materialized', materialization: { materializationHash: 'b'.repeat(64), document: { id: `materialization-${variantId}`, schemaVersion } } },
})
const blockedEntry = (variantId, reasons) => ({ variantId, outputSpecRevisionId: `revision-${variantId}`, specHash: 'a'.repeat(64), spec: specOf(variantId), consumption: { status: 'blocked', reasons } })
const version = { id: 'version-1', baseHash: 'c'.repeat(64) }
const state3 = (entries, sourceDependencies = null) => ({ stateHash: 'd'.repeat(64),
  document: { schemaVersion: 'project-output-state/v3', id: 'state-1', entries, sourceDependencies } })
const creation = (reasons) => ({ stateHash: 'f'.repeat(64),
  document: { schemaVersion: 'project-output-state/v2', id: 'state-0', consumption: { status: 'blocked', reasons } } })
const cutCopy = (variantId = 'variant-1') => state3([materialized(variantId, 'editorial-derived-materialization/v1')], { forkDerivationId: 'derivation-1' })

test('a Creation fork root and a State without outputs are blocked with the reasons their State records, for every purpose', () => {
  for (const purpose of OUTPUT_CONSUMPTION_PURPOSES) {
    assert.deepEqual(outputConsumptionVerdictV3(creation(['fork-target-materialization-required']), 'variant-1', purpose),
      { status: 'blocked', reasons: ['fork-target-materialization-required'] })
    assert.deepEqual(outputConsumptionVerdictV3(creation(['empty-project']), undefined, purpose), { status: 'blocked', reasons: ['empty-project'] })
    assert.deepEqual(outputConsumptionVerdictV3(state3([]), undefined, purpose), { status: 'blocked', reasons: ['empty-project'] })
  }
})

test('a blocked entry is blocked with its own reasons; a materialized entry of an ordinary project is allowed for every purpose', () => {
  const bundle = state3([blockedEntry('variant-1', ['normalization-required']), materialized('variant-2')])
  for (const purpose of OUTPUT_CONSUMPTION_PURPOSES) {
    assert.deepEqual(outputConsumptionVerdictV3(bundle, 'variant-1', purpose), { status: 'blocked', reasons: ['normalization-required'] })
    const allowed = outputConsumptionVerdictV3(bundle, 'variant-2', purpose)
    assert.equal(allowed.status, 'allowed')
    assert.equal(allowed.entry.variantId, 'variant-2')
  }
})

test('policy: a cut copy is consumable to render and critic, and its final export stays blocked until the target owns perception authority', () => {
  const bundle = cutCopy()
  assert.equal(outputConsumptionVerdictV3(bundle, 'variant-1', 'render').status, 'allowed')
  assert.equal(outputConsumptionVerdictV3(bundle, 'variant-1', 'critic').status, 'allowed')
  assert.deepEqual(outputConsumptionVerdictV3(bundle, 'variant-1', 'final'), { status: 'blocked', reasons: ['derived-source-perception-authority-required'] })
  // The target's own perception authority (its own Director run) lifts the block for the final, and only for it.
  assert.equal(outputConsumptionVerdictV3(bundle, 'variant-1', 'final', true).status, 'allowed')
  assert.equal(outputConsumptionVerdictV3(bundle, 'variant-1', 'final', false).status, 'blocked')
  // The block belongs to the fork lineage, not to the editorial materialization alone: a derived materialization without it is final-consumable.
  assert.equal(outputConsumptionVerdictV3(state3([materialized('variant-1', 'editorial-derived-materialization/v1')]), 'variant-1', 'final').status, 'allowed')
})

test('the variant is exact: an unknown variant is refused, and "the only output" is never guessed when there are several', () => {
  const bundle = state3([materialized('variant-1'), materialized('variant-2')])
  assert.throws(() => outputConsumptionVerdictV3(bundle, 'variant-9', 'render'),
    (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'output-variant-unknown')
  assert.deepEqual(outputConsumptionVerdictV3(bundle, undefined, 'render'), { status: 'blocked', reasons: ['output-variant-required'] })
  assert.equal(outputConsumptionVerdictV3(state3([materialized('variant-1')]), undefined, 'render').status, 'allowed')
})

test('an unknown purpose is refused, not treated as render', () => {
  assert.throws(() => outputConsumptionVerdictV3(state3([materialized('variant-1')]), 'variant-1', 'publish'),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
})

test('the seal names the exact Version, State, variant revision and materialization, and changes with any of them', () => {
  const bundle = state3([materialized('variant-1')])
  const entry = bundle.document.entries[0]
  const seal = outputConsumptionSealV3(version, bundle, entry, 'render')
  assert.deepEqual(seal, { schemaVersion: 'output-consumption-seal/v1', purpose: 'render', projectVersionId: 'version-1', projectVersionHash: 'c'.repeat(64),
    outputStateId: 'state-1', outputStateHash: 'd'.repeat(64), variantId: 'variant-1', outputSpecRevisionId: 'revision-variant-1', specHash: 'a'.repeat(64),
    materializationId: 'materialization-variant-1', materializationHash: 'b'.repeat(64) })
  const hash = outputConsumptionSealHashV3(seal)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(outputConsumptionSealHashV3(outputConsumptionSealV3(version, bundle, entry, 'render')), hash, 'deterministic')
  assert.notEqual(outputConsumptionSealHashV3(outputConsumptionSealV3(version, bundle, entry, 'critic')), hash, 'the purpose is sealed')
  const otherState = { ...bundle, stateHash: '1'.repeat(64) }
  assert.notEqual(outputConsumptionSealHashV3(outputConsumptionSealV3(version, otherState, entry, 'render')), hash, 'another State seals differently')
  assert.notEqual(outputConsumptionSealHashV3(outputConsumptionSealV3({ ...version, baseHash: '2'.repeat(64) }, bundle, entry, 'render')), hash, 'another Version base seals differently')
  const otherRevision = { ...entry, outputSpecRevisionId: 'revision-other' }
  assert.notEqual(outputConsumptionSealHashV3(outputConsumptionSealV3(version, bundle, otherRevision, 'render')), hash, 'another variant revision seals differently')
  assert.throws(() => outputConsumptionSealV3(version, bundle, blockedEntry('variant-1', ['normalization-required']), 'render'),
    (error) => error.code === 'PRECONDITION_REQUIRED', 'a blocked entry cannot be sealed')
})

test('each State reason publishes one stable code, unknown ones publish a generic code, and the presenter exposes exactly the published set', () => {
  assert.equal(publishedConsumptionReason(['fork-target-materialization-required']), 'copy-requires-editorial-cut')
  assert.equal(publishedConsumptionReason(['derived-source-perception-authority-required']), 'derived-source-perception-authority-required')
  assert.equal(publishedConsumptionReason(['normalization-required']), 'normalization-required')
  assert.equal(publishedConsumptionReason(['something-internal']), 'output-not-consumable')
  assert.equal(publishedConsumptionReason([]), 'output-not-consumable')
  for (const reason of PUBLISHED_CONSUMPTION_REASONS) {
    const presented = presentPublicDomainError(new DomainError('PRECONDITION_REQUIRED', 'internal text', { reason, purpose: 'final', outputStateId: 'state-1' }), 'request-1')
    assert.equal(presented.error.details?.reason, reason)
    assert.equal(JSON.stringify(presented).includes('state-1'), false, 'the State identity stays internal')
  }
  const hidden = presentPublicDomainError(new DomainError('PRECONDITION_REQUIRED', 'internal text', { reason: 'something-internal' }), 'request-1')
  assert.equal(hidden.error.details?.reason, undefined)
})

test('the format of an output is the aspect ratio its sealed spec carries: its own, or the effective one of the literal fork revision of a copy', () => {
  const own = { ...materialized('variant-1'), spec: { output: { aspectRatio: '9:16' } } }
  const fork = { ...materialized('variant-1'), spec: { schemaVersion: 'output-spec-revision/v3', effectiveSpec: { output: { aspectRatio: '1:1' } } } }
  assert.equal(outputEntryAspectRatio(own), '9:16')
  assert.equal(outputEntryAspectRatio(fork), '1:1')
  assert.equal(outputEntryAspectRatio({ ...materialized('variant-1'), spec: { output: {} } }), null)
  assert.equal(outputEntryAspectRatio({ ...materialized('variant-1'), spec: { output: { aspectRatio: '' } } }), null)
})

// Two outputs of one project: each resolves by its own stable variant and nothing is guessed between them.
const withRatio = (variantId, aspectRatio) => ({ ...materialized(variantId), spec: { output: { aspectRatio } } })
test('several outputs resolve apart by their stable variant, and two outputs of one aspect ratio are refused as ambiguous', () => {
  const two = state3([withRatio('variant-vertical', '9:16'), withRatio('variant-wide', '16:9')])
  for (const purpose of OUTPUT_CONSUMPTION_PURPOSES) {
    assert.equal(outputConsumptionVerdictV3(two, 'variant-vertical', purpose).entry.variantId, 'variant-vertical')
    assert.equal(outputConsumptionVerdictV3(two, 'variant-wide', purpose).entry.variantId, 'variant-wide')
    assert.deepEqual(outputConsumptionVerdictV3(two, undefined, purpose), { status: 'blocked', reasons: ['output-variant-required'] })
  }
  assert.deepEqual(outputVariantsOf(two), [{ variantId: 'variant-vertical', aspectRatio: '9:16' }, { variantId: 'variant-wide', aspectRatio: '16:9' }])
  assert.equal(requireOutputVariant(two, 'variant-wide').aspectRatio, '16:9')
  assert.throws(() => requireOutputVariant(two, 'variant-none'), (error) => error.details.reason === 'output-variant-unknown')
  const clash = state3([withRatio('variant-a', '9:16'), withRatio('variant-b', '9:16')])
  assert.deepEqual(outputConsumptionVerdictV3(clash, 'variant-a', 'render'), { status: 'blocked', reasons: ['output-variant-ambiguous'] })
  assert.throws(() => requireOutputVariant(clash, 'variant-b'), (error) => error.details.reason === 'output-variant-ambiguous')
  assert.deepEqual(outputVariantsOf(creation(['fork-target-materialization-required'])), [])
  assert.throws(() => requireOutputVariant(state3([{ ...materialized('variant-1'), spec: { output: {} } }]), 'variant-1'), (error) => error.details.reason === 'output-not-consumable')
})
