import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { solveResponsivePlacementService } from '../../src/v2/application/solve-responsive-placement.ts'
import { OUTPUT_FORMAT_REGISTRY } from '../../src/v2/domain/output-format-registry.ts'
import { validateResponsivePlacement } from '../../src/v2/domain/responsive-output.ts'
import { SUBTITLE_STYLE_REGISTRY, subtitlePresetHash } from '../../src/v2/domain/subtitle-system.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { parseResponsivePlacementBody } from '../../src/v2/public-api/responsive-placement-contract.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

test('T-FR-163 public request crosses the exact parser and canonical application service', async () => {
  const request = structuredClone(publicSchemaExamples(getPublicSchema('apollo://schemas/responsive-placement-request/v2'))[0])
  const result = await solveResponsivePlacementService()(parseResponsivePlacementBody(request))

  assert.equal(result.schemaVersion, 'responsive-placement/v2')
  assert.equal(result.registryHash, OUTPUT_FORMAT_REGISTRY.registryHash)
  // T-FR-170: the subtitle band the public solve reports is derived from the named registry
  // preset, so a client can prove which preset produced it instead of trusting a constant.
  assert.equal(result.subtitleRegion.presetId, 'kinetic')
  assert.equal(result.subtitleRegion.registryHash, SUBTITLE_STYLE_REGISTRY.registryHash)
  assert.equal(result.subtitleRegion.presetHash, subtitlePresetHash('kinetic'))
  assert.deepEqual(
    { x: result.elements[0].x, y: result.elements[0].y, width: result.elements[0].width, height: result.elements[0].height },
    result.subtitleRegion.bounds,
  )
  const withoutPreset = await solveResponsivePlacementService()(parseResponsivePlacementBody(
    Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'subtitlePresetId')),
  ))
  assert.equal(withoutPreset.subtitleRegion, null)
  assert.notDeepEqual(withoutPreset.elements[0], result.elements[0])
  assert.doesNotThrow(() => validateResponsivePlacement(result))
  assert.match(result.placementHash, /^[a-f0-9]{64}$/)

  assert.throws(() => parseResponsivePlacementBody({ ...request, legacyScale: 0.5 }), /unsupported field/)
  assert.throws(() => parseResponsivePlacementBody({ ...request, outputSpec: { ...request.outputSpec, hiddenPreset: 'legacy' } }), /unsupported field/)
  await assert.rejects(
    () => solveResponsivePlacementService()(parseResponsivePlacementBody({ ...request, elements: [...request.elements, { ...request.elements[0] }] })),
    /unique/i,
  )
})

test('T-FR-163 public capability is authenticated, naturally idempotent and V2-only', async () => {
  const capability = FOUNDATION_CAPABILITIES.find(({ id }) => id === 'apollo.responsive-placement.solve')
  assert.deepEqual(capability, {
    id: 'apollo.responsive-placement.solve', version: '1.1.0', title: 'Solve responsive placement',
    description: capability.description, exposure: 'public', operationKind: 'preflight', authMode: 'required',
    requiredScopes: ['projects:read'], inputSchemaRef: 'apollo://schemas/responsive-placement-request/v2',
    outputSchemaRef: 'apollo://schemas/responsive-placement-result/v2', endpoint: { method: 'POST', path: '/v1/responsive-placement/solve' },
    toolName: 'apollo.responsive-placement.solve', supportsDryRun: false, costClass: 'free', confirmation: 'none',
    successStatuses: [200], idempotency: 'natural', requestBodyRequired: true, queryParameters: undefined, availableIn: undefined,
  })

  assert.equal(publicSchemaExamples(getPublicSchema(capability.outputSchemaRef)).length, 1)
  const route = await readFile(new URL('../../src/app/v1/responsive-placement/solve/route.ts', import.meta.url), 'utf8')
  assert.match(route, /authenticateExternalRequest\(request\)/)
  assert.match(route, /requireScope\(actor, 'projects:read'\)/)
  assert.match(route, /parseResponsivePlacementBody\(value\)/)
  assert.match(route, /solveResponsivePlacementService\(\)/)
  assert.doesNotMatch(route, /\/api\//)
})
