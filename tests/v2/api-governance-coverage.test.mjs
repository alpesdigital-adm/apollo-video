import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { API_SCOPES, isApiScope } from '../../src/v2/domain/api-client.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { applicationServicesForEndpoint } from '../../scripts/generate-ui-capability-parity-report.mjs'
import {
  presentReviewPatchBatch,
  presentReviewPatchProposal,
} from '../../src/v2/public-api/collaborative-review-presenters.ts'

const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
const root = resolve(import.meta.dirname, '../..')

test('client governance covers listing, scoped creation, environments and secret lifecycle', () => {
  for (const id of ['apollo.clients.list', 'apollo.clients.create', 'apollo.clients.credentials.rotate', 'apollo.clients.credentials.revoke']) assert.equal(capabilities.has(id), true, id)
  const create = getPublicSchema(capabilities.get('apollo.clients.create').inputSchemaRef).schema
  assert.deepEqual(create.required, ['name', 'scopes'])
  assert.deepEqual(create.properties.environment.enum, ['sandbox', 'production'])
  assert.equal(create.properties.scopes.maxItems, 64)
  for (const id of ['apollo.clients.list', 'apollo.clients.create', 'apollo.clients.credentials.rotate', 'apollo.clients.credentials.revoke']) assert.deepEqual(capabilities.get(id).requiredScopes, ['clients:admin'])
})

test('F0.100 every authenticated capability crosses the centralized durable admission gate', () => {
  const authentication = readFileSync(
    join(root, 'src/v2/public-api/authentication.ts'),
    'utf8',
  )
  assert.match(authentication, /assertPublicCapabilityQuery/)
  assert.match(authentication, /assertCapabilityAccess/)
  assert.match(authentication, /assertKillSwitchRecoveryAccess/)
  assert.match(authentication, /admitGovernedCapabilityService/)
  assert.match(authentication, /createGovernanceAdmissionRepository/)
  assert.match(authentication, /governanceDefaultLimitsFromEnvironment/)
  const runtime = authentication.slice(
    authentication.indexOf('export async function authenticateExternalRequest'),
  )
  assert.ok(
    runtime.indexOf('assertCapabilityAccess') <
      runtime.indexOf('admitGovernedCapabilityService'),
    'unauthorized capabilities must fail before consuming governance quota',
  )
  const routeFiles = readdirSync(join(root, 'src/app/v1'), {
    recursive: true,
  }).map(String).filter((file) => file.endsWith('route.ts'))
  const bypasses = routeFiles.filter((relative) => {
    const source = readFileSync(join(root, 'src/app/v1', relative), 'utf8')
    return /authenticateApiClientService|createApiClientRepository/.test(source)
  }).map((relative) => relative.replaceAll('\\', '/'))
  assert.deepEqual(bypasses.sort(), [
    'session/route.ts',
    'session/workspace/route.ts',
  ])
})

test('webhook governance covers endpoint, subscription, lifecycle, delivery and diagnostics', () => {
  const required = [
    'apollo.webhooks.endpoints.create', 'apollo.webhooks.endpoints.list', 'apollo.webhooks.endpoints.read', 'apollo.webhooks.endpoints.status.set',
    'apollo.webhooks.endpoints.challenge', 'apollo.webhooks.subscriptions.create', 'apollo.webhooks.subscriptions.list', 'apollo.webhooks.subscriptions.read',
    'apollo.webhooks.subscriptions.status.set', 'apollo.webhooks.deliveries.list', 'apollo.webhooks.deliveries.read', 'apollo.webhooks.deliveries.replay',
  ]
  for (const id of required) {
    assert.equal(capabilities.has(id), true, id)
    assert.equal(capabilities.get(id).authMode, 'required')
  }
  assert.equal(capabilities.get('apollo.webhooks.deliveries.list').queryParameters.some((parameter) => parameter.name === 'after'), true)
})

