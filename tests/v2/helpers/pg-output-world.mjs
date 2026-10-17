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
