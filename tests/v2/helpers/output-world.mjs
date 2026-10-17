// Real W66 output world without a database: the public services (createProjectService and
// createProjectOutputVariantService) run against an in-memory repository that applies the same
// bundle builders as the Prisma writers. Every Version, State, Command and hash it yields is the
// production one; only persistence is replaced. Used by the contract test and by tests that need a
// sealed ProjectVersion3/State3 parent instead of a hand-assembled Version.
import { randomUUID } from 'node:crypto'
import { createProjectService, createProjectOutputVariantService } from '../../../src/v2/application/create-project.ts'
import { createExternalAuditContext, materializeActorAuditContext } from '../../../src/v2/application/authenticate-api-client.ts'
import { calculateCanonicalHash, stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'
import { createEditCommand } from '../../../src/v2/domain/edit-command.ts'
import { createProjectSnapshot } from '../../../src/v2/domain/project-snapshot.ts'
import { transitionProjectOutputState } from '../../../src/v2/domain/project-output-state-transition.ts'
import { buildCreationOutputVersionBundleV2, buildOperationalOutputVersionBundleV3, operationalBundlePlanV3 } from '../../../src/v2/domain/output-version-bundle.ts'
import { DomainError } from '../../../src/v2/domain/errors.ts'
import { getPublicSchema } from '../../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../../src/v2/public-api/schema-examples.ts'
import { prepareEditorialSourceFixture, ingestOnto, recordingNames } from './operational-editorial-fixture.mjs'

const clone = value => structuredClone(value)
export const variantBody = () => clone(publicSchemaExamples(getPublicSchema('apollo://schemas/create-project-output-variant-request/v1'))[0])
export function worldActor(overrides = {}) {
  const auditContext = createExternalAuditContext({ workspaceId: 'workspace-output-http', clientId: 'client-output-http',
    credentialId: 'credential-output-http', environment: 'sandbox', ...overrides })
  return { ...auditContext, auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
}
/** `ids` pins the identity a kind would otherwise be given by counter (for suites that name their project). */
export function outputWorld(actor = worldActor(), { ids = {} } = {}) {
  const roots = new Map(), commands = new Map(), bundles = new Map()
  let head, writes = 0, beforeCommit = () => {}, counter = 0
  const clockIds = { clock: () => new Date('2026-10-13T12:00:00.000Z'),
    createId: kind => ids[kind] ?? `${kind}-${++counter}`, createEventId: randomUUID }
  const creationRepository = { async persist(input) {
    const identity = input.proposal.author.id + ':' + input.idempotencyKey, existing = roots.get(identity)
    if (existing) {
      if (existing.command.requestFingerprint !== input.proposal.requestFingerprint)
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Different creation intent')
      return { bundle: existing, replayed: true }
    }
    const bundle = buildCreationOutputVersionBundleV2(input.recompose(null))
    roots.set(identity, bundle); bundles.set(bundle.version.id, bundle); head = bundle.version.id; writes++
    return { bundle, replayed: false }
  } }
  const operationalRepository = {
    async read(scope) { return [...bundles.values()].find(b => b.version.id === scope.versionId &&
      b.version.projectId === scope.projectId && b.version.workspaceId === scope.workspaceId) ?? null },
    async persistChild(input) {
      const result = input.proposal.origin.result, c = result.command, existing = commands.get(c.idempotencyKey)
      if (existing) {
        if (existing.origin.result.requestFingerprint !== result.requestFingerprint)
          throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Different variant intent')
        return { bundle: existing, replayed: true }
      }
      beforeCommit()
      if (head !== input.proposal.parent.version.id) throw new DomainError('VERSION_CONFLICT', 'Head changed')
      const bundle = buildOperationalOutputVersionBundleV3(input.recompose({ parent: bundles.get(head), restoreTarget: null, normalizations: [] }))
      commands.set(c.idempotencyKey, bundle); bundles.set(bundle.version.id, bundle); head = bundle.version.id; writes++
      return { bundle, replayed: false }
    },
  }
  return { create: createProjectService({ ...clockIds, repository: creationRepository }),
    variant: createProjectOutputVariantService({ ...clockIds, repository: operationalRepository }),
    actor, counts: () => writes, head: () => head, changeHeadBeforeCommit: value => { beforeCommit = () => { head = value } } }
}
export const creationRequest = f => ({ workspaceId: f.actor.workspaceId, actor: f.actor, name: 'Empty explicit project',
  objective: 'discovery', locale: 'pt-BR', idempotencyKey: 'root-request-http' })
export const variantRequest = (f, parent, key = 'variant-request-http') => ({ ...variantBody(), workspaceId: f.actor.workspaceId,
  projectId: parent.version.projectId, baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
  actor: f.actor, idempotencyKey: key })

// Root, one explicit variant and a controlled ingest (synthetic probe facts, real sealed normalization and
// materialization): the parent a child Command needs. See operational-editorial-fixture.mjs for its limits.
export async function ingestedWorld(options = {}) {
  const world = outputWorld(options.actor, { ids: options.ids }), root = await world.create(creationRequest(world))
  const prepared = await prepareEditorialSourceFixture(null, { bundle: root.bundle, projectAtCreation: root.projectAtCreation },
    { actor: world.actor, ...options })
  // `chain` is every sealed bundle from the creation root to the ingest, oldest first.
  return { world, root, prepared, parent: prepared.bundle, actor: world.actor, chain: [root.bundle, prepared.variant, prepared.bundle] }
}

/**
 * A sealed child of `parent` whose EditPlan is `mutatePlan(parentPlan)`: the way a test obtains a real
 * Version3/State3 with a specific timeline without going through the Command that would normally compile it.
 * The Command is a plain recompiling child, so only the plan (and what re-materializes from it) differs.
 */
export function recompiledChild(parent, actor, mutatePlan, { suffix = 'recompiled', type = 'apply-review-patch', createdAt = '2026-10-16T09:00:00.000Z', versionId, snapshotId, adoptable } = {}) {
  const audit = materializeActorAuditContext(actor)
  const scope = { workspaceId: parent.version.workspaceId, projectId: parent.version.projectId }
  const resultVersionId = versionId ?? `version-${suffix}`
  const base = operationalBundlePlanV3(parent), plan = mutatePlan(JSON.parse(base.contentJson))
  const next = { ...plan, id: `edit-plan-${resultVersionId}`, projectVersionId: resultVersionId, createdAt }
  const command = createEditCommand({ ...scope, id: `command-${suffix}`, baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
    author: { type: 'api-client', id: audit.clientId }, type, scope: { project: true }, payload: { schemaVersion: 1 },
    idempotencyKey: `key-${suffix}`, createdAt })
  let counter = 0
  return transitionProjectOutputState({ parent, command, audit, requestFingerprint: calculateCanonicalHash({ suffix }),
    allocation: { ...scope, resultVersionId, stateId: `state-${suffix}`, parentVersionId: parent.version.id,
      sequence: parent.version.sequence + 1, createdBy: audit.clientId, createdAt },
    editPlanSnapshot: createProjectSnapshot({ ...scope, id: snapshotId ?? `snapshot-${suffix}`, kind: 'edit-plan', contentSchemaVersion: base.contentSchemaVersion,
      contentJson: stableSerialize(next), contentHash: calculateCanonicalHash(next), createdAt }),
    createMaterializationId: () => `materialization-${suffix}-${++counter}`, ...(adoptable === undefined ? {} : { adoptable }) })
}

/** The rights evidence the world gives a recording: one current approved snapshot of its source artifact. */
export function rightsEvidenceFor(slug) {
  const names = recordingNames(slug)
  return Object.freeze({ snapshotId: `rights-${names.slug}`, snapshotHash: calculateCanonicalHash({ rights: names.sourceArtifactId }), revision: 1 })
}

/**
 * Several recordings ingested one after another onto one project: root, explicit variant, then one ingest per slug.
 * State3 keeps only the latest ingest's recording in the head State, but every ingest persisted its own receipt, so
 * the earlier ones are what `adoptable` offers a child Command (each with its rights evidence), exactly as the
 * repositories read them. `durations` gives a recording's observed length in seconds (default 2).
 */
export async function ingestedRecordings(slugs, { durations = {}, ...options } = {}) {
  const world = await ingestedWorld({ ...options, slug: slugs[0], sourceDurationSeconds: durations[slugs[0]] ?? 2 })
  const receipts = new Map([[slugs[0], world.prepared.n]])
  const chain = [...world.chain]
  let head = world.parent
  for (const slug of slugs.slice(1)) {
    const next = ingestOnto(head, { actor: world.actor, slug, sourceDurationSeconds: durations[slug] ?? 2 })
    head = next.bundle
    receipts.set(slug, next.n)
    chain.push(head)
  }
  const last = slugs.at(-1)
  const adoptable = slugs.filter((slug) => slug !== last).map((slug) => ({ normalization: receipts.get(slug), rights: rightsEvidenceFor(slug) }))
  return { ...world, parent: head, chain, receipts, adoptable, slugs, names: (slug) => recordingNames(slug) }
}
