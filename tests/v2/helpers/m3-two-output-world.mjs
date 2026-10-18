// Pure (no database) project with TWO explicit outputs, 16:9 and 9:16, over one controlled ingest: the sealed Version3/State3 parent
// the multi-output Command/reader tests need. It is built the way the product builds it (creation Command, two explicit output
// variants, a recording ingest that materializes every entry from the one plan); only persistence is replaced.
import { creationRequest, outputWorld, variantBody, variantRequest } from './output-world.mjs'

const { ingestOnto } = await import('./operational-editorial-fixture.mjs')

/** The body of the 9:16 output the world adds beside the published 16:9 example. */
export function verticalOutputBody() {
  const body = variantBody()
  return {
    ...body,
    output: { ...body.output, aspectRatio: '9:16', width: 360, height: 640, deliveryProfileId: 'profile-output-vertical' },
    profile: { ...body.profile, id: 'profile-output-vertical',
      final: { ...body.profile.final, width: 360, height: 640 }, proxy: { ...body.profile.proxy, width: 180, height: 320 } },
  }
}

/**
 * Root, a 16:9 output, a 9:16 output and an ingested recording on top: the head bundle has two materialized entries.
 * `sameRatioTwice` adds a third output with the 9:16 ratio again (the limitation: an aspect ratio is unique per State, so addressing
 * either 9:16 output is refused `output-variant-ambiguous`). Returns `{ world, parent, actor, wideVariantId, verticalVariantId, variantIdOf }`.
 */
export async function twoOutputIngestedWorld(options = {}) {
  const world = outputWorld(options.actor, { ids: options.ids })
  const root = await world.create(creationRequest(world))
  const wide = await world.variant(variantRequest(world, root.bundle, 'm3-variant-wide'))
  const { output, profile } = verticalOutputBody()
  const vertical = await world.variant({ ...variantRequest(world, wide.bundle, 'm3-variant-vertical'), output, profile })
  const last = options.sameRatioTwice === true
    ? await world.variant({ ...variantRequest(world, vertical.bundle, 'm3-variant-vertical-again'), output: { ...output, deliveryProfileId: 'profile-output-vertical-again' },
      profile: { ...profile, id: 'profile-output-vertical-again' } })
    : vertical
  const ingested = ingestOnto(last.bundle, { actor: world.actor, slug: options.slug ?? 'm3source', sourceDurationSeconds: options.sourceDurationSeconds ?? 2 })
  const parent = ingested.bundle
  const entries = parent.state.document.entries
  const expected = options.sameRatioTwice === true ? 3 : 2
  if (entries.length !== expected) throw new Error(`the world expected ${expected} outputs, found ${entries.length}`)
  const ratioOf = (entry) => entry.spec.output?.aspectRatio ?? entry.spec.effectiveSpec?.output?.aspectRatio
  const variantIdOf = (aspectRatio) => {
    const found = entries.filter((entry) => ratioOf(entry) === aspectRatio)
    if (found.length !== 1) throw new Error(`expected one ${aspectRatio} output, found ${found.length}`)
    return found[0].variantId
  }
  return Object.freeze({ world, parent, actor: world.actor, wideVariantId: variantIdOf('16:9'),
    ...(options.sameRatioTwice === true ? { verticalVariantIds: entries.filter((entry) => ratioOf(entry) === '9:16').map((entry) => entry.variantId) } : { verticalVariantId: variantIdOf('9:16') }),
    variantIdOf })
}

/**
 * What a variant-specific Command must leave byte-identical on the entries it does not target: the output spec revision, its
 * hash and body, and the geometry the entry materialized (clips, tracks, composition, timeline). The materialization is re-bound to
 * the new Version (it names `resultVersionId`, `planSnapshotId`, its own id and plan hash), which is true of every child, so those
 * binding fields are not part of the comparison.
 */
export function untouchedFacts(bundle, variantId) {
  const entry = bundle.state.document.entries.find((candidate) => candidate.variantId === variantId)
  if (!entry) throw new Error(`variant ${variantId} is not in the State`)
  const { id: _id, resultVersionId: _version, planSnapshotId: _plan, planHash: _hash, createdAt: _createdAt, ...geometry } =
    entry.consumption.status === 'materialized' ? entry.consumption.materialization.document : {}
  return structuredClone({ variantId: entry.variantId, outputSpecRevisionId: entry.outputSpecRevisionId, specHash: entry.specHash,
    spec: entry.spec, geometry })
}

/** The Version binding a materialization is re-bound to by every child Command. */
export function materializationBinding(bundle, variantId) {
  const entry = bundle.state.document.entries.find((candidate) => candidate.variantId === variantId)
  const document = entry.consumption.materialization.document
  return { resultVersionId: document.resultVersionId, planSnapshotId: document.planSnapshotId }
}
