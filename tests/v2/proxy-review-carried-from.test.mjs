import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { presentProxyReview } from '../../src/v2/public-api/proxy-review-presenter.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { describeCarriedReview } from '../../src/v2/ui/proxy-review-carry-view.ts'
import { issueProvenance } from '../../src/v2/ui/issue-override-view.ts'

/**
 * W70 readiness (R1). A review whose render was carried from an earlier Version must say so in the public contract and in the panel: the
 * approval it shows is inherited automatically, never a human acknowledgement made on this Version.
 */
const ajv = () => addFormats(new Ajv2020({ strict: false, allErrors: true }))
const validatorOf = (ref) => ajv().compile(getPublicSchema(ref).schema)
const REVIEW_V4 = 'apollo://schemas/project-proxy-review-response/v4'
const REVIEW_V3 = 'apollo://schemas/project-proxy-review-response/v3'
const ACK_V4 = 'apollo://schemas/project-proxy-review-warning-acknowledgement-result/v4'

const person = Object.freeze({ type: 'api-client', id: 'client-who-acknowledged', at: '2026-10-20T10:00:00.000Z' })
const carriedFrom = Object.freeze({ versionId: 'project-version-earlier', reviewId: 'proxy-review-earlier', reviewHash: 'c'.repeat(64), decisionId: 'decision-carry-1', renderContentHash: 'd'.repeat(64), acknowledgedBy: person })
const automaticCarry = Object.freeze({ type: 'automatic-carry', id: 'decision-carry-1', at: '2026-10-20T11:00:00.000Z' })
const examplesOf = (ref) => publicSchemaExamples(getPublicSchema(ref))
const persisted = () => {
  const [{ data }] = examplesOf(REVIEW_V3)
  return { ...data.review, workspaceId: 'workspace-example-1' }
}

test('W70 R1 the proxy-review reads and the acknowledgement answer with schema v4, which adds carriedFrom and lets acknowledgedBy name the automatic carry; v3 keeps its bytes', () => {
  const capability = (id) => FOUNDATION_CAPABILITIES.find((item) => item.id === id)
  assert.equal(capability('apollo.projects.proxy-reviews.read').version, '2.3.0')
  assert.equal(capability('apollo.projects.proxy-reviews.read').outputSchemaRef, REVIEW_V4)
  assert.equal(capability('apollo.projects.proxy-reviews.acknowledge-warnings').version, '2.2.0')
  assert.equal(capability('apollo.projects.proxy-reviews.acknowledge-warnings').outputSchemaRef, ACK_V4)
  const v3 = getPublicSchema(REVIEW_V3).schema.properties.data.properties.review
  const v4 = getPublicSchema(REVIEW_V4).schema.properties.data.properties.review
  assert.equal('carriedFrom' in v3.properties, false, 'the superseded v3 does not list it')
  assert.deepEqual(Object.keys(v4.properties).filter((key) => !(key in v3.properties)), ['carriedFrom'])
  assert.deepEqual(v4.required, v3.required, 'and it is optional: a review nobody carried is unchanged')
  assert.deepEqual(v4.properties.carriedFrom.required, ['versionId', 'reviewId', 'reviewHash', 'decisionId', 'renderContentHash', 'acknowledgedBy'])
  assert.deepEqual(Object.keys(v4.properties).filter((key) => JSON.stringify(v4.properties[key]) !== JSON.stringify(v3.properties[key])).sort(), ['acknowledgedBy', 'carriedFrom'],
    'and the only other field that moves is acknowledgedBy, which may name the automatic carry')
  for (const ref of [REVIEW_V4, ACK_V4]) {
    const validate = validatorOf(ref)
    for (const example of examplesOf(ref)) assert.equal(validate(example), true, `${ref}: ${JSON.stringify(validate.errors)}`)
  }
  assert.ok(examplesOf(REVIEW_V4).some((example) => example.data.review.carriedFrom), 'the published examples show a carried review')
  // v3 refuses the field (it never published it); v4 accepts both shapes of decisionId
  const carried = { data: { review: { ...persistedExample(), acknowledgedBy: automaticCarry, carriedFrom } }, meta: { apiVersion: 'v1' } }
  assert.equal(validatorOf(REVIEW_V3)(carried), false)
  assert.equal(validatorOf(REVIEW_V4)(carried), true)
  // v3 never names the automatic carry; v4 names a person or the carry, nothing else
  assert.equal(validatorOf(REVIEW_V3)({ data: { review: { ...persistedExample(), acknowledgedBy: automaticCarry } }, meta: { apiVersion: 'v1' } }), false)
  assert.equal(validatorOf(REVIEW_V4)({ data: { review: { ...persistedExample(), acknowledgedBy: { ...automaticCarry, type: 'director' } } }, meta: { apiVersion: 'v1' } }), false)
  assert.equal(validatorOf(REVIEW_V4)({ data: { review: { ...persistedExample(), carriedFrom: { ...carriedFrom, acknowledgedBy: automaticCarry } } }, meta: { apiVersion: 'v1' } }), false,
    'the acknowledgement kept in carriedFrom is the person who acknowledged the source review')
  const { acknowledgedBy: _missing, ...withoutPerson } = carriedFrom
  assert.equal(validatorOf(REVIEW_V4)({ data: { review: { ...persistedExample(), carriedFrom: withoutPerson } }, meta: { apiVersion: 'v1' } }), false, 'it is always stated, null when none')
  const carriedExample = examplesOf(REVIEW_V4).find((example) => example.data.review.carriedFrom).data.review
  assert.equal(carriedExample.acknowledgedBy.type, 'automatic-carry', 'the published example of a carried approval names the carry')
  assert.equal(carriedExample.acknowledgedBy.id, carriedExample.carriedFrom.decisionId)
  assert.equal(carriedExample.carriedFrom.acknowledgedBy.type, 'api-client')
  const noApproval = { data: { review: { ...persistedExample(), carriedFrom: { ...carriedFrom, decisionId: null, acknowledgedBy: null } } }, meta: { apiVersion: 'v1' } }
  assert.equal(validatorOf(REVIEW_V4)(noApproval), true, 'a carry that re-bound no approval says decisionId: null')
  assert.equal(validatorOf(REVIEW_V4)({ data: { review: { ...persistedExample(), carriedFrom: { ...carriedFrom, renderContentHash: 'nope' } } }, meta: { apiVersion: 'v1' } }), false)
  assert.equal(validatorOf(REVIEW_V4)({ data: { review: { ...persistedExample(), carriedFrom: { ...carriedFrom, extra: 1 } } }, meta: { apiVersion: 'v1' } }), false)
})
function persistedExample() {
  const [{ data }] = examplesOf(REVIEW_V3)
  return data.review
}

