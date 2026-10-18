import assert from 'node:assert/strict'
import test from 'node:test'

import { creationRequest, outputWorld, variantRequest } from './helpers/output-world.mjs'

const { projectOutputFormat, requireProjectOutputFormat } = await import('../../src/v2/infrastructure/prisma/project-output-format.ts')

async function headWithVariants(count) {
  const world = outputWorld()
  const root = await world.create(creationRequest(world))
  let head = root.bundle
  for (let index = 0; index < count; index += 1) {
    const body = variantRequest(world, head, `variant-request-${index}`)
    head = (await world.variant(body)).bundle
  }
  return head
}

test('a 6.0.0 project with one explicit output has that output as its format', async () => {
  const head = await headWithVariants(1)
  assert.equal(projectOutputFormat({ format: null }, head), '16:9')
})

test('a stored format wins, a project without outputs has none, and several outputs are ambiguous', async () => {
  assert.equal(projectOutputFormat({ format: '9:16' }, await headWithVariants(1)), '9:16')
  assert.equal(projectOutputFormat({ format: null }, await headWithVariants(0)), null, 'no output yet')
  const world = outputWorld()
  const root = await world.create(creationRequest(world))
  const first = await world.variant(variantRequest(world, root.bundle, 'variant-first'))
  const second = await world.variant({
    ...variantRequest(world, first.bundle, 'variant-second'),
    output: { ...variantRequest(world, first.bundle).output, aspectRatio: '9:16', width: 360, height: 640, deliveryProfileId: 'profile-vertical' },
    profile: { ...variantRequest(world, first.bundle).profile, id: 'profile-vertical',
      final: { ...variantRequest(world, first.bundle).profile.final, width: 360, height: 640 },
      proxy: { ...variantRequest(world, first.bundle).profile.proxy, width: 180, height: 320 } },
  })
  assert.equal(second.bundle.state.document.entries.length, 2)
  assert.equal(projectOutputFormat({ format: null }, second.bundle), null, 'two outputs: the caller must refuse, not guess')
})

// A copy keeps the literal fork revision of every output it was copied with: the geometry lives in `effectiveSpec`.
test('a copy answers with the geometry its fork revision was copied with', async () => {
  const fork = { schemaVersion: 'output-spec-revision/v3', effectiveSpec: { output: { aspectRatio: '9:16' } } }
  assert.equal(projectOutputFormat({ format: null }, { state: { document: { entries: [{ spec: fork }] } } }), '9:16')
  assert.equal(projectOutputFormat({ format: null }, { state: { document: { entries: [{ spec: fork }, { spec: fork }] } } }), null, 'two outputs stay ambiguous')
  assert.equal(projectOutputFormat({ format: null }, { state: { document: { entries: [{ spec: { schemaVersion: 'output-spec-revision/v3', effectiveSpec: {} } }] } } }), null)
})

// A child Command that attributes proxy and final outputs by format refuses a project with no single format: it never guesses a ratio.
test('requireProjectOutputFormat answers the single format and refuses the ambiguous with the published reason', async () => {
  assert.equal(requireProjectOutputFormat({ format: null }, await headWithVariants(1)), '16:9')
  assert.equal(requireProjectOutputFormat({ format: '9:16' }, await headWithVariants(0)), '9:16', 'a stored format still wins')
  const refused = (bundle) => assert.throws(() => requireProjectOutputFormat({ format: null }, bundle),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'output-variant-required')
  refused(await headWithVariants(0))
  const spec = { schemaVersion: 'output-spec-revision/v3', effectiveSpec: { output: { aspectRatio: '9:16' } } }
  refused({ state: { document: { entries: [{ spec }, { spec }] } } })
  refused({ state: { document: { entries: [{ spec: { output: {} } }] } } })
})
