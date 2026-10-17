// A project with a sealed head Version, for PostgreSQL suites.
//
// A ProjectVersion is born together with its sealed output State, and the database refuses a Version row that is
// not (contracts two and three only). A suite therefore cannot insert project, snapshot and Version rows by hand any
// more. This builds the same world the product builds: the creation Command (root, contract 2) through
// createProjectService and PrismaCreationOutputBundleRepositoryV2, then one explicit output variant (contract 3)
// through createProjectOutputVariantService and PrismaOperationalOutputBundleRepositoryV3. Nothing is written
// around those repositories.
//
// Two rules follow from "sealed":
// - Sealed rows are append-only. Nothing here deletes them, and a suite must not delete them either: every identity
//   is unique to the invocation (`uniqueRun`), and the owner of a disposable schema resets it between runs.
// - The head carries no media. A plan with duration needs observed sources, so a suite that needs a compiled
//   timeline has to ingest (or fork) one; this world is for suites that need a project and a Version to hang rows on.
//
// Pure counterpart: output-world.mjs (the same services on an in-memory repository).
import { randomUUID } from 'node:crypto'

import { createExternalAuditContext } from '../../../src/v2/application/authenticate-api-client.ts'
import { createProjectService, createProjectOutputVariantService } from '../../../src/v2/application/create-project.ts'
import {
  PrismaCreationOutputBundleRepositoryV2,
  PrismaOperationalOutputBundleRepositoryV3,
} from '../../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { variantBody } from './output-world.mjs'

/** Identities unique to this invocation: `id('project')` is `<prefix>-<run>-project-<n>`. */
export function uniqueRun(prefix) {
  const run = randomUUID().replaceAll('-', '').slice(0, 12)
  let counter = 0
  return Object.freeze({ run, id: (kind) => `${prefix}-${run}-${kind}-${++counter}` })
}

/**
 * The authenticated actor the application services take (the shape `authenticateApiClient` yields), for a PG suite that
 * has no HTTP layer. `ensureWorkspaceActor` creates the workspace and API client rows it names.
 */
export function testActor({ workspaceId, clientId, credentialId = `${clientId}-credential`, environment = 'sandbox', scopes = ['projects:write', 'media:write'] }) {
  const auditContext = createExternalAuditContext({ workspaceId, clientId, credentialId, environment })
  return Object.freeze({ ...auditContext, auditContext, scopes: new Set(scopes), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' })
}

/**
 * The rows a sealed Command's author must have: the workspace and the API client the Command names (the creation
 * Command and every edit Command carry foreign keys to both). Created when missing, never replaced.
 */
export async function ensureWorkspaceActor(client, { workspaceId, actor, createdAt = new Date() }) {
  if (!(await client.v2Workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }))) {
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: workspaceId, createdAt, updatedAt: createdAt } })
  }
  if (!(await client.v2ApiClient.findFirst({ where: { id: actor.clientId, workspaceId }, select: { id: true } }))) {
    await client.v2ApiClient.create({ data: { id: actor.clientId, workspaceId, name: actor.clientId, allowedEnvironmentsJson: JSON.stringify([actor.environment]),
      scopeGrantsJson: JSON.stringify([...actor.scopes]), createdBy: actor.clientId, createdAt } })
  }
}

/**
 * Creates the root and, unless `variant` is false, one explicit output variant on it.
 *
 * `ids` pins identities the suite already names (`{ project: 'my-project' }`); every other kind is allocated from
 * `uniqueRun`. `variant` may carry the output/profile/preset of the variant to create (default: the 16:9 example the
 * public contract publishes). The returned `head` is the variant Version when one was created, else the root.
 */
export async function seedSealedProject(client, {
  workspaceId, actor, prefix = 'world', ids = {}, name = 'Sealed world project', objective = 'discovery',
  locale = 'pt-BR', variant = {}, at = () => new Date(),
}) {
  const allocate = uniqueRun(prefix)
  await ensureWorkspaceActor(client, { workspaceId, actor })
  const createId = (kind) => ids[kind] ?? allocate.id(kind)
  const dependencies = (repository) => ({ repository, clock: at, createId, createEventId: randomUUID })
  const created = await createProjectService(dependencies(new PrismaCreationOutputBundleRepositoryV2(client)))({
    workspaceId, name, objective, locale, actor, idempotencyKey: allocate.id('root-request'),
  })
  const projectId = created.projectAtCreation.id
  const root = created.bundle
  if (variant === false) return Object.freeze({ projectId, root, variant: null, head: root, run: allocate.run, createId })
  const child = await createProjectOutputVariantService(dependencies(new PrismaOperationalOutputBundleRepositoryV3(client)))({
    ...variantBody(), ...variant, workspaceId, projectId, baseVersionId: root.version.id, baseHash: root.version.baseHash,
    actor, idempotencyKey: allocate.id('variant-request'),
  })
  const bundle = child.bundle
  const entry = bundle.state.document.entries.find((item) => item.variantId === bundle.origin.result.command.payload.variantId)
    ?? bundle.state.document.entries.at(-1)
  return Object.freeze({
    projectId, root, variant: bundle, head: bundle, variantId: entry.variantId, run: allocate.run, createId,
  })
}

/** The row of an AssetRightsSnapshot, every column its integrity check reads back (hydrateAssetRights recomputes the seal). */
export function assetRightsRow(snapshot) {
  const list = (value) => (value === undefined ? null : JSON.stringify(value))
  return {
    id: snapshot.id, workspaceId: snapshot.workspaceId, artifactId: snapshot.artifactId, sequence: snapshot.sequence,
    schemaVersion: snapshot.schemaVersion, snapshotHash: snapshot.snapshotHash, owner: snapshot.owner ?? null, license: snapshot.license ?? null,
    status: snapshot.status, allowedUsesJson: JSON.stringify(snapshot.allowedUses), prohibitedUsesJson: JSON.stringify(snapshot.prohibitedUses),
    allowedWorkspaceIdsJson: JSON.stringify(snapshot.allowedWorkspaceIds), allowedMarketsJson: list(snapshot.allowedMarkets),
    allowedLocalesJson: list(snapshot.allowedLocales), allowedSyntheticOperationsJson: list(snapshot.allowedSyntheticOperations),
    expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null, consentStatus: snapshot.consent.status,
    consentAllowedUsesJson: JSON.stringify(snapshot.consent.allowedUses), consentAllowedMarketsJson: list(snapshot.consent.allowedMarkets),
    consentAllowedLocalesJson: list(snapshot.consent.allowedLocales), consentSyntheticOperationsJson: list(snapshot.consent.allowedSyntheticOperations),
    consentExpiresAt: snapshot.consent.expiresAt ? new Date(snapshot.consent.expiresAt) : null,
    consentDocumentArtifactId: snapshot.consent.documentArtifactId ?? null, sourceNote: snapshot.sourceNote ?? null,
    createdByType: snapshot.createdBy.type, createdById: snapshot.createdBy.id, createdAt: new Date(snapshot.createdAt),
  }
}

/** Stores a rights snapshot and makes it the artifact's current one at its sequence (the audited pointer and revision). */
export async function persistCurrentRights(client, snapshot) {
  await client.v2AssetRightsSnapshot.create({ data: assetRightsRow(snapshot) })
  await client.v2MediaArtifact.update({ where: { id: snapshot.artifactId }, data: { currentRightsSnapshotId: snapshot.id, rightsRevision: snapshot.sequence } })
  return snapshot
}