test('W70 R1 the presenter publishes carriedFrom exactly when the review was carried, and a review nobody carried is byte-identical to before', () => {
  const review = persisted()
  const plain = presentProxyReview(review)
  assert.equal(Object.hasOwn(plain, 'carriedFrom'), false)
  const carried = presentProxyReview({ ...review, acknowledgedBy: automaticCarry, carriedFrom })
  assert.deepEqual(carried.carriedFrom, carriedFrom)
  assert.deepEqual(carried.acknowledgedBy, automaticCarry, 'the review names the automatic carry as its acknowledgement')
  assert.notEqual(carried.acknowledgedBy.id, person.id, 'never the person who acknowledged the source review')
  assert.deepEqual({ ...carried, carriedFrom: undefined, acknowledgedBy: undefined }, { ...plain, carriedFrom: undefined, acknowledgedBy: undefined }, 'nothing else about the review moves')
  const validate = validatorOf(REVIEW_V4)
  assert.equal(validate({ data: { review: carried }, meta: { apiVersion: 'v1' } }), true, JSON.stringify(validate.errors))
  assert.equal(validate({ data: { review: plain }, meta: { apiVersion: 'v1' } }), true)
})

test('W70 R1 the panel labels an inherited approval as an automatic carry, distinct from a human acknowledgement', () => {
  assert.equal(describeCarriedReview({ warningsAcknowledged: false }), null)
  const approval = describeCarriedReview({ carriedFrom, warningsAcknowledged: true })
  assert.equal(approval.kind, 'approval-carried')
  assert.equal(approval.headline, 'Aprovação herdada automaticamente da versão project-version-earlier — conteúdo idêntico')
  assert.match(approval.detail, /Nenhuma pessoa reconheceu as ressalvas desta versão/)
  assert.match(approval.detail, /decision-carry-1/)
  assert.match(approval.detail, /reconhecida lá por client-who-acknowledged em 2026-10-20T10:00:00.000Z/, 'the person is named where they acknowledged: on the source Version')
  assert.match(approval.detail, new RegExp('c'.repeat(12)))
  assert.match(approval.detail, new RegExp('d'.repeat(12)))
  assert.equal(approval.acknowledgedOnThisVersion, false, 'the approval is not an acknowledgement made here')
  const renderOnly = describeCarriedReview({ carriedFrom: { ...carriedFrom, decisionId: null, acknowledgedBy: null }, warningsAcknowledged: false })
  assert.equal(renderOnly.kind, 'render-carried')
  assert.match(renderOnly.headline, /^Render herdado automaticamente da versão project-version-earlier — conteúdo idêntico$/)
  assert.match(renderOnly.detail, /a herança não aprovou nada/)
  assert.match(renderOnly.detail, /continuam para uma pessoa decidir/)
  const later = describeCarriedReview({ carriedFrom: { ...carriedFrom, decisionId: null, acknowledgedBy: null }, warningsAcknowledged: true })
  assert.equal(later.acknowledgedOnThisVersion, true, 'a person who acknowledged AFTER an approval-less carry did so on this Version')
  assert.match(later.detail, /reconhecidas por uma pessoa depois, nesta versão/)
})

test('W70 R1 the provenance of an issue names the Version, the review and the content address an inherited render came from', () => {
  const review = { ...persistedExample(), carriedFrom, id: 'r', projectVersionId: 'v', proxyArtifactId: 'a', proxyManifestId: 'm', inputHash: '1'.repeat(64), outputSpecId: 'o', reviewHash: '2'.repeat(64), revision: 1 }
  const chip = { variantId: 'variant', source: {}, elementIds: [], evidenceIds: [] }
  const rows = issueProvenance(chip, review, { artifactId: 'a', sha256: null })
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]))
  assert.equal(byLabel['Herdado da versão'], 'project-version-earlier')
  assert.equal(byLabel['Laudo de origem'], 'c'.repeat(64))
  assert.equal(byLabel['Endereço do conteúdo'], 'd'.repeat(64))
  assert.equal(byLabel['Decisão da herança'], 'decision-carry-1')
  assert.equal(byLabel['Reconhecido na versão de origem por'], 'client-who-acknowledged')
  const plain = issueProvenance(chip, { ...review, carriedFrom: undefined }, { artifactId: 'a', sha256: null })
  assert.equal(plain.some((row) => /Herdado|origem|Decisão da herança/.test(row.label)), false, 'a review nobody carried shows no inheritance rows')
})
