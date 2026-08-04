import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))
const schemaPath = 'prisma/v2/schema.prisma'
const migrationsPath = 'prisma/v2/migrations'
const schema = readFileSync(schemaPath, 'utf8')
const environment = {
  ...process.env,
  V2_DATABASE_URL:
    process.env.V2_DATABASE_URL ??
    'postgresql://apollo:validate-only@127.0.0.1:5432/apollo_v2?schema=public',
}

function runPrisma(args, capture = false) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.status !== 0) {
    if (result.error) throw result.error
    if (capture) process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  return result.stdout ?? ''
}

function names(sql, pattern) {
  return new Set([...sql.matchAll(pattern)].map((match) => match[1]))
}

function assertSetContains(actual, expected, label) {
  const missing = [...expected].filter((name) => !actual.has(name))
  assert.deepEqual(missing, [], `${label} missing from committed migration`)
}

runPrisma(['validate', '--schema', schemaPath])
const generated = runPrisma(
  ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script'],
  true,
)
const committed = readdirSync(migrationsPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) => readFileSync(`${migrationsPath}/${entry.name}/migration.sql`, 'utf8'))
  .join('\n')
const operationActorAuditMigration = readFileSync(
  `${migrationsPath}/20260805000000_public_operation_actor_audit/migration.sql`,
  'utf8',
)
const batchActorAuditMigration = readFileSync(
  `${migrationsPath}/20260805010000_batch_actor_audit/migration.sql`,
  'utf8',
)
const projectIntelligenceActorAuditMigration = readFileSync(
  `${migrationsPath}/20260805020000_project_intelligence_actor_audit/migration.sql`,
  'utf8',
)
const editCommandActorAuditContractMigration = readFileSync(
  `${migrationsPath}/20260805030000_contract_edit_command_actor_audit/migration.sql`,
  'utf8',
)
const projectEvaluationActorAuditMigration = readFileSync(
  `${migrationsPath}/20260805040000_project_evaluation_actor_audit/migration.sql`,
  'utf8',
)

assert.match(
  committed,
  /DROP CONSTRAINT "artifact_render_operations_output_check"[\s\S]*"outputKey" ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/-\]\*\\\.mp4\$'/,
  'the output-key check must use a PostgreSQL-compatible unbounded repetition plus length guard',
)

