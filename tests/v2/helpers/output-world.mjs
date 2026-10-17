// Real W66 output world without a database: the public services (createProjectService and
// createProjectOutputVariantService) run against an in-memory repository that applies the same
// bundle builders as the Prisma writers. Every Version, State, Command and hash it yields is the
// production one; only persistence is replaced. Used by the contract test and by tests that need a
// sealed ProjectVersion3/State3 parent instead of a hand-assembled Version.
import { randomUUID } from 'node:crypto'
import { createProjectService, createProjectOutputVariantService } from '../../../src/v2/application/create-project.ts'
import { createExternalAuditContext } from '../../../src/v2/application/authenticate-api-client.ts'
import { buildCreationOutputVersionBundleV2, buildOperationalOutputVersionBundleV3 } from '../../../src/v2/domain/output-version-bundle.ts'
import { DomainError } from '../../../src/v2/domain/errors.ts'
import { getPublicSchema } from '../../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../../src/v2/public-api/schema-examples.ts'

const clone = value => structuredClone(value)
export const variantBody = () => clone(publicSchemaExamples(getPublicSchema('apollo://schemas/create-project-output-variant-request/v1'))[0])
export function worldActor(overrides = {}) {
  const auditContext = createExternalAuditContext({ workspaceId: 'workspace-output-http', clientId: 'client-output-http',
    credentialId: 'credential-output-http', environment: 'sandbox', ...overrides })
  return { ...auditContext, auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
}
export function outputWorld() {
  const roots = new Map(), commands = new Map(), bundles = new Map()
  let head, writes = 0, beforeCommit = () => {}, counter = 0
  const clockIds = { clock: () => new Date('2026-10-13T12:00:00.000Z'),
    createId: kind => `${kind}-${++counter}`, createEventId: randomUUID }
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
    actor: worldActor(), counts: () => writes, head: () => head, changeHeadBeforeCommit: value => { beforeCommit = () => { head = value } } }
}
export const creationRequest = f => ({ workspaceId: f.actor.workspaceId, actor: f.actor, name: 'Empty explicit project',
  objective: 'discovery', locale: 'pt-BR', idempotencyKey: 'root-request-http' })
export const variantRequest = (f, parent, key = 'variant-request-http') => ({ ...variantBody(), workspaceId: f.actor.workspaceId,
  projectId: parent.version.projectId, baseVersionId: parent.version.id, baseHash: parent.version.baseHash,
  actor: f.actor, idempotencyKey: key })
