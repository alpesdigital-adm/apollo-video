import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { PUBLIC_SCHEMAS, getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaDocument, publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
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
  // whichever version the registry currently publishes for the capability: never the legacy one, never one that declares an observation set,
  // and closed to every field it does not name
  assert.notEqual(reframe.inputSchemaRef, legacy)
  assert.ok(/^apollo:\/\/schemas\/reframe-plan-request\/v[2-9][0-9]*$/u.test(reframe.inputSchemaRef), reframe.inputSchemaRef)
  const current = getPublicSchema(reframe.inputSchemaRef).schema
  assert.equal(Object.hasOwn(current.properties, 'observationSet'), false)
  assert.equal(current.additionalProperties, false)
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
  // The clean body is the published example of the schema the capability CURRENTLY names (so a new version of the request keeps the proof
  // meaningful); the poisoned body is that same body plus an observation set, and must be refused for that field and no other.
  for (const id of ['apollo.projects.reframe-plans.create', 'apollo.projects.director-runs.enqueue']) {
    const capability = FOUNDATION_CAPABILITIES.find((candidate) => candidate.id === id)
    const definition = getPublicSchema(capability.inputSchemaRef)
    const validate = ajv.compile(publicSchemaDocument(definition))
    const [clean] = publicSchemaExamples(definition)
    assert.equal(validate(clean), true, `${id} accepts its published example: ${JSON.stringify(validate.errors)}`)
    const poisoned = { ...clean, observationSet: { id: 'caller-observations' } }
    assert.equal(validate(poisoned), false, `${id} must refuse a body with an observationSet`)
    assert.ok(validate.errors.some((error) => error.keyword === 'additionalProperties' && error.params.additionalProperty === 'observationSet'), id)
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
  // The caller-observation entry points of the legacy module (the parser of a caller's set and the planner that consumes it) have no
  // importer inside src. Other helpers of the module (crop geometry the reframe trajectory reuses) are not entry points of a caller's observations.
  const entryPoints = ['createReframePlan', 'parseReframeObservationSet']
  let importers = []
  try {
    importers = execFileSync('git', ['grep', '-l', '-E', "from '[^']*/reframe-plan(\\.ts)?'", '--', 'src'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (error) {
    if (error.status !== 1) throw error // 1 = no match at all
  }
  const offenders = []
  const named = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'[^']*\/reframe-plan(?:\.ts)?'/gu
  const whole = /import\s+\*\s+as\s+\w+\s+from\s*'[^']*\/reframe-plan(?:\.ts)?'/u
  for (const file of importers.filter((item) => item !== 'src/v2/domain/reframe-plan.ts')) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(named)) {
      const names = match[1].split(',').map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0])
      if (names.some((name) => entryPoints.includes(name))) offenders.push(file)
    }
    assert.equal(whole.test(text), false, `${file} must not import the module whole`)
  }
  // Since W66r exactly one module uses them: the SERVER-owned variant planner, which builds its observation set from sealed server face
  // evidence and re-reads a stored one only after requiring the server-owned schema (`reframe-observations/v2`). A new importer of a
  // caller-observation entry point has to be looked at and added here on purpose.
  assert.deepEqual([...new Set(offenders)], ['src/v2/domain/variant-reframe-plan.ts'])
  const planner = await readFile('src/v2/domain/variant-reframe-plan.ts', 'utf8')
  assert.ok(planner.includes("observationSet.schemaVersion === 'reframe-observations/v2', 'INVALID_RENDER_INPUT', 'Reframe plan record observations must be server-owned'"))
  assert.ok(planner.includes('projectFaceEvidenceToReframeObservations'), 'its observations are projected from sealed face evidence')
})
