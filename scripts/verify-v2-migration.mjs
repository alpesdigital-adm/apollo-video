import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))
const schemaPath = 'prisma/v2/schema.prisma'
const migrationsPath = 'prisma/v2/migrations'
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

assert.match(
  committed,
  /DROP CONSTRAINT "artifact_render_operations_output_check"[\s\S]*"outputKey" ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._\/-\]\*\\\.mp4\$'/,
  'the output-key check must use a PostgreSQL-compatible unbounded repetition plus length guard',
)

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
  'workspaces_status_check',
  'api_clients_status_check',
  'api_clients_environment_check',
  'api_credentials_status_check',
  'api_credentials_hash_check',
  'api_credentials_revocation_check',
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
  'take_library_runs_versions_check',
  'take_library_runs_status_check',
  'take_library_runs_counts_check',
  'take_library_runs_hashes_check',
  'take_library_runs_json_check',
  'take_library_selections_revision_check',
  'take_library_selections_hashes_check',
  'take_library_selections_json_check',
]
for (const constraint of requiredChecks) {
  assert.match(committed, new RegExp(`CONSTRAINT "${constraint}"`))
}

console.log(
  `V2 migration verified: ${names(generated, /CREATE TABLE "([^"]+)"/g).size} tables, ` +
    `${names(generated, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g).size} indexes, ` +
    `${names(generated, /ADD CONSTRAINT "([^"]+)"\s+FOREIGN KEY/g).size} foreign keys`,
)