test('T-FR-242 every route uses the authenticated audit actor instead of rebuilding it', () => {
  const routesRoot = join(root, 'src/app/v1')
  const routeFiles = readdirSync(routesRoot, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('route.ts'))
  const manualActor = /actor\s*:\s*\{(?:(?!\}).){0,200}type\s*:\s*['"]api-client['"](?:(?!\}).){0,200}id\s*:\s*actor\.clientId/gs
  const offenders = []
  let canonicalBindings = 0
  let fullActorBindings = 0
  for (const relative of routeFiles) {
    const source = readFileSync(join(routesRoot, relative), 'utf8')
    if (manualActor.test(source)) offenders.push(relative)
    manualActor.lastIndex = 0
    const explicitBindings = source.match(/actor\s*:\s*actor(?:\.auditContext\.actor)?/g)?.length ?? 0
    const authenticatedShorthandBindings = /const actor\s*=\s*await authenticateExternalRequest\(/.test(source)
      ? source.match(/\bactor\s*,/g)?.length ?? 0
      : 0
    canonicalBindings += explicitBindings + authenticatedShorthandBindings
    fullActorBindings += (source.match(/actor\s*:\s*actor(?!\.)/g)?.length ?? 0) + authenticatedShorthandBindings
  }
  assert.deepEqual(offenders, [])
  assert.ok(canonicalBindings >= 60, `expected broad audit propagation, found ${canonicalBindings}`)
  assert.ok(fullActorBindings >= 4, `expected full authenticated actors, found ${fullActorBindings}`)
})

test('T-FR-242 every batch mutation binds the full authentication context through persistence', () => {
  const applicationFiles = [
    'production-batches.ts',
    'batch-partial-retries.ts',
    'script-alignments.ts',
    'take-libraries.ts',
    'compatibility-graphs.ts',
    'variant-recipes.ts',
    'variant-portfolio-preflights.ts',
    'batch-edits.ts',
  ]
  for (const relative of applicationFiles) {
    const source = readFileSync(join(root, 'src/v2/application', relative), 'utf8')
    assert.match(source, /type AuthenticatedExternalActor/)
    assert.match(source, /requireScope\(request\.actor, 'projects:write'\)/)
    assert.match(source, /materializeActorAuditContext\(request\.actor\)/)
    assert.match(source, /actorContextHash:\s*authenticationAudit\.contextHash/)
    assert.match(source, /authenticationAudit[,\s]/)
  }
  for (const relative of [
    'production-batch-repository.ts',
    'script-alignment-repository.ts',
    'take-library-repository.ts',
    'compatibility-graph-repository.ts',
    'variant-recipe-repository.ts',
    'variant-portfolio-preflight-repository.ts',
    'batch-edit-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.match(source, /batchActorAuditData/)
    assert.match(source, /hydrateBatchActorAudit/)
  }
  const routesRoot = join(root, 'src/app/v1/batches')
  for (const relative of readdirSync(routesRoot, { recursive: true }).map(String)) {
    if (!relative.endsWith('route.ts')) continue
    const source = readFileSync(join(routesRoot, relative), 'utf8')
    assert.doesNotMatch(source, /actor:\s*actor\.auditContext\.actor/)
  }
})

test('T-FR-242 project intelligence mutations bind one authenticated actor through idempotency and persistence', () => {
  const applicationFiles = [
    'catalog-speech-segments.ts',
    'catalog-evidence-segments.ts',
    'catalog-validated-segments.ts',
    'hybrid-search.ts',
    'source-deconstructions.ts',
    'contamination-reports.ts',
  ]
  for (const relative of applicationFiles) {
    const source = readFileSync(join(root, 'src/v2/application', relative), 'utf8')
    assert.match(source, /type AuthenticatedExternalActor/)
    assert.match(source, /requireScope\(request\.actor, 'projects:write'\)/)
    assert.match(source, /materializeActorAuditContext\(request\.actor\)/)
    assert.match(source, /actorContextHash:\s*authenticationAudit\.contextHash/)
    assert.match(source, /authenticationAudit[,\s]/)
  }

  for (const relative of [
    'speech-segment-catalog-repository.ts',
    'evidence-segment-repository.ts',
    'validated-segment-repository.ts',
    'semantic-search-repository.ts',
    'source-deconstruction-repository.ts',
    'contamination-report-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.match(source, /externalActorAuditData/)
    assert.match(source, /hydrateExternalActorAudit/)
  }

  for (const relative of [
    'projects/[projectId]/speech-segments/route.ts',
    'projects/[projectId]/evidence-segments/route.ts',
    'projects/[projectId]/validated-segments/route.ts',
    'projects/[projectId]/semantic-search/documents/route.ts',
    'projects/[projectId]/semantic-search/evaluations/route.ts',
    'projects/[projectId]/semantic-search/reuse-runs/route.ts',
    'projects/[projectId]/semantic-search/scale-evaluations/route.ts',
    'projects/[projectId]/source-deconstructions/route.ts',
    'projects/[projectId]/contamination-reports/route.ts',
  ]) {
    const source = readFileSync(join(root, 'src/app/v1', relative), 'utf8')
    assert.doesNotMatch(source, /actor:\s*actor\.auditContext\.actor/)
    assert.match(source, /actor[:,]/)
  }
})

test('T-FR-242 external editorial Commands and durable Director runs bind credential audit', () => {
  const applicationFiles = [
    'apply-editorial-cut-command.ts',
    'replace-source-transcript.ts',
    'manual-edit.ts',
    'review-patch.ts',
    'review-patch-batch.ts',
    'version-compare.ts',
  ]
  for (const relative of applicationFiles) {
    const source = readFileSync(join(root, 'src/v2/application', relative), 'utf8')
    assert.match(source, /type AuthenticatedExternalActor/)
    assert.match(source, /requireScope\(request\.actor, 'projects:write'\)/)
    assert.match(source, /materializeActorAuditContext\(request\.actor\)/)
    assert.match(source, /actorContextHash:\s*authenticationAudit\.contextHash/)
    assert.match(source, /authenticationAudit[\s,]/)
  }

  for (const relative of [
    'editorial-command-repository.ts',
    'source-transcript-replacement-repository.ts',
    'manual-edit-repository.ts',
    'review-patch-repository.ts',
    'review-patch-batch-repository.ts',
    'version-compare-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.match(source, /editCommandExternalActorAuditData/)
    assert.match(source, /hydrateEditCommandExternalActorAudit/)
    if (!relative.startsWith('review-patch')) {
      assert.doesNotMatch(
        source,
        /workspaceId_projectId_idempotencyKey:\s*input/,
        'the audit-only context hash must not leak into Prisma compound keys',
      )
    }
  }

  for (const relative of [
    'projects/[projectId]/manual-edits/route.ts',
    'projects/[projectId]/patch-proposals/[proposalId]/apply/route.ts',
    'projects/[projectId]/patch-batches/[batchId]/apply/route.ts',
    'projects/[projectId]/version-comparisons/route.ts',
  ]) {
    const source = readFileSync(join(root, 'src/app/v1', relative), 'utf8')
    assert.doesNotMatch(source, /actor:\s*actor\.auditContext\.actor/)
    assert.match(source, /actor[:,]/)
  }

  const commandsRoute = readFileSync(
    join(root, 'src/app/v1/projects/[projectId]/commands/route.ts'),
    'utf8',
  )
  assert.equal(
    commandsRoute.match(/actor:\s*actor\.auditContext\.actor/g)?.length ?? 0,
    0,
    'no external command may persist a projected actor without credential audit',
  )
  assert.match(
    commandsRoute,
    /runProjectDirectorService[\s\S]*\n\s*actor,\n/,
  )
  const directorApplication = readFileSync(
    join(root, 'src/v2/application/run-project-director.ts'),
    'utf8',
  )
  assert.match(directorApplication, /canonicalProjectMutationAudit/)
  assert.match(directorApplication, /requireScope\(request\.actor, 'projects:write'\)/)
  assert.match(directorApplication, /materializeActorAuditContext\(request\.actor\)/)
  assert.match(directorApplication, /actorContextHash:\s*authenticationAudit\.contextHash/)
  const directorRepository = readFileSync(
    join(root, 'src/v2/infrastructure/prisma/director-run-repository.ts'),
    'utf8',
  )
  assert.match(directorRepository, /editCommandExternalActorAuditData/)
  assert.match(directorRepository, /hydrateEditCommandExternalActorAudit/)
})

test('T-FR-242 project evaluation mutations bind credential audit across API, Application and Prisma', () => {
  for (const relative of [
    'color-pipeline-compilations.ts', 'contiguous-extraction.ts',
    'proof-needs.ts', 'proof-integrity.ts', 'proof-mode.ts', 'proxy-review.ts',
    'run-quality-iteration.ts', 'select-project-asset.ts',
    'run-mvp-core-gate.ts', 'validation-envelopes.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/application', relative), 'utf8')
    assert.match(source, /type AuthenticatedExternalActor/)
    assert.match(source, /requireScope\(request\.actor, 'projects:write'\)/)
    assert.match(source, /materializeActorAuditContext\(request\.actor\)/)
    assert.match(source, /actorContextHash:\s*authenticationAudit\.contextHash/)
  }

  for (const relative of [
    'color-pipeline-compilation-repository.ts', 'contiguous-extraction-repository.ts',
    'proof-need-repository.ts', 'proof-integrity-repository.ts',
    'proof-mode-repository.ts', 'proxy-review-repository.ts',
    'quality-iteration-repository.ts', 'asset-selection-repository.ts',
    'mvp-core-gate-repository.ts', 'validation-envelope-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.match(source, /externalActorAuditData/)
    assert.match(source, /hydrateExternalActorAudit/)
    assert.doesNotMatch(source, /idempotencyKey:\s*input\s*[,}]/)
  }

  for (const relative of [
    'projects/[projectId]/asset-selections/route.ts',
    'projects/[projectId]/color-pipeline-compilations/route.ts',
    'projects/[projectId]/contiguous-extractions/route.ts',
    'projects/[projectId]/mvp-core-gates/route.ts',
    'projects/[projectId]/proof-integrity-runs/route.ts',
    'projects/[projectId]/proof-mode-runs/route.ts',
    'projects/[projectId]/proof-needs/route.ts',
    'projects/[projectId]/proxy-reviews/route.ts',
    'projects/[projectId]/quality-iterations/route.ts',
    'projects/[projectId]/validation-envelope-reuses/route.ts',
    'projects/[projectId]/validation-envelope-reuses/[reusePlanId]/approval/route.ts',
  ]) {
    const source = readFileSync(join(root, 'src/app/v1', relative), 'utf8')
    assert.doesNotMatch(source, /actor:\s*actor\.auditContext\.actor/)
    assert.match(source, /actor[:,]/)
  }
})

test('T-FR-242 project analysis preserves initiating audit across direct API and durable stages', () => {
  for (const relative of [
    'projects/[projectId]/long-form-moments/route.ts',
    'projects/[projectId]/hierarchical-processing/runs/route.ts',
  ]) {
    const source = readFileSync(join(root, 'src/app/v1', relative), 'utf8')
    assert.match(source, /requireScope\(actor, 'projects:write'\)/)
    assert.match(source, /\n\s*actor,\n/)
    assert.match(source, /provenance:\s*Object\.freeze\(\{ kind: 'external-request'/)
    assert.doesNotMatch(source, /actor:\s*actor\.auditContext\.actor/)
  }
  for (const relative of [
    'catalog-long-form-moments.ts',
    'hierarchical-processing.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/application', relative), 'utf8')
    assert.match(source, /resolveProjectAnalysisExecutionContext/)
    assert.match(source, /actorContextHash:\s*execution\.authenticationAudit\.contextHash/)
    assert.match(source, /provenance:\s*execution\.provenance/)
  }
  const worker = readFileSync(
    join(root, 'src/v2/application/long-form-derived-stage-processor.ts'),
    'utf8',
  )
  assert.match(worker, /authenticationAudit:\s*input\.authenticationAudit/g)
  assert.match(worker, /kind:\s*'long-form-stage'/g)
  for (const relative of [
    'long-form-index-repository.ts',
    'hierarchical-processing-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.match(source, /hydrateProjectAnalysisExecution/)
    assert.match(source, /projectAnalysisExecutionData/)
    assert.match(source, /assertProjectAnalysisFenceBinding/)
  }

  for (const relative of [
    'contiguous-evidence.ts',
    'contiguous-evaluation.ts',
    'speaker-diarization.ts',
  ]) {
    const source = readFileSync(join(
      root,
      'src/v2/application',
      relative,
    ), 'utf8')
    assert.match(source, /authenticationAudit/)
    assert.match(source, /provenance/)
    assert.match(source, /actorContextHash/)
    assert.doesNotMatch(source, /actor:\s*\{\s*type:\s*'api-client'/)
  }
  for (const relative of [
    'contiguous-evidence-repository.ts',
    'contiguous-evaluation-repository.ts',
    'speaker-diarization-repository.ts',
  ]) {
    const source = readFileSync(join(
      root,
      'src/v2/infrastructure/prisma',
      relative,
    ), 'utf8')
    assert.match(source, /hydrateProjectAnalysisExecution/)
    assert.match(source, /projectAnalysisExecutionData/)
    assert.match(source, /actorContextHash/)
  }
  const diarizationRepository = readFileSync(join(
    root,
    'src/v2/infrastructure/prisma/speaker-diarization-repository.ts',
  ), 'utf8')
  assert.match(
    diarizationRepository,
    /calculateSpeakerDiarizationRequestFingerprint/,
  )
  for (const relative of [
    'contiguous-evidence-repository.ts',
    'contiguous-evaluation-repository.ts',
  ]) {
    const source = readFileSync(join(
      root,
      'src/v2/infrastructure/prisma',
      relative,
    ), 'utf8')
    assert.doesNotMatch(
      source,
      /createdByClientId_idempotencyKey:\s*input/,
      'actorContextHash must not leak into the Prisma compound unique input',
    )
    assert.doesNotMatch(
      source,
      /async persist\s*\(/,
      'derived persistence must remain fenced',
    )
  }
})

test('T-FR-242 collaborative review creation binds private audit without leaking it publicly', () => {
  for (const relative of [
    'projects/[projectId]/annotations/route.ts',
    'projects/[projectId]/patch-proposals/route.ts',
    'projects/[projectId]/patch-batches/route.ts',
  ]) {
    const source = readFileSync(join(root, 'src/app/v1', relative), 'utf8')
    assert.match(source, /requireScope\(actor, 'projects:write'\)/)
    assert.match(source, /\n\s*actor,\n/)
    assert.doesNotMatch(source, /author:\s*\{[^}]*actor\.clientId/s)
  }
  for (const relative of [
    'review-project.ts',
    'review-patch.ts',
    'review-patch-batch.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/application', relative), 'utf8')
    assert.match(source, /requireScope\([^,]+, 'projects:write'\)/)
    assert.match(source, /materializeActorAuditContext/)
    assert.match(source, /actorContextHash:\s*authenticationAudit\.contextHash/)
  }
  for (const relative of [
    'review-annotation-repository.ts',
    'review-patch-repository.ts',
    'review-patch-batch-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.match(source, /externalActorAuditData/)
    assert.match(source, /hydrateExternalActorAudit/)
  }
  for (const relative of [
    'review-patch-repository.ts',
    'review-patch-batch-repository.ts',
  ]) {
    const source = readFileSync(join(root, 'src/v2/infrastructure/prisma', relative), 'utf8')
    assert.doesNotMatch(
      source,
      /workspaceId_projectId_idempotencyKey:\s*input/,
      'actorContextHash must not leak into the Prisma compound unique input',
    )
  }
  const privateAudit = Object.freeze({
    credentialId: 'credential-private',
    contextHash: 'a'.repeat(64),
  })
  assert.deepEqual(
    presentReviewPatchProposal({ id: 'proposal-public', authenticationAudit: privateAudit }),
    { id: 'proposal-public' },
  )
  assert.deepEqual(
    presentReviewPatchBatch({ id: 'batch-public', authenticationAudit: privateAudit }),
    { id: 'batch-public' },
  )

  const migration = readFileSync(join(
    root,
    'prisma/v2/migrations/20260805060000_collaborative_review_actor_audit/migration.sql',
  ), 'utf8')
  for (const field of [
    'actorClientId', 'actorCredentialId', 'actorEnvironment',
    'actorAuthenticationKind', 'actorContextHash',
  ]) {
    assert.equal(
      migration.split(`"${field}" IS NOT NULL`).length - 1,
      3,
      `${field} must be explicitly non-null in all three complete tuples`,
    )
  }
  assert.match(migration, /"authorId" = "delegatedUserId"/)
  assert.match(migration, /"authorId" = "actorClientId"/)
})

test('T-FR-242 capability grants and route enforcement share one closed resource:action matrix', () => {
  const routesRoot = join(root, 'src/app/v1')
  const applicationRoot = join(root, 'src/v2/application')
  const applicationFiles = new Map()
  const exportedApplicationFiles = new Map()
  for (const relative of readdirSync(applicationRoot, { recursive: true }).map(String)) {
    if (!relative.endsWith('.ts')) continue
    const file = join(applicationRoot, relative)
    const source = readFileSync(file, 'utf8')
    applicationFiles.set(resolve(file), source)
    for (const match of source.matchAll(/export function\s+([A-Za-z0-9_]+)/g)) {
      exportedApplicationFiles.set(match[1], resolve(file))
    }
  }
  const applicationSourceClosure = (file, visited = new Set()) => {
    if (!file || visited.has(file)) return ''
    visited.add(file)
    const source = applicationFiles.get(file) ?? ''
    const dependencies = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)]
      .map((match) => resolve(dirname(file), match[1]))
      .filter((dependency) => applicationFiles.has(dependency))
    return [source, ...dependencies.map((dependency) => applicationSourceClosure(dependency, visited))]
      .join('\n')
  }
  const capabilityScopes = [...new Set(
    FOUNDATION_CAPABILITIES.flatMap((capability) => capability.requiredScopes),
  )].sort()
  assert.deepEqual(capabilityScopes, [...API_SCOPES].sort())

  for (const capability of FOUNDATION_CAPABILITIES) {
    if (!capability.endpoint || capability.requiredScopes.length === 0) continue
    const routePath = capability.endpoint.path
      .replace(/^\/v1\/?/, '')
      .replace(/\{([^}]+)\}/g, '[$1]')
    const routeSource = readFileSync(join(routesRoot, routePath, 'route.ts'), 'utf8')
    const serviceSource = applicationServicesForEndpoint(root, capability.endpoint)
      .map((name) => applicationSourceClosure(exportedApplicationFiles.get(name)))
      .join('\n')
    const enforcementSource = `${routeSource}\n${serviceSource}`
    for (const scope of capability.requiredScopes) {
      assert.match(
        enforcementSource,
        new RegExp(`requireScope\\([^,]+,\\s*['\"]${scope}['\"]\\)`),
        `${capability.endpoint.method} ${capability.endpoint.path} must enforce ${scope} in its route or shared Application service`,
      )
    }
  }

  for (const sourceRoot of [routesRoot, applicationRoot]) {
    for (const relative of readdirSync(sourceRoot, { recursive: true }).map(String)) {
      if (!relative.endsWith('.ts')) continue
      const source = readFileSync(join(sourceRoot, relative), 'utf8')
      for (const match of source.matchAll(/requireScope\([^,]+,\s*['"]([^'"]+)['"]\)/g)) {
        assert.equal(isApiScope(match[1]), true, `${relative} uses unknown scope ${match[1]}`)
      }
    }
  }
})
