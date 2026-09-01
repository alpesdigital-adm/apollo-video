import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boundaryStateOwnershipViolations,
  transformationArchitectureViolations,
} from '../../scripts/transformation-architecture-rules.mjs'

/**
 * A gate nobody has ever seen fire is indistinguishable from a gate that does
 * not work. The first draft of these rules reported a clean repository because
 * a stray control character had eaten a word boundary, and nothing noticed —
 * so every rule below is exercised in both directions: it must catch the shape
 * it exists to catch, and it must stay silent on the shape that merely looks
 * like it.
 */

const CANONICAL = {
  rel: 'domain/provider-job.ts',
  source: 'export interface ProviderJob {\n  id: string\n}\n',
}

function violations(...sources) {
  return transformationArchitectureViolations([CANONICAL, ...sources])
}

test('T-FR-113 gate: a second ProviderJob definition is refused', () => {
  assert.deepEqual(violations(), [])

  const twin = violations({
    rel: 'domain/generative-transformation.ts',
    source: "export type ProviderJob = { id: string; transport: 'api' }\n",
  })
  assert.equal(twin.length, 1)
  assert.match(twin[0], /defined exactly once/)

  // Removing the canonical one is equally wrong: "none" is not "one".
  const orphaned = transformationArchitectureViolations([{ rel: 'domain/other.ts', source: 'export const x = 1\n' }])
  assert.match(orphaned[0], /found: none/)

  // Neighbours that merely share the prefix are not a second definition.
  assert.deepEqual(
    violations({ rel: 'domain/provider-job-transport.ts', source: 'export interface ProviderJobTransportState {\n}\n' }),
    [],
  )
})

test('T-FR-113 gate: replay state held in memory is refused', () => {
  const held = violations({
    rel: 'application/provider-callbacks.ts',
    source: 'const consumedNonces = new Set()\n',
  })
  assert.equal(held.length, 1)
  assert.match(held[0], /must be durable/)

  assert.match(
    violations({ rel: 'domain/x.ts', source: 'function apply(job, callback, seenEventIds: Set<string>) {}\n' })[0],
    /must be durable/,
  )

  // Ordinary deduplication inside a pure function is not replay protection.
  // An earlier draft of this rule flagged exactly this line in hybrid search.
  assert.deepEqual(
    violations({ rel: 'domain/hybrid-search.ts', source: 'const deduped = new Map<string, Result>()\n' }),
    [],
  )
  // And infrastructure is allowed to hold caches in memory.
  assert.deepEqual(
    violations({ rel: 'infrastructure/cache.ts', source: 'const nonceCache = new Set()\n' }),
    [],
  )
})

test('T-FR-113 gate: the transformation domain may not branch on provider identity', () => {
  const branched = violations({
    rel: 'domain/transformation-routing.ts',
    source: "if (providerId === 'heygen') return 'avatar'\n",
  })
  assert.equal(branched.length, 1)
  assert.match(branched[0], /branches on a provider or adapter identity literal/)

  assert.match(
    violations({ rel: 'domain/generative-transformation.ts', source: "const x = adapterId !== 'elevenlabs'\n" })[0],
    /identity literal/,
  )

  // A type guard is not a branch on identity. No provider is named "string".
  assert.deepEqual(
    violations({
      rel: 'domain/provider-job-callback.ts',
      source: "if (typeof body.providerId === 'string' && body.providerId !== job.providerId) return\n",
    }),
    [],
  )
  // Comparing two values, rather than a value to a brand, is exactly right.
  assert.deepEqual(
    violations({ rel: 'domain/provider-job.ts', source: 'const same = a.providerId === b.providerId\n', }).filter((entry) => entry.includes('identity literal')),
    [],
  )
  // Outside the transformation domain the rule does not apply.
  assert.deepEqual(
    violations({ rel: 'domain/color-and-export.ts', source: "if (producer.provider === 'ffprobe') return true\n" }),
    [],
  )
})

test('T-FR-113 gate: a provider transport may not reach persistence', () => {
  const reaching = violations({
    rel: 'infrastructure/transformation/http-transformation-provider.ts',
    source: "import { getV2PostgresClient } from '../prisma-postgres/client.ts'\n",
  })
  assert.equal(reaching.length, 1)
  assert.match(reaching[0], /reaches persistence directly/)

  assert.match(
    violations({
      rel: 'infrastructure/heygen-v3-provider.ts',
      source: "import { createProviderJobRepository } from './repository-factory.ts'\n",
    })[0],
    /reaches persistence directly/,
  )

  // A transport talking HTTP is the whole point.
  assert.deepEqual(
    violations({
      rel: 'infrastructure/transformation/http-transformation-provider.ts',
      source: "import { request } from 'node:https'\n",
    }),
    [],
  )
  // Repositories are supposed to reach persistence.
  assert.deepEqual(
    violations({
      rel: 'infrastructure/prisma/provider-job-repository.ts',
      source: "import { getV2PostgresClient } from '../prisma-postgres/client.ts'\n",
    }),
    [],
  )
})

test('T-FR-113 gate: only the aggregate may write an approved provider job', () => {
  const forged = violations({
    rel: 'application/shortcut.ts',
    source: "await tx.v2ProviderJob.update({ where: { id }, data: { status: 'approved' } })\n",
  })
  assert.equal(forged.length, 1)
  assert.match(forged[0], /only reach 'approved' through transitionProviderJob/)

  // Reading approved jobs is the invariant, not a breach of it: the synthetic
  // master repository refuses to promote a master whose job was never approved.
  assert.deepEqual(
    violations({
      rel: 'infrastructure/prisma/synthetic-master-asset-repository.ts',
      source: "const job = await tx.v2ProviderJob.findFirst({ where: { id, status: 'approved' } })\n",
    }),
    [],
  )
})

test('T-FR-113 gate: the API and MCP boundary owns no database client', () => {
  const owning = boundaryStateOwnershipViolations([
    { rel: 'src/app/v1/projects/route.ts', source: "import { getV2PostgresClient } from '@/v2/infrastructure/prisma-postgres/client'\n" },
  ])
  assert.equal(owning.length, 1)
  assert.match(owning[0], /owns no state/)

  assert.equal(
    boundaryStateOwnershipViolations([
      { rel: 'src/v2/public-api/mcp-server.ts', source: "import { PrismaClient } from '../../../generated/prisma-v2/index.js'\n" },
    ]).length,
    1,
  )

  // Calling an application service through the repository factory is the
  // sanctioned composition and must stay silent.
  assert.deepEqual(
    boundaryStateOwnershipViolations([
      { rel: 'src/app/v1/projects/route.ts', source: "import { createProviderJobRepository } from '@/v2/infrastructure/repository-factory'\n" },
    ]),
    [],
  )
})
