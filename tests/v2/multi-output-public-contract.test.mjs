import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { parseOptionalVariantId, parseProxyRenderBody, parseRequiredVariantId } from '../../src/v2/public-api/project-output-variant-request-contract.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'

/**
 * W66 slice S3: a project holds several outputs and every public request that is about one of them names it by its STABLE State
 * variant id (what `output-variants.create` returns), never by an aspect ratio. These tests pin the contract: which capabilities
 * moved (major where the meaning of `variantId` changed, minor where an optional field was added), the optional/required rules of
 * each request, and that the superseded schema versions stay published.
 */
const capabilities = new Map(FOUNDATION_CAPABILITIES.map((capability) => [capability.id, capability]))
const capability = (id) => {
  const found = capabilities.get(id)
  assert.ok(found, `${id} is published`)
  return found
}
const ajv = () => addFormats(new Ajv2020({ strict: false, allErrors: true }))
const invalidArgument = (error) => error?.code === 'INVALID_ARGUMENT'

test('the capabilities whose variantId changed meaning are a major bump onto new request schemas', () => {
  for (const [id, version, input] of [
    ['apollo.projects.subtitle-configuration.set', '2.0.0', 'project-subtitle-configuration-set-request/v2'],
    ['apollo.projects.subtitle-segment-overrides.apply', '2.0.0', 'subtitle-segment-override-apply-request/v2'],
    ['apollo.projects.subtitle-sidecars.export', '2.0.0', 'export-subtitle-sidecar-request/v2'],
    ['apollo.projects.manual-edits.apply', '4.0.0', 'apply-project-manual-edit-request/v3'],
    ['apollo.projects.annotations.create', '3.0.0', 'create-review-annotation-request/v3'],
  ]) {
    assert.equal(capability(id).version, version, id)
    assert.equal(capability(id).inputSchemaRef, `apollo://schemas/${input}`, id)
    assert.match(capability(id).description, /stable|variantId/i, `${id} says what variantId is`)
  }
  for (const id of ['apollo.projects.subtitle-configuration.read', 'apollo.projects.subtitle-segment-overrides.read', 'apollo.projects.subtitle-sidecars.list']) {
    assert.equal(capability(id).version, '2.0.0', id)
    const parameter = capability(id).queryParameters.find((item) => item.name === 'variantId')
    assert.match(parameter.description, /stable/i, `${id} variantId query is the stable id`)
  }
  // Superseded schema versions stay published byte for byte (the baseline refuses their removal).
  for (const ref of ['project-subtitle-configuration-set-request/v1', 'subtitle-segment-override-apply-request/v1', 'export-subtitle-sidecar-request/v1',
    'apply-project-manual-edit-request/v2', 'create-review-annotation-request/v2', 'review-annotation-created/v2', 'project-review/v3', 'project-final-export-request/v1',
    'project-workspace/v13']) assert.equal(getPublicSchema(`apollo://schemas/${ref}`).ref, `apollo://schemas/${ref}`)
})

test('every new request schema describes variantId as the stable id and accepts the examples it publishes', () => {
  for (const ref of ['project-subtitle-configuration-set-request/v2', 'subtitle-segment-override-apply-request/v2', 'export-subtitle-sidecar-request/v2',
    'apply-project-manual-edit-request/v3', 'create-review-annotation-request/v3', 'project-proxy-render-request/v1', 'project-final-export-request/v2']) {
    const definition = getPublicSchema(`apollo://schemas/${ref}`)
    assert.match(definition.schema.properties.variantId.description, /Stable output variant id/, ref)
    const validate = ajv().compile(definition.schema)
    const examples = publicSchemaExamples(definition)
    assert.ok(examples.length > 0, `${ref} publishes an example`)
    for (const example of examples) assert.equal(validate(example), true, `${ref}: ${JSON.stringify(validate.errors)}`)
  }
  // The examples spell the variant the new way: no example names an aspect ratio as a variantId.
  for (const ref of ['project-subtitle-configuration-set-request/v2', 'subtitle-segment-override-apply-request/v2', 'export-subtitle-sidecar-request/v2']) {
    for (const example of publicSchemaExamples(getPublicSchema(`apollo://schemas/${ref}`))) assert.doesNotMatch(example.variantId, /^\d+:\d+$/, ref)
  }
})