const apiClientModel = schema.match(/model V2ApiClient \{([\s\S]*?)\n\}/)?.[1] ?? ''
const apiCredentialModel = schema.match(/model V2ApiCredential \{([\s\S]*?)\n\}/)?.[1] ?? ''
const apiAccessCommandModel = schema.match(/model V2ApiAccessCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const apiAdministrationCommandModel = schema.match(/model V2ApiAdministrationCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const webhookAdministrationCommandModel = schema.match(/model V2WebhookAdministrationCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const mediaArtifactLifecycleTransitionModel = schema.match(/model V2MediaArtifactLifecycleTransition \{([\s\S]*?)\n\}/)?.[1] ?? ''
const mediaDownloadGrantModel = schema.match(/model V2MediaDownloadGrant \{([\s\S]*?)\n\}/)?.[1] ?? ''
const mediaUploadAuditEntryModel = schema.match(/model V2MediaUploadAuditEntry \{([\s\S]*?)\n\}/)?.[1] ?? ''
const assetRightsChangeModel = schema.match(/model V2AssetRightsChange \{([\s\S]*?)\n\}/)?.[1] ?? ''
const projectCreationCommandModel = schema.match(/model V2ProjectCreationCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const workspaceLutVersionModel = schema.match(/model V2WorkspaceLutVersion \{([\s\S]*?)\n\}/)?.[1] ?? ''
const workspaceLutStatusCommandModel = schema.match(/model V2WorkspaceLutStatusCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const workspaceLutDefaultVersionModel = schema.match(/model V2WorkspaceLutDefaultVersion \{([\s\S]*?)\n\}/)?.[1] ?? ''
const editCommandModel = schema.match(/model V2EditCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const materializationAuthorizationModel = schema.match(/model V2MaterializationAuthorization \{([\s\S]*?)\n\}/)?.[1] ?? ''
const publicOperationModel = schema.match(/model V2PublicOperation \{([\s\S]*?)\n\}/)?.[1] ?? ''
const publicOperationControlCommandModel = schema.match(/model V2PublicOperationControlCommand \{([\s\S]*?)\n\}/)?.[1] ?? ''
const longFormIndexWorkflowModel = schema.match(/model V2LongFormIndexWorkflow \{([\s\S]*?)\n\}/)?.[1] ?? ''
const sourceCleanupPlanModel = schema.match(/model V2SourceCleanupPlan \{([\s\S]*?)\n\}/)?.[1] ?? ''
const batchActorAuditModels = [
  'V2ProductionBatch', 'V2ScriptAlignmentRun', 'V2ScriptAlignmentReview',
  'V2TakeLibraryRun', 'V2TakeLibrarySelection', 'V2CompatibilityGraphRun',
  'V2VariantRecipeRun', 'V2VariantPortfolioPreflightRun',
  'V2BatchEditPreflightRun', 'V2BatchEditCommand', 'V2ProductionBatchAction',
].map((name) => [
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '',
  name,
])
const projectIntelligenceActorAuditModels = [
  'V2SpeechSegmentCatalogRun', 'V2EvidenceSegment', 'V2ValidatedSegment',
  'V2SemanticSearchDocument', 'V2RetrievalEvaluation',
  'V2RetrievalScaleEvaluation', 'V2SemanticReuseRun',
  'V2SourceDeconstructionReport', 'V2ContaminationReport',
].map((name) => [
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '',
  name,
])
const projectEvaluationActorAuditModels = [
  'V2ColorPipelineCompilation', 'V2AssetSelection', 'V2QualityIteration',
  'V2MvpCoreGate', 'V2ProxyReviewDecision', 'V2ContiguousExtraction',
  'V2ValidationEnvelopeReuse', 'V2ValidationEnvelopeDecision',
  'V2ProofNeedRun', 'V2ProofIntegrityRun', 'V2ProofModeRun',
].map((name) => [
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '',
  name,
])
assert.doesNotMatch(
  apiClientModel,
  /secretSalt|secretHash/,
  'ApiClient identity must reference credentials instead of duplicating verifiers',
)
assert.match(apiCredentialModel, /secretSalt\s+String\s+@db\.VarChar\(22\)/)
assert.match(apiCredentialModel, /secretHash\s+String\s+@db\.VarChar\(64\)/)
assert.match(
  committed,
  /ALTER TABLE "api_clients"[\s\S]*DROP COLUMN "secretSalt"[\s\S]*DROP COLUMN "secretHash"/,
  'the credential contract migration must remove verifier copies from api_clients',
)
for (const field of [
  'issuerCredentialId', 'issuerEnvironment', 'issuerAuthenticationKind',
  'issuerContextHash', 'issuerDelegatedUserId', 'issuerDelegatedIdentityId',
  'issuerWorkspaceRole', 'revokerCredentialId', 'revokerEnvironment',
  'revokerAuthenticationKind', 'revokerContextHash', 'revokerDelegatedUserId',
  'revokerDelegatedIdentityId', 'revokerWorkspaceRole',
]) {
  assert.match(mediaDownloadGrantModel, new RegExp(`\\b${field}\\b`), `MediaDownloadGrant must persist ${field}`)
}
assert.match(
  committed,
  /DELETE FROM "media_download_grants";[\s\S]*ADD COLUMN "issuerCredentialId"[\s\S]*ADD COLUMN "revokerContextHash"/,
  'unattributable short-lived download grants must be invalidated before audit fields become required',
)
for (const field of [
  'workspaceId', 'uploadId', 'action', 'partNumber', 'actorClientId',
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  'requestFingerprint', 'occurredAt',
]) {
  assert.match(mediaUploadAuditEntryModel, new RegExp(`\\b${field}\\b`), `MediaUploadAuditEntry must persist ${field}`)
}
assert.match(
  committed,
  /ADD COLUMN "sessionAuditEntryId" UUID[\s\S]*CREATE TABLE "media_upload_audit_entries"[\s\S]*'begin'[\s\S]*'session-issue'[\s\S]*'part-record'[\s\S]*'complete'[\s\S]*'abort'/,
  'media upload mutations must use one constrained immutable audit ledger',
)
assert.doesNotMatch(
  committed,
  /(?:UPDATE|INSERT INTO) "media_upload_audit_entries"[\s\S]*media_uploads/,
  'pre-contract upload audit identity must never be fabricated by backfill',
)
for (const field of [
  'workspaceId', 'artifactId', 'sequence', 'snapshotId', 'snapshotHash',
  'baseRevision', 'resultRevision', 'actorKind', 'actorType', 'actorId',
  'actorClientId', 'actorCredentialId', 'actorEnvironment',
  'actorAuthenticationKind', 'actorDelegatedUserId',
  'actorDelegatedIdentityId', 'actorWorkspaceRole', 'actorContextHash',
  'requestFingerprint', 'changedAt',
]) {
  assert.match(assetRightsChangeModel, new RegExp(`\\b${field}\\b`), `AssetRightsChange must persist ${field}`)
}
assert.match(
  committed,
  /CREATE TABLE "asset_rights_changes"[\s\S]*"actorKind"[\s\S]*"actorContextHash"[\s\S]*asset_rights_changes_actor_check/,
  'every asset rights revision must have a constrained immutable actor ledger entry',
)
assert.doesNotMatch(
  committed,
  /(?:UPDATE|INSERT INTO) "asset_rights_changes"[\s\S]*asset_rights_snapshots/,
  'pre-contract asset rights authorship must never be fabricated by backfill',
)
for (const field of [
  'workspaceId', 'action', 'projectId', 'versionId', 'sourceProjectId',
  'sourceVersionId', 'actorClientId', 'actorCredentialId', 'actorEnvironment',
  'actorAuthenticationKind', 'actorContextHash', 'actorDelegatedUserId',
  'actorDelegatedIdentityId', 'actorWorkspaceRole', 'requestFingerprint',
  'commandHash', 'createdAt',
]) {
  assert.match(
    projectCreationCommandModel,
    new RegExp(`\\b${field}\\b`),
    `ProjectCreationCommand must persist ${field}`,
  )
}
assert.match(
  committed,
  /CREATE TABLE "project_creation_commands"[\s\S]*project_creation_commands_action_check[\s\S]*project_creation_commands_actor_check[\s\S]*project_creation_commands_hash_check/,
  'project creation and duplication must use one constrained immutable actor ledger',
)
assert.doesNotMatch(
  committed,
  /(?:UPDATE|INSERT INTO) "project_creation_commands"[\s\S]*projects/,
  'pre-contract project creation authorship must never be fabricated by backfill',
)
for (const [model, label] of [
  [workspaceLutVersionModel, 'WorkspaceLutVersion'],
  [workspaceLutStatusCommandModel, 'WorkspaceLutStatusCommand'],
  [workspaceLutDefaultVersionModel, 'WorkspaceLutDefaultVersion'],
]) {
  for (const field of [
    'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
    'actorContextHash', 'actorDelegatedUserId', 'actorDelegatedIdentityId',
    'actorWorkspaceRole',
  ]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `${label} must persist ${field}`)
  }
}
assert.match(
  committed,
  /TRUNCATE TABLE[\s\S]*"workspace_lut_default_versions"[\s\S]*"workspace_lut_versions"[\s\S]*ADD COLUMN "actorCredentialId"[\s\S]*ADD COLUMN "actorContextHash"/,
  'unattributable pre-contract LUT mutations must be reset before audit fields become required',
)
assert.doesNotMatch(
  committed,
  /(?:UPDATE|INSERT INTO) "workspace_lut_(?:versions|status_commands|default_versions)"[\s\S]*(?:api_clients|api_credentials)/,
  'pre-contract LUT actor identity must never be fabricated by backfill',
)
for (const field of [
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash', 'actorDelegatedIdentityId', 'actorWorkspaceRole',
]) {
  assert.match(editCommandModel, new RegExp(`\\b${field}\\b`), `EditCommand must persist ${field}`)
}
assert.match(
  committed,
  /ALTER TABLE "edit_commands"[\s\S]*ADD COLUMN "actorCredentialId"[\s\S]*edit_commands_actor_audit_check/,
  'EditCommand external audit must be stored as one constrained tuple',
)
assert.doesNotMatch(
  committed,
  /(?:UPDATE|INSERT INTO) "edit_commands"[\s\S]*(?:api_clients|api_credentials)/,
  'pre-contract EditCommand actor identity must never be fabricated by backfill',
)
assert.match(
  editCommandActorAuditContractMigration,
  /DROP CONSTRAINT "edit_commands_actor_audit_check"[\s\S]*ADD CONSTRAINT "edit_commands_actor_audit_check"/,
  'the EditCommand audit constraint must be replaced contractually',
)
for (const requiredField of [
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash',
]) {
  assert.match(
    editCommandActorAuditContractMigration,
    new RegExp(`"${requiredField}" IS NOT NULL`),
    `external EditCommand audit must require ${requiredField} explicitly`,
  )
}
assert.doesNotMatch(
  editCommandActorAuditContractMigration,
  /(?:UPDATE|INSERT INTO) "edit_commands"/,
  'the constraint correction must not invent historical EditCommand identity',
)
for (const field of [
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
]) {
  assert.match(
    mediaArtifactLifecycleTransitionModel,
    new RegExp(`\\b${field}\\b`),
    `MediaArtifactLifecycleTransition must persist ${field}`,
  )
}
assert.match(
  committed,
  /DELETE FROM "idempotency_records" AS replay[\s\S]*TRUNCATE TABLE "media_artifact_lifecycle_transitions";[\s\S]*ADD COLUMN "actorCredentialId"[\s\S]*ADD COLUMN "actorContextHash"/,
  'unattributable lifecycle transitions and their replay records must be removed before audit fields become required',
)
for (const field of [
  'action', 'targetClientId', 'targetCredentialId', 'actorClientId',
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  'requestFingerprint', 'occurredAt',
]) {
  assert.match(apiAdministrationCommandModel, new RegExp(`\\b${field}\\b`), `ApiAdministrationCommand must persist ${field}`)
}
for (const field of [
  'action', 'targetType', 'targetId', 'targetStatus', 'endpointId', 'actorClientId',
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  'idempotencyKey', 'baseRevision', 'requestFingerprint', 'occurredAt',
]) {
  assert.match(webhookAdministrationCommandModel, new RegExp(`\\b${field}\\b`), `WebhookAdministrationCommand must persist ${field}`)
}
assert.match(
  committed,
  /ADD COLUMN "endpointId" UUID[\s\S]*'webhook-signing-secret\.provision'[\s\S]*'webhook-signing-secret-rotation\.cancel'/,
  'webhook signing-secret administration must be bound to its endpoint and constrained in SQL',
)
assert.match(
  committed,
  /'webhook-delivery\.replay'[\s\S]*'webhook-event\.replay'[\s\S]*"targetType" = 'webhook-delivery'[\s\S]*"targetType" = 'webhook-event'/,
  'webhook replay administration must constrain delivery and event targets in SQL',
)
assert.match(
  committed,
  /'webhook-endpoint\.challenge'[\s\S]*"action" = 'webhook-endpoint\.challenge' AND "targetStatus" = 'active'/,
  'webhook challenge administration must constrain its convergent activation intent in SQL',
)
assert.match(
  committed,
  /DELETE FROM "idempotency_records"[\s\S]*'api-client\.create'[\s\S]*'api-credential\.rotate'/,
  'pre-contract administrative replays without audit identity must be removed',
)
assert.match(
  committed,
  /DELETE FROM "api_credentials" WHERE "status" = 'revoked'/,
  'pre-contract revoked credentials without immutable commands must be removed',
)
for (const field of [
  'actorCredentialId',
  'actorEnvironment',
  'actorAuthenticationKind',
  'actorContextHash',
  'delegatedIdentityId',
  'workspaceRole',
]) {
  assert.match(apiAccessCommandModel, new RegExp(`\\b${field}\\b`), `ApiAccessCommand must persist ${field}`)
}
assert.match(
  committed,
  /TRUNCATE TABLE "api_access_commands";[\s\S]*ADD COLUMN "actorCredentialId"[\s\S]*ADD COLUMN "actorContextHash"/,
  'unattributable pre-contract access commands must be removed before audit fields become required',
)

for (const [model, label] of [
  [materializationAuthorizationModel, 'MaterializationAuthorization'],
  [publicOperationModel, 'PublicOperation'],
  [longFormIndexWorkflowModel, 'LongFormIndexWorkflow'],
  [sourceCleanupPlanModel, 'SourceCleanupPlan'],
]) {
  for (const field of [
    'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
    'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  ]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `${label} must persist ${field}`)
  }
}
for (const field of [
  'operationId', 'action', 'previousStatus', 'resultStatus', 'actorClientId',
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  'occurredAt',
]) {
  assert.match(
    publicOperationControlCommandModel,
    new RegExp(`\\b${field}\\b`),
    `PublicOperationControlCommand must persist ${field}`,
  )
}
assert.match(
  committed,
  /ALTER TABLE "materialization_authorizations"[\s\S]*ALTER TABLE "public_operations"[\s\S]*ALTER TABLE "long_form_index_workflows"[\s\S]*ALTER TABLE "source_cleanup_plans"[\s\S]*CREATE TABLE "public_operation_control_commands"/,
  'operation-producing families must persist one constrained audit tuple and effective control commands',
)
assert.doesNotMatch(
  operationActorAuditMigration,
  /(?:UPDATE|INSERT INTO) "(?:materialization_authorizations|public_operations|long_form_index_workflows|source_cleanup_plans)"/,
  'pre-contract operation actor identity must never be fabricated by backfill',
)

for (const [model, label] of batchActorAuditModels) {
  for (const field of [
    'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
    'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  ]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `${label} must persist ${field}`)
  }
}
for (const table of [
  'production_batches', 'script_alignment_runs', 'script_alignment_reviews',
  'take_library_runs', 'take_library_selections', 'compatibility_graph_runs',
  'variant_recipe_runs', 'variant_portfolio_preflight_runs',
  'batch_edit_preflight_runs', 'batch_edit_commands', 'production_batch_actions',
]) {
  assert.match(
    batchActorAuditMigration,
    new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?ADD COLUMN "actorCredentialId"[\\s\\S]*?ADD COLUMN "actorContextHash"`),
    `${table} must receive the complete actor audit tuple`,
  )
}
assert.doesNotMatch(
  batchActorAuditMigration,
  /(?:UPDATE|INSERT INTO) "(?:production_batches|script_alignment_runs|script_alignment_reviews|take_library_runs|take_library_selections|compatibility_graph_runs|variant_recipe_runs|variant_portfolio_preflight_runs|batch_edit_preflight_runs|batch_edit_commands|production_batch_actions)"/,
  'pre-contract batch actor identity must never be fabricated by backfill',
)

for (const [model, label] of projectIntelligenceActorAuditModels) {
  for (const field of [
    'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
    'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  ]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `${label} must persist ${field}`)
  }
}
for (const table of [
  'speech_segment_catalog_runs', 'evidence_segments', 'validated_segments',
  'semantic_search_documents', 'retrieval_evaluations',
  'retrieval_scale_evaluations', 'semantic_reuse_runs',
  'source_deconstruction_reports', 'contamination_reports',
]) {
  assert.match(
    projectIntelligenceActorAuditMigration,
    new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?ADD COLUMN "actorCredentialId"[\\s\\S]*?ADD COLUMN "actorContextHash"`),
    `${table} must receive the complete actor audit tuple`,
  )
}
assert.doesNotMatch(
  projectIntelligenceActorAuditMigration,
  /(?:UPDATE|INSERT INTO) "(?:speech_segment_catalog_runs|evidence_segments|validated_segments|semantic_search_documents|retrieval_evaluations|retrieval_scale_evaluations|semantic_reuse_runs|source_deconstruction_reports|contamination_reports)"/,
  'pre-contract project intelligence identity must never be fabricated by backfill',
)
for (const requiredNonNull of [
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash',
]) {
  assert.equal(
    [...projectIntelligenceActorAuditMigration.matchAll(
      new RegExp(`"${requiredNonNull}" IS NOT NULL`, 'g'),
    )].length,
    9,
    `every project intelligence actor audit constraint must require ${requiredNonNull}`,
  )
}

for (const [model, label] of projectEvaluationActorAuditModels) {
  for (const field of [
    'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
    'actorContextHash', 'delegatedUserId', 'delegatedIdentityId', 'workspaceRole',
  ]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `${label} must persist ${field}`)
  }
}
const projectEvaluationActorAuditTables = [
  'color_pipeline_compilations', 'asset_selections', 'quality_iterations',
  'mvp_core_gates', 'proxy_review_decisions', 'contiguous_extractions',
  'validation_envelope_reuses', 'validation_envelope_decisions',
  'proof_need_runs', 'proof_integrity_runs', 'proof_mode_runs',
]
for (const table of projectEvaluationActorAuditTables) {
  assert.match(
    projectEvaluationActorAuditMigration,
    new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?ADD COLUMN "actorCredentialId"[\\s\\S]*?ADD COLUMN "actorContextHash"`),
    `${table} must receive the complete actor audit tuple`,
  )
}
assert.doesNotMatch(
  projectEvaluationActorAuditMigration,
  /(?:UPDATE|INSERT INTO) "(?:color_pipeline_compilations|asset_selections|quality_iterations|mvp_core_gates|proxy_review_decisions|contiguous_extractions|validation_envelope_reuses|validation_envelope_decisions|proof_need_runs|proof_integrity_runs|proof_mode_runs)"/,
  'pre-contract project evaluation identity must never be fabricated by backfill',
)
for (const requiredNonNull of [
  'actorCredentialId', 'actorEnvironment', 'actorAuthenticationKind',
  'actorContextHash',
]) {
  assert.equal(
    [...projectEvaluationActorAuditMigration.matchAll(
      new RegExp(`"${requiredNonNull}" IS NOT NULL`, 'g'),
    )].length,
    11,
    `every project evaluation actor audit constraint must require ${requiredNonNull}`,
  )
}

assertSetContains(
  names(committed, /CREATE TABLE "([^"]+)"/g),
  names(generated, /CREATE TABLE "([^"]+)"/g),
  'tables',
)
assertSetContains(
  names(committed, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g),
  names(generated, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g),
  'indexes',
)
assertSetContains(
  names(committed, /ADD CONSTRAINT "([^"]+)"\s+FOREIGN KEY/g),
  names(generated, /ADD CONSTRAINT "([^"]+)"\s+FOREIGN KEY/g),
  'foreign keys',
)

const requiredChecks = [
  'oidc_authorizations_hashes_check',
  'oidc_authorizations_lifetime_check',
  'workspaces_status_check',
  'api_clients_status_check',
  'api_clients_type_check',
  'api_clients_allowed_environments_json_check',
  'api_clients_scope_grants_json_check',
  'api_clients_created_by_check',
  'api_credentials_status_check',
  'api_credentials_salt_check',
  'api_credentials_hash_check',
  'api_credentials_revocation_check',
  'api_access_commands_actor_environment_check',
  'api_access_commands_actor_authentication_kind_check',
  'api_access_commands_actor_context_hash_check',
  'api_access_commands_delegation_check',
  'api_admin_commands_action_check',
  'api_admin_commands_environment_check',
  'api_admin_commands_authentication_kind_check',
  'api_admin_commands_context_hash_check',
  'api_admin_commands_fingerprint_check',
  'api_admin_commands_idempotency_check',
  'api_admin_commands_delegation_check',
  'webhook_admin_commands_action_check',
  'webhook_admin_commands_target_check',
  'webhook_admin_commands_environment_check',
  'webhook_admin_commands_auth_kind_check',
  'webhook_admin_commands_actor_hash_check',
  'webhook_admin_commands_fingerprint_check',
  'webhook_admin_commands_replay_check',
  'webhook_admin_commands_delegation_check',
  'media_upload_audit_entries_action_check',
  'media_upload_audit_entries_part_check',
  'media_upload_audit_entries_environment_check',
  'media_upload_audit_entries_auth_kind_check',
  'media_upload_audit_entries_hash_check',
  'media_upload_audit_entries_delegation_check',
  'asset_rights_changes_sequence_check',
  'asset_rights_changes_hashes_check',
  'asset_rights_changes_actor_check',
  'project_creation_commands_action_check',
  'project_creation_commands_actor_check',
  'project_creation_commands_hash_check',
  'workspace_lut_versions_actor_audit_check',
  'workspace_lut_status_commands_actor_audit_check',
  'workspace_lut_default_versions_actor_audit_check',
  'projects_status_check',
  'projects_creator_type_check',
  'project_snapshots_kind_check',
  'project_snapshots_hash_check',
  'project_versions_sequence_check',
  'project_versions_hash_check',
  'project_versions_fork_identity_check',
  'idempotency_records_status_check',
  'idempotency_records_fingerprint_check',
  'media_artifacts_hash_check',
  'media_artifacts_size_check',
  'media_artifacts_type_check',
  'media_artifacts_status_check',
  'media_artifact_manifests_schema_check',
  'media_artifact_manifests_hash_check',
  'media_artifact_manifests_parameters_hash_check',
  'media_artifact_lineage_role_check',
  'media_artifact_lineage_ordinal_check',
  'recipe_parameter_payloads_hash_check',
  'recipe_parameter_payloads_ref_check',
  'recipe_parameter_payloads_size_check',
  'recipe_parameter_payloads_cipher_check',
  'render_input_payloads_hash_check',
  'render_input_payloads_ref_check',
  'render_input_payloads_size_check',
  'render_input_payloads_cipher_check',
  'media_artifact_manifests_render_input_check',
  'media_artifact_manifests_recipe_parameters_check',
  'media_artifacts_rights_revision_check',
  'asset_rights_snapshots_sequence_check',
  'asset_rights_snapshots_schema_check',
  'asset_rights_snapshots_hash_check',
  'asset_rights_snapshots_status_check',
  'asset_rights_snapshots_consent_status_check',
  'asset_rights_snapshots_creator_type_check',
  'asset_rights_snapshots_json_check',
  'materialization_authorizations_hash_check',
  'materialization_authorizations_status_check',
  'materialization_authorizations_validity_check',
  'materialization_authorizations_json_check',
  'materialization_authorizations_actor_audit_check',
  'asset_use_decisions_ordinal_check',
  'asset_use_decisions_kind_check',
  'asset_use_decisions_outcome_check',
  'asset_use_decisions_validity_check',
  'asset_use_decisions_reasons_check',
  'public_operations_type_check',
  'public_operations_status_check',
  'public_operations_phase_check',
  'public_operations_target_check',
  'public_operations_progress_check',
  'public_operations_attempt_check',
  'public_operations_fingerprint_check',
  'public_operations_result_check',
  'public_operations_error_check',
  'public_operations_state_check',
  'public_operations_dates_check',
  'public_operations_lease_check',
  'public_operations_actor_audit_check',
  'public_operation_control_commands_action_check',
  'public_operation_control_commands_actor_audit_check',
  'artifact_render_operations_hash_check',
  'artifact_render_operations_output_check',
  'public_operations_retry_schedule_check',
  'public_event_outbox_type_check',
  'public_event_outbox_version_check',
  'public_event_outbox_sequence_check',
  'public_event_outbox_actor_check',
  'public_event_outbox_resource_check',
  'public_event_outbox_data_check',
  'public_event_outbox_dates_check',
  'webhook_endpoints_status_check',
  'webhook_endpoints_url_check',
  'webhook_endpoints_state_check',
  'webhook_signing_secrets_version_check',
  'webhook_signing_secrets_algorithm_check',
  'webhook_signing_secrets_reference_check',
  'webhook_signing_secrets_status_check',
  'webhook_signing_secrets_state_check',
  'webhook_signing_secret_payloads_version_check',
  'webhook_signing_secret_payloads_algorithm_check',
  'webhook_signing_secret_payloads_key_check',
  'webhook_signing_secret_payloads_nonce_check',
  'webhook_signing_secret_payloads_ciphertext_check',
  'webhook_signing_secret_payloads_auth_tag_check',
  'webhook_subscriptions_status_check',
  'webhook_subscriptions_filter_check',
  'webhook_subscriptions_state_check',
  'webhook_deliveries_status_check',
  'webhook_deliveries_attempt_check',
  'webhook_deliveries_state_check',
  'webhook_deliveries_lease_check',
  'webhook_delivery_attempts_number_check',
  'webhook_delivery_attempts_status_check',
  'webhook_delivery_attempts_response_check',
  'webhook_delivery_attempts_state_check',
  'webhook_delivery_attempts_dates_check',
  'webhook_verification_challenges_hash_check',
  'webhook_verification_challenges_status_check',
  'webhook_verification_challenges_attempt_check',
  'webhook_verification_challenges_dates_check',
  'webhook_verification_challenges_state_check',
  'webhook_endpoint_activation_leases_token_check',
  'webhook_endpoint_activation_leases_dates_check',
  'webhook_replay_receipts_dates_check',
  'webhook_worker_shard_leases_coordinates_check',
  'webhook_worker_shard_leases_identity_check',
  'webhook_worker_shard_leases_token_check',
  'webhook_worker_shard_leases_dates_check',
  'edit_commands_type_check',
  'edit_commands_actor_type_check',
  'edit_commands_actor_audit_check',
  'edit_commands_base_hash_check',
  'edit_commands_request_fingerprint_check',
  'project_proxy_render_operations_hash_check',
  'review_annotations_proxy_hash_check',
  'review_annotations_request_fingerprint_check',
  'review_annotations_frame_time_check',
  'review_annotations_scope_check',
  'review_annotations_status_check',
  'review_annotations_author_check',
  'review_annotations_region_check',
  'review_annotations_affected_count_check',
  'review_annotations_application_scope_json_check',
  'render_element_maps_hash_check',
  'render_element_maps_schema_check',
  'render_element_maps_dimensions_check',
  'render_element_maps_elements_json_check',
  'quality_iterations_hashes_check',
  'quality_iterations_sequence_check',
  'quality_iterations_score_check',
  'quality_iterations_json_bounds_check',
  'quality_iterations_decision_check',
  'quality_iterations_creator_check',
  'quality_iterations_idempotency_check',
  'quality_iteration_asset_selections_hash_check',
  'quality_iteration_asset_selections_ordinal_check',
  'mvp_core_gates_project_identity_check',
  'mvp_core_gates_hashes_check',
  'mvp_core_gates_result_check',
  'mvp_core_gates_report_bounds_check',
  'mvp_core_gates_actor_check',
  'hierarchical_processing_runs_hashes_check',
  'hierarchical_processing_runs_policy_check',
  'hierarchical_processing_runs_bounds_check',
  'hierarchical_processing_runs_previous_check',
  'hierarchical_processing_runs_rights_check',
  'hierarchical_processing_runs_json_check',
  'hierarchical_processing_chunks_range_check',
  'hierarchical_processing_chunks_hash_json_check',
  'hierarchical_tier_executions_tier_check',
  'hierarchical_tier_executions_status_check',
  'hierarchical_tier_executions_bounds_check',
  'production_batches_version_check',
  'production_batches_status_check',
  'production_batches_bounds_check',
  'production_batches_hash_check',
  'production_batches_json_check',
  'production_batch_items_state_check',
  'production_batch_items_bounds_check',
  'production_batch_items_error_check',
  'production_batch_steps_identity_check',
  'production_batch_steps_state_check',
  'production_batch_steps_bounds_check',
  'production_batch_steps_error_check',
  'production_batch_item_artifacts_sequence_check',
  'production_batch_actions_scope_check',
  'production_batch_actions_bounds_check',
  'production_batches_actor_audit_check',
  'production_batch_actions_actor_audit_check',
  'script_alignment_runs_schema_check',
  'script_alignment_runs_status_check',
  'script_alignment_runs_revision_check',
  'script_alignment_runs_hash_check',
  'script_alignment_runs_counts_check',
  'script_alignment_runs_json_check',
  'script_alignment_runs_dates_check',
  'script_alignment_reviews_revision_check',
  'script_alignment_reviews_hash_check',
  'script_alignment_reviews_json_check',
  'script_alignment_runs_actor_audit_check',
  'script_alignment_reviews_actor_audit_check',
  'take_library_runs_versions_check',
  'take_library_runs_status_check',
  'take_library_runs_counts_check',
  'take_library_runs_hashes_check',
  'take_library_runs_json_check',
  'take_library_selections_revision_check',
  'take_library_selections_hashes_check',
  'take_library_selections_json_check',
  'take_library_runs_actor_audit_check',
  'take_library_selections_actor_audit_check',
  'compatibility_graph_runs_versions_check',
  'compatibility_graph_runs_thresholds_check',
  'compatibility_graph_runs_counts_check',
  'compatibility_graph_runs_hashes_check',
  'compatibility_graph_runs_json_check',
  'compatibility_graph_runs_actor_audit_check',
  'compatibility_graph_nodes_role_check',
  'compatibility_graph_nodes_hashes_check',
  'compatibility_graph_nodes_json_check',
  'compatibility_graph_edges_relation_check',
  'compatibility_graph_edges_decision_check',
  'compatibility_graph_edges_score_check',
  'compatibility_graph_edges_hash_check',
  'compatibility_graph_edges_json_check',
  'variant_recipe_runs_versions_check',
  'variant_recipe_runs_status_check',
  'variant_recipe_runs_counts_check',
  'variant_recipe_runs_scores_check',
  'variant_recipe_runs_hashes_check',
  'variant_recipe_runs_json_check',
  'variant_recipe_runs_actor_audit_check',
  'variant_recipe_lineage_sequence_check',
  'variant_recipe_lineage_usage_check',
  'variant_recipe_lineage_role_check',
  'variant_recipe_lineage_range_check',
  'variant_recipe_lineage_hashes_check',
  'variant_recipe_lineage_json_check',
  'variant_portfolio_preflight_runs_actor_audit_check',
  'batch_edit_preflights_actor_audit_check',
  'batch_edit_commands_actor_audit_check',
  'speech_segment_catalog_runs_actor_audit_check',
  'evidence_segments_actor_audit_check',
  'validated_segments_actor_audit_check',
  'semantic_search_documents_actor_audit_check',
  'retrieval_evaluations_actor_audit_check',
  'retrieval_scale_evaluations_actor_audit_check',
  'semantic_reuse_runs_actor_audit_check',
  'source_deconstruction_reports_actor_audit_check',
  'contamination_reports_actor_audit_check',
  'color_pipeline_compilations_actor_audit_check',
  'asset_selections_actor_audit_check',
  'quality_iterations_actor_audit_check',
  'mvp_core_gates_actor_audit_check',
  'proxy_review_decisions_actor_audit_check',
  'contiguous_extractions_actor_audit_check',
  'validation_envelope_reuses_actor_audit_check',
  'validation_envelope_decisions_actor_audit_check',
  'proof_need_runs_actor_audit_check',
  'proof_integrity_runs_actor_audit_check',
  'proof_mode_runs_actor_audit_check',
  'contamination_reports_version_check',
  'contamination_reports_decision_check',
  'contamination_reports_counts_check',
  'contamination_reports_text_check',
  'contamination_reports_hash_check',
  'contamination_observations_kind_check',
  'contamination_observations_range_check',
  'contamination_observations_region_check',
  'contamination_observations_text_check',
  'contamination_observations_hash_check',
  'contamination_protected_regions_kind_check',
  'contamination_protected_regions_range_check',
  'contamination_protected_regions_region_check',
  'contamination_protected_regions_hash_check',
  'contamination_findings_kind_check',
  'contamination_findings_range_check',
  'contamination_findings_region_check',
  'contamination_findings_impact_check',
  'contamination_findings_json_check',
  'contamination_findings_hash_check',
  'contamination_overlaps_pair_check',
  'contamination_overlaps_region_check',
  'contamination_overlaps_hash_check',
  'long_form_index_workflows_actor_audit_check',
  'source_cleanup_plans_actor_audit_check',
]
for (const constraint of requiredChecks) {
  assert.match(committed, new RegExp(`CONSTRAINT "${constraint}"`))
}

console.log(
  `V2 migration verified: ${names(generated, /CREATE TABLE "([^"]+)"/g).size} tables, ` +
    `${names(generated, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g).size} indexes, ` +
    `${names(generated, /ADD CONSTRAINT "([^"]+)"\s+FOREIGN KEY/g).size} foreign keys`,
)
