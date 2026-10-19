import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { PUBLIC_SCHEMAS, getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaDocument } from '../../src/v2/public-api/schema-examples.ts'
import { createOpenApiDocument } from '../../src/v2/public-api/openapi.ts'

/**
 * W64 negative proof: an `observationSet` that a caller hands over never substitutes for the verified detector in an automatic plan.
 *
 * 1. the legacy `reframe-plan-request` v1 schema (the only one that carries an `observationSet`) stays registered and is reachable
 *    from NO capability, NO OpenAPI operation and no other schema;
 * 2. no capability input schema declares an `observationSet`, and the entrances that start a Director run or ask for a reframe REFUSE
 *    a body that carries one;
 * 3. the Director's code never reads one: no module of its path names an observation set, a manual perception timeline, the legacy
 *    reframe plan or the caller-driven responsive placement solver;
 * 4. the one place a caller can put observations into a Version's perception (the manual PUT /perception timeline) is a different
 *    record the server snapshot, and therefore the Director, never reads (proven against PostgreSQL in the Director evidence suite);
 *    and a Director handed an observation set decides exactly as without (run-project-director.test.mjs).
 */

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

function* keysOf(node, path = '') {
  if (Array.isArray(node)) { for (const [index, item] of node.entries()) yield* keysOf(item, `${path}[${index}]`); return }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    yield `${path}/${key}`
    yield* keysOf(value, `${path}/${key}`)
  }
}

const refsOfCapability = (capability) => [capability.inputSchemaRef, capability.outputSchemaRef].filter(Boolean)

test('W64 the legacy observation-set schema is registered and reachable from nothing', () => {
  const legacy = 'apollo://schemas/reframe-plan-request/v1'
  assert.ok(PUBLIC_SCHEMAS.some((schema) => schema.ref === legacy), 'it stays registered, as published')
  assert.ok(Object.hasOwn(getPublicSchema(legacy).schema.properties, 'observationSet'))
  assert.deepEqual(FOUNDATION_CAPABILITIES.filter((capability) => refsOfCapability(capability).includes(legacy)).map((capability) => capability.id), [])
  const reframe = FOUNDATION_CAPABILITIES.find((capability) => capability.id === 'apollo.projects.reframe-plans.create')
  assert.equal(reframe.inputSchemaRef, 'apollo://schemas/reframe-plan-request/v2')
  const v2 = getPublicSchema(reframe.inputSchemaRef).schema
  assert.deepEqual(Object.keys(v2.properties).sort(), ['baseVersionId', 'format'])
  assert.equal(v2.additionalProperties, false)
  // published as a component (the registry is published whole), described by no operation
  assert.equal(JSON.stringify(createOpenApiDocument().paths).includes('ReframePlanRequestV1'), false)
  for (const schema of PUBLIC_SCHEMAS) {
    if (schema.ref === legacy) continue
    assert.equal(JSON.stringify(schema.schema).includes('reframe-plan-request/v1'), false, schema.ref)
  }
})

test('W64 no capability accepts an observation set, and the Director and reframe entrances refuse a body that carries one', () => {
  for (const capability of FOUNDATION_CAPABILITIES) {
    if (!capability.inputSchemaRef) continue
    const declared = [...keysOf(getPublicSchema(capability.inputSchemaRef).schema)].filter((path) => path.endsWith('/observationSet'))
    assert.deepEqual(declared, [], `${capability.id} must not declare an observationSet`)
  }
  const poisoned = {
    'apollo.projects.reframe-plans.create': { baseVersionId: 'project-version-1', format: '9:16', observationSet: { id: 'caller-observations' } },
    'apollo.projects.director-runs.enqueue': { baseVersionId: 'project-version-1', baseHash: 'a'.repeat(64), objective: 'discovery', observationSet: { id: 'caller-observations' } },
  }
  for (const [id, body] of Object.entries(poisoned)) {
    const capability = FOUNDATION_CAPABILITIES.find((candidate) => candidate.id === id)
    const validate = ajv.compile(publicSchemaDocument(getPublicSchema(capability.inputSchemaRef)))
    assert.equal(validate(body), false, `${id} must refuse a body with an observationSet`)
    assert.ok(validate.errors.some((error) => error.keyword === 'additionalProperties' && error.params.additionalProperty === 'observationSet'), id)
    const { observationSet: _dropped, ...clean } = body
    assert.equal(validate(clean), true, `${id} accepts the same body without it: ${JSON.stringify(validate.errors)}`)
  }
  const commands = FOUNDATION_CAPABILITIES.find((capability) => capability.id === 'apollo.projects.commands.apply')
  const validateCommand = ajv.compile(publicSchemaDocument(getPublicSchema(commands.inputSchemaRef)))
  const director = { type: 'run-director', baseVersionId: 'project-version-1', baseHash: 'a'.repeat(64) }
  assert.equal(validateCommand({ ...director, observationSet: { id: 'caller-observations' } }), false)
})

const DIRECTOR_PATH = [
  'src/v2/application/run-project-director.ts',
  'src/v2/application/run-project-director-operation-worker.ts',
  'src/v2/application/enqueue-project-director-run.ts',
  'src/v2/application/director-face-window-requests.ts',
  'src/v2/application/ports/director-run-repository.ts',
  'src/v2/domain/director-run.ts',
  'src/v2/domain/director-decision.ts',
  'src/v2/domain/director-evidence-rubric.ts',
  'src/v2/domain/director-perception-evidence.ts',
  'src/v2/domain/decision-confidence.ts',
  'src/v2/domain/server-perception-snapshot.ts',
  'src/v2/infrastructure/prisma/director-run-repository.ts',
  'src/v2/infrastructure/prisma/server-perception-evidence-reader.ts',
  'src/v2/infrastructure/prisma/server-perception-snapshot-repository.ts',
]

test('W64 the Director path never reads a caller observations, a manual perception timeline, the legacy reframe plan or the responsive solver', async () => {
  const forbidden = [
    /observationSet/u,
    /reframe-plan(?:\.ts)?['"]/u,
    /responsive-output/u, /solve-responsive-placement/u,
    /perception-timeline-repository/u, /application\/perception-timelines/u, /\.\/perception-timelines\.ts/u,
    /putPerceptionTimeline|PrismaPerceptionTimelineRepository/u,
  ]
  for (const file of DIRECTOR_PATH) {
    const text = await readFile(file, 'utf8')
    for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${file} must not match ${pattern}`)
  }
  // the legacy parser has no importer inside src: nothing outside its own module can reach createReframePlan(observationSet)
  let importers = []
  try {
    importers = execFileSync('git', ['grep', '-l', '-E', "from '[^']*/reframe-plan(\\.ts)?'", '--', 'src'], { encoding: 'utf8' })
      .split('\n').filter(Boolean)
  } catch (error) {
    if (error.status !== 1) throw error // 1 = no match at all
  }
  assert.deepEqual(importers.filter((file) => file !== 'src/v2/domain/reframe-plan.ts'), [])
})