test('proxy renders accept an optional body that only names the output, and stay callable without one', () => {
  const enqueue = capability('apollo.projects.proxy-renders.enqueue')
  assert.equal(enqueue.version, '1.1.0')
  assert.equal(enqueue.inputSchemaRef, 'apollo://schemas/project-proxy-render-request/v1')
  assert.equal(enqueue.requestBodyRequired, false)
  const validate = ajv().compile(getPublicSchema(enqueue.inputSchemaRef).schema)
  assert.equal(validate({}), true)
  assert.equal(validate({ variantId: 'output-variant-1' }), true)
  assert.equal(validate({ variantId: 'output-variant-1', format: '9:16' }), false, 'the ratio never selects an output')
  assert.equal(validate({ variantId: '' }), false)

  assert.deepEqual(parseProxyRenderBody(''), {})
  assert.deepEqual(parseProxyRenderBody('  \n'), {})
  assert.deepEqual(parseProxyRenderBody('{}'), {})
  assert.deepEqual(parseProxyRenderBody('{"variantId":" output-variant-1 "}'), { variantId: 'output-variant-1' })
  for (const bad of ['{', '[]', '"text"', '{"variantId":""}', '{"variantId":3}', '{"variantId":null}', '{"format":"9:16"}', '{"variantId":"output-variant-1","note":"x"}']) {
    assert.throws(() => parseProxyRenderBody(bad), invalidArgument, bad)
  }
})

test('final exports take an optional variantId; the preset format stays required and never selects the output', () => {
  const enqueue = capability('apollo.projects.final-exports.enqueue')
  assert.equal(enqueue.version, '1.1.0')
  assert.equal(enqueue.inputSchemaRef, 'apollo://schemas/project-final-export-request/v2')
  assert.equal(enqueue.requestBodyRequired, true)
  const schema = getPublicSchema(enqueue.inputSchemaRef).schema
  assert.deepEqual(schema.required, ['projectVersionId', 'projectVersionHash', 'format', 'approval'])
  assert.match(schema.properties.format.description, /never selects the output/)
  const validate = ajv().compile(schema)
  const body = { projectVersionId: 'project-version-1', projectVersionHash: 'a'.repeat(64), format: '9:16', approval: { approved: true } }
  assert.equal(validate(body), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...body, variantId: 'output-variant-1' }), true)
  assert.equal(validate({ ...body, variantId: '' }), false)
  assert.equal(ajv().compile(getPublicSchema('apollo://schemas/project-final-export-request/v1').schema)({ ...body, variantId: 'output-variant-1' }), false, 'v1 stays closed')

  assert.equal(parseOptionalVariantId(undefined), undefined)
  assert.equal(parseOptionalVariantId(' output-variant-1 '), 'output-variant-1')
  for (const bad of ['', '   ', 3, null, {}]) assert.throws(() => parseOptionalVariantId(bad), invalidArgument)
  assert.equal(parseRequiredVariantId(' output-variant-1 '), 'output-variant-1')
  for (const bad of [undefined, '', null, 7]) assert.throws(() => parseRequiredVariantId(bad), invalidArgument)
})

test('the review and proxy-review reads take an optional stable variantId; the workspace publishes the outputs', () => {
  for (const id of ['apollo.projects.annotations.list', 'apollo.projects.proxy-reviews.read']) {
    const parameter = capability(id).queryParameters.find((item) => item.name === 'variantId')
    assert.ok(parameter, `${id} names the output`)
    assert.equal(parameter.required, false, `${id} variantId is optional (a single-output version names none)`)
    assert.match(parameter.description, /stable/i)
  }
  assert.equal(capability('apollo.projects.proxy-reviews.read').version, '2.1.0')
  for (const id of ['apollo.projects.workspace.read', 'apollo.projects.workspace.current.read']) {
    assert.equal(capability(id).outputSchemaRef, 'apollo://schemas/project-workspace/v14', id)
  }
})

test('project-wide Commands say they apply to every output of the project', () => {
  for (const id of ['apollo.projects.lut-selection.set', 'apollo.projects.color-plan.set', 'apollo.projects.policy-overrides.set']) {
    assert.match(capability(id).description, /every output of the project/, id)
  }
  for (const id of ['apollo.projects.review-patches.apply', 'apollo.projects.review-patch-batches.apply', 'apollo.projects.media-library.attach',
    'apollo.projects.director-runs.enqueue', 'apollo.projects.asset-selections.create', 'apollo.projects.commands.apply']) {
    assert.match(capability(id).description, /every output of the project/, id)
  }
})
