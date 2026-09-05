import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ANCHOR_ORIGINS, DIAGNOSTIC_STATUSES } from '../../src/v2/domain/sync-diagnostic.ts'
import { CAPTURE_TRACK_ROLES } from '../../src/v2/domain/capture-session.ts'
import { COVERAGE_AVAILABILITIES } from '../../src/v2/domain/track-coverage.ts'
import {
  ANGLE_CONTEXTS,
  ANGLE_SCORE_COMPONENT_NAMES,
  DEFAULT_DIRECTION_POLICY,
  DIRECTION_CONFIDENCE_BANDS,
  DIRECTION_CONFIDENCE_BAND_FLOORS,
  DIRECTION_RULES,
  OUTPUT_ASPECT_RATIOS,
  SHOT_EVIDENCE_REF_CAP,
  SPATIAL_RELATIONS,
} from '../../src/v2/domain/multicam-direction.ts'
import {
  EVIDENCE_EVALUATOR_KINDS,
  MULTICAM_EVIDENCE_KINDS,
} from '../../src/v2/domain/multicam-evidence.ts'
import {
  COLOR_EVALUATOR_KINDS,
  COLOR_MEASUREMENT_DIMENSIONS,
  COLOR_MEASUREMENT_MINIMUM_FRAMES,
  COLOR_MEASUREMENT_STATUSES,
  COLOR_MEASUREMENT_UNITS,
  HDR_MODES,
} from '../../src/v2/domain/color-measurement.ts'
import {
  MATCH_ACTOR_KINDS,
  MATCH_PARAMETER_BOUNDS,
  MATCH_PIPELINE_STAGE,
  MATCH_PROVIDER,
  MATCH_PROVIDER_VERSIONS,
} from '../../src/v2/domain/multicam-match-plan.ts'
import {
  COLOR_CRITIC_ACROSS_STAGES,
  COLOR_CRITIC_ACTIONS,
  COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE,
  COLOR_CRITIC_CAUSES,
  COLOR_CRITIC_CAUSE_ACTIONS,
  COLOR_CRITIC_CLASSIFICATIONS,
  COLOR_CRITIC_CONFIDENCE_BANDS,
  COLOR_CRITIC_DIMENSIONS,
  COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
  COLOR_CRITIC_SEVERITIES,
  COLOR_CRITIC_STAGES,
  COLOR_CRITIC_STATUSES,
  COLOR_CRITIC_SUBJECT_KINDS,
} from '../../src/v2/domain/color-critic-report.ts'
import {
  NO_REFERENCE_PLAYBACK_MODES,
  PLAYBACK_ANCHOR_NOTE_MAX,
  PLAYBACK_DETECTION_METHODS,
  PLAYBACK_DIRECTIONS,
  PLAYBACK_DISCONTINUITY_REASONS,
  PLAYBACK_MAP_STATUSES,
  PLAYBACK_MODES,
  PLAYBACK_UNCOVERED_REASONS,
} from '../../src/v2/domain/playback-map.ts'

/**
 * The Wave 20 migration against the domain constants it claims to encode.
 *
 * There is no PostgreSQL on the machine this was written on, so the CHECK
 * bodies are first parsed by a database in CI. That leaves one failure mode
 * entirely unguarded until then, and it is the one Wave 19 actually hit: a
 * value set typed from memory. Every `IN (...)` list below is compared against
 * the frozen array the domain exports, in both directions — a missing value
 * would refuse a legitimate row for as long as nobody tried it, and an extra
 * one would accept a row no constructor can produce.
 *
 * The same treatment is given to the numbers: band floors, parameter bounds,
 * the minimum sampled frames, the evidence-ref cap and the correction budget
 * are all read out of the SQL and compared with the constant, because a CHECK
 * that says 0.8 where the domain says 0.85 is a constraint that agrees with
 * nothing.
 */

const MIGRATION_DIR = 'prisma/v2/migrations/20260905090000_multicam_direction_color_playback'
const root = fileURLToPath(new URL('../../', import.meta.url))
const sql = readFileSync(`${root}${MIGRATION_DIR}/migration.sql`, 'utf8')
const commandMigration = readFileSync(
  `${root}prisma/v2/migrations/20260905093000_direct_multicam_session_command/migration.sql`,
  'utf8',
)
// The third Wave 20 migration. It was read by nothing here until a reviewer
// pointed out that the ordinal columns — the only thing standing between a
// stored aggregate and an unreadable one — had no structural guard at all.
const rehydration = readFileSync(
  `${root}prisma/v2/migrations/20260905120000_wave20_aggregate_rehydration/migration.sql`,
  'utf8',
)
const schema = readFileSync(`${root}prisma/v2/schema.prisma`, 'utf8')

const TABLES = Object.freeze([
  'multicam_evidence_sets', 'multicam_observations', 'multicam_directions',
  'multicam_direction_heads', 'multicam_shot_decisions', 'multicam_shot_alternatives',
  'multicam_angle_candidates', 'multicam_angle_score_components',
  'camera_color_measurements', 'color_measurement_dimensions', 'color_measurement_components',
  'multicam_match_plans', 'multicam_match_plan_heads', 'match_plan_measurements',
  'camera_match_transforms', 'match_range_overrides', 'match_non_comparable_ranges',
  'match_plan_issues',
  'color_critic_reports', 'color_critic_dimension_results', 'color_critic_issues',
  'color_critic_proposed_deltas',
  'playback_maps', 'playback_map_heads', 'playback_pieces', 'playback_anchors',
  'playback_uncovered_ranges',
])

/** The body of one named CHECK, with its parentheses balanced. */
function checkBody(constraint, text = sql) {
  const anchor = text.indexOf(`CONSTRAINT "${constraint}"`)
  assert.notEqual(anchor, -1, `${constraint} is not declared by the migration`)
  const open = text.indexOf('CHECK (', anchor) + 'CHECK ('.length
  let depth = 1
  let cursor = open
  while (depth > 0) {
    const char = text[cursor]
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    cursor += 1
  }
  return text.slice(open, cursor - 1)
}

/** The literals of `"<column>" IN (...)` inside a CHECK, in source order. */
function inList(constraint, column, text = sql) {
  const body = checkBody(constraint, text)
  const match = new RegExp(`"${column}" IN\\s*\\(`).exec(body)
  assert.notEqual(match, null, `${constraint} does not constrain ${column} to a set`)
  const open = match.index + match[0].length
  let depth = 1
  let cursor = open
  while (depth > 0) {
    const char = body[cursor]
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    cursor += 1
  }
  return [...body.slice(open, cursor - 1).matchAll(/'([^']*)'/g)].map((match) => match[1])
}

function assertSet(constraint, column, expected, label, text = sql) {
  const actual = inList(constraint, column, text)
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `${constraint}.${column} must be exactly ${label}`,
  )
  assert.equal(new Set(actual).size, actual.length, `${constraint}.${column} repeats a value`)
}

test('T-F4.012 the direction constraints spell the direction vocabulary', () => {
  assertSet('multicam_observations_kind_check', 'kind', MULTICAM_EVIDENCE_KINDS, 'MULTICAM_EVIDENCE_KINDS')
  assertSet('multicam_observations_evaluator_check', 'evaluatorKind', EVIDENCE_EVALUATOR_KINDS, 'EVIDENCE_EVALUATOR_KINDS')
  assertSet('multicam_directions_format_check', 'aspectRatio', OUTPUT_ASPECT_RATIOS, 'OUTPUT_ASPECT_RATIOS')
  assertSet('multicam_shot_decisions_rule_check', 'rule', DIRECTION_RULES, 'DIRECTION_RULES')
  assertSet('multicam_angle_candidates_role_check', 'role', CAPTURE_TRACK_ROLES, 'CAPTURE_TRACK_ROLES')
  assertSet('multicam_angle_candidates_role_check', 'context', ANGLE_CONTEXTS, 'ANGLE_CONTEXTS')
  assertSet('multicam_angle_candidates_continuity_check', 'spatialRelation', SPATIAL_RELATIONS, 'SPATIAL_RELATIONS')
  assertSet('multicam_angle_score_components_name_check', 'name', ANGLE_SCORE_COMPONENT_NAMES, 'ANGLE_SCORE_COMPONENT_NAMES')

  // Two vocabularies the direction widens on purpose: a candidate's coverage
  // can be outside the measured bounds or never measured at all, and its sync
  // status can be "it is the reference". Both are states TrackCoverage and
  // SyncDiagnostic do not have, so the SQL set is the domain set plus exactly
  // those, never plus something else.
  assertSet(
    'multicam_angle_candidates_coverage_check', 'coverageAvailability',
    [...COVERAGE_AVAILABILITIES, 'out-of-bounds', 'unmeasured'],
    'COVERAGE_AVAILABILITIES plus out-of-bounds and unmeasured',
  )
  assertSet(
    'multicam_angle_candidates_sync_check', 'syncStatus',
    [...DIAGNOSTIC_STATUSES, 'reference'],
    'DIAGNOSTIC_STATUSES plus reference',
  )

  // The seven weighted parts of a score are the policy's own weight keys.
  for (const weight of Object.keys(DEFAULT_DIRECTION_POLICY.weights)) {
    assert.ok(
      ANGLE_SCORE_COMPONENT_NAMES.includes(weight),
      `${weight} is a policy weight with no persisted score component`,
    )
  }
})

test('T-F4.012 the direction constraints carry the direction numbers', () => {
  const band = checkBody('multicam_shot_decisions_confidence_check')
  for (const [name, floor] of Object.entries(DIRECTION_CONFIDENCE_BAND_FLOORS)) {
    assert.match(
      band,
      new RegExp(`WHEN "confidence" >= ${floor} THEN '${name}'`),
      `the band CASE must place ${name} at ${floor}`,
    )
  }
  assert.deepEqual(
    [...band.matchAll(/THEN '([a-z]+)'|ELSE '([a-z]+)'/g)].map((match) => match[1] ?? match[2]),
    [...DIRECTION_CONFIDENCE_BANDS],
    'the band CASE must produce DIRECTION_CONFIDENCE_BANDS in order',
  )

  const evidence = checkBody('multicam_shot_decisions_evidence_check')
  assert.match(evidence, new RegExp(`BETWEEN 1 AND ${SHOT_EVIDENCE_REF_CAP}\\b`))
  assert.match(evidence, new RegExp(`"evidenceRefCount" = ${SHOT_EVIDENCE_REF_CAP}\\b`))

  // The derived flags: each is stored beside the equality that recomputes it.
  assert.match(
    checkBody('multicam_directions_manual_review_check'),
    /"manualReviewRequired" = \("warningCount" > 0 OR "uncoveredCount" > 0 OR "lowConfidenceShotCount" > 0\)/,
  )
  // And the flag that is NOT stored beside an equality, because no row this
  // schema can hold could break it: multicam_angle_candidates keeps the angle
  // each shot chose, the domain refuses to choose an ineligible one, so
  // `eligible`/`rejectionCount`/`rejectionReasonsJson` had exactly one value
  // apiece and their CHECK could never fail. A rejected angle is inspectable as
  // a multicam_shot_alternatives row, which is where the reason lives.
  for (const gone of ['"eligible"', '"rejectionCount"', '"rejectionReasonsJson"']) {
    assert.equal(
      sql.includes(gone),
      false,
      `${gone} cannot hold two values in this schema; a column that can hold one is not a fact`,
    )
  }
  assert.equal(sql.includes('multicam_angle_candidates_eligible_check'), false)
  assert.match(
    checkBody('multicam_shot_alternatives_reason_check'),
    /char_length\(btrim\("rejectedBecause"\)\) >= 1/,
    'the losing angle must say why it lost',
  )
})

test('T-F4.013 the colour constraints spell the measurement and match vocabularies', () => {
  assertSet('camera_color_measurements_technical_check', 'hdrMode', HDR_MODES, 'HDR_MODES')
  assertSet('color_measurement_dimensions_dimension_check', 'dimension', COLOR_MEASUREMENT_DIMENSIONS, 'COLOR_MEASUREMENT_DIMENSIONS')
  assertSet('color_measurement_dimensions_dimension_check', 'status', COLOR_MEASUREMENT_STATUSES, 'COLOR_MEASUREMENT_STATUSES')
  assertSet('color_measurement_dimensions_dimension_check', 'evaluatorKind', COLOR_EVALUATOR_KINDS, 'COLOR_EVALUATOR_KINDS')
  assertSet('multicam_match_plans_actor_check', 'selectedByKind', MATCH_ACTOR_KINDS, 'MATCH_ACTOR_KINDS')
  assertSet('match_range_overrides_provider_check', 'actorKind', MATCH_ACTOR_KINDS, 'MATCH_ACTOR_KINDS')
  for (const constraint of ['camera_match_transforms_provider_check', 'match_range_overrides_provider_check']) {
    assertSet(constraint, 'providerVersion', Object.keys(MATCH_PROVIDER_VERSIONS), 'MATCH_PROVIDER_VERSIONS')
    assert.match(checkBody(constraint), new RegExp(`"provider" = '${MATCH_PROVIDER}'`))
  }

  // The unit of a dimension is fixed by COLOR_MEASUREMENT_UNITS; the CASE is
  // that table and nothing else.
  const unit = checkBody('color_measurement_dimensions_unit_check')
  for (const [dimension, expected] of Object.entries(COLOR_MEASUREMENT_UNITS)) {
    assert.match(unit, new RegExp(`WHEN '${dimension}' THEN '${expected}'`), `${dimension} must be reported in ${expected}`)
  }
  assert.equal(
    [...unit.matchAll(/WHEN '([A-Za-z]+)' THEN/g)].length,
    COLOR_MEASUREMENT_DIMENSIONS.length,
    'the unit CASE must answer for every dimension and no others',
  )

  assert.match(
    checkBody('camera_color_measurements_sampling_check'),
    new RegExp(`"sampledFrames" >= ${COLOR_MEASUREMENT_MINIMUM_FRAMES}\\b`),
  )
  assert.match(checkBody('multicam_match_plans_stage_check'), new RegExp(`"pipelineStage" = '${MATCH_PIPELINE_STAGE}'`))
  assert.match(checkBody('multicam_match_plans_review_check'), /"humanReviewRequired" = \("reviewIssueCount" > 0\)/)

  const bounds = checkBody('camera_match_transforms_bounds_check')
  for (const [parameter, [low, high]] of Object.entries(MATCH_PARAMETER_BOUNDS)) {
    const columns = parameter === 'gain' ? ['redGain', 'greenGain', 'blueGain'] : [parameter]
    for (const column of columns) {
      assert.match(
        bounds,
        new RegExp(`"${column}" >= ${low} AND "${column}" <= ${high}`),
        `${column} must be bounded by MATCH_PARAMETER_BOUNDS.${parameter}`,
      )
    }
  }
})

test('T-F4.014 the critic constraints are the cause table, not a paraphrase of it', () => {
  assertSet('color_critic_reports_subject_check', 'subjectKind', COLOR_CRITIC_SUBJECT_KINDS, 'COLOR_CRITIC_SUBJECT_KINDS')
  for (const constraint of ['color_critic_dimension_results_dimension_check', 'color_critic_issues_vocabulary_check']) {
    assertSet(constraint, 'dimension', COLOR_CRITIC_DIMENSIONS, 'COLOR_CRITIC_DIMENSIONS')
    assertSet(constraint, 'stage', [...COLOR_CRITIC_STAGES, COLOR_CRITIC_ACROSS_STAGES], 'COLOR_CRITIC_STAGES plus across-output-transform')
    assertSet(constraint, 'classification', COLOR_CRITIC_CLASSIFICATIONS, 'COLOR_CRITIC_CLASSIFICATIONS')
  }
  assertSet('color_critic_dimension_results_dimension_check', 'status', COLOR_CRITIC_STATUSES, 'COLOR_CRITIC_STATUSES')
  assertSet('color_critic_issues_vocabulary_check', 'severity', COLOR_CRITIC_SEVERITIES, 'COLOR_CRITIC_SEVERITIES')
  assertSet('color_critic_issues_vocabulary_check', 'cause', COLOR_CRITIC_CAUSES, 'COLOR_CRITIC_CAUSES')

  // ADR-147: the action is looked up from the cause. The CASE is that lookup —
  // but only for a cause the CASE lists. A CASE with no ELSE returns NULL for
  // anything else, `action = NULL` is unknown, and an unknown CHECK is a
  // satisfied CHECK: ('not-a-real-cause', 'banana') was accepted. Both
  // vocabularies are closed first, so the lookup is reachable for every row
  // that gets past them.
  assertSet('color_critic_reports_cause_action_check', 'cause', COLOR_CRITIC_CAUSES, 'COLOR_CRITIC_CAUSES')
  assertSet('color_critic_reports_cause_action_check', 'action', COLOR_CRITIC_ACTIONS, 'COLOR_CRITIC_ACTIONS')
  const causeAction = checkBody('color_critic_reports_cause_action_check')
  for (const [cause, action] of Object.entries(COLOR_CRITIC_CAUSE_ACTIONS)) {
    assert.match(causeAction, new RegExp(`WHEN '${cause}' THEN '${action}'`), `${cause} must map to ${action}`)
  }
  assert.equal(
    [...causeAction.matchAll(/WHEN '([a-z-]+)' THEN/g)].length,
    COLOR_CRITIC_CAUSES.length,
    'the cause CASE must answer for every cause and no others',
  )
  assert.doesNotMatch(
    causeAction,
    /ELSE/,
    'an ELSE would give an unmapped cause a default action; the closed cause set is what refuses one',
  )

  const coverage = checkBody('color_critic_reports_coverage_check')
  assert.match(coverage, new RegExp(`"sectionCount" = ${COLOR_CRITIC_STAGES.length}\\b`))
  assert.match(coverage, new RegExp(`"dimensionCount" = ${COLOR_CRITIC_DIMENSIONS.length}\\b`))

  const correction = checkBody('color_critic_reports_correction_check')
  assert.match(correction, new RegExp(`BETWEEN 1 AND ${COLOR_CRITIC_MAX_CORRECTION_ITERATIONS}\\b`))
  assert.match(correction, new RegExp(`"correctionMaxIterations" = ${COLOR_CRITIC_MAX_CORRECTION_ITERATIONS}\\b`))
  assert.match(correction, new RegExp(`"confidence" >= ${COLOR_CRITIC_BOUNDED_CORRECTION_MINIMUM_CONFIDENCE}\\b`))

  const bands = checkBody('color_critic_reports_confidence_check')
  for (const { band, minimum } of COLOR_CRITIC_CONFIDENCE_BANDS) {
    if (minimum === 0) {
      assert.match(bands, new RegExp(`ELSE '${band}'`))
      continue
    }
    assert.match(bands, new RegExp(`WHEN "confidence" >= ${minimum} THEN '${band}'`))
  }
})

test('T-F4.015 the playback constraints spell the playback vocabulary', () => {
  assertSet('playback_pieces_vocabulary_check', 'mode', PLAYBACK_MODES, 'PLAYBACK_MODES')
  assertSet('playback_pieces_vocabulary_check', 'direction', PLAYBACK_DIRECTIONS, 'PLAYBACK_DIRECTIONS')
  assertSet('playback_pieces_vocabulary_check', 'detectionMethod', PLAYBACK_DETECTION_METHODS, 'PLAYBACK_DETECTION_METHODS')
  assertSet('playback_pieces_vocabulary_check', 'discontinuityReason', PLAYBACK_DISCONTINUITY_REASONS, 'PLAYBACK_DISCONTINUITY_REASONS')
  assertSet('playback_uncovered_ranges_reason_check', 'reason', PLAYBACK_UNCOVERED_REASONS, 'PLAYBACK_UNCOVERED_REASONS')
  assertSet('playback_anchors_vocabulary_check', 'origin', ANCHOR_ORIGINS, 'ANCHOR_ORIGINS')
  assertSet('playback_anchors_vocabulary_check', 'method', PLAYBACK_DETECTION_METHODS, 'PLAYBACK_DETECTION_METHODS')
  assertSet('playback_anchors_vocabulary_check', 'mode', PLAYBACK_MODES, 'PLAYBACK_MODES')
  assertSet('playback_map_heads_version_check', 'status', PLAYBACK_MAP_STATUSES, 'PLAYBACK_MAP_STATUSES')

  // The modes during which the reference produces no time appear twice — in
  // the piece's nullability rule and in the anchor's — and both must be the
  // set, not a subset of it.
  const noReference = [...NO_REFERENCE_PLAYBACK_MODES].sort()
  for (const constraint of ['playback_pieces_reference_check', 'playback_anchors_reference_check']) {
    const modes = inList(constraint, 'mode')
    assert.deepEqual([...new Set(modes)].sort(), noReference, `${constraint} must name NO_REFERENCE_PLAYBACK_MODES`)
  }

  // The status of a map is derived, and the CASE is the derivation.
  const status = checkBody('playback_maps_status_check')
  assert.match(status, /WHEN "referencedPieceCount" = 0 THEN 'failed'/)
  assert.match(status, /WHEN "uncoveredCount" > 0 THEN 'needs-input'/)
  assert.match(status, /ELSE 'resolved'/)
  assert.deepEqual(
    [...new Set([...status.matchAll(/THEN '([a-z-]+)'|ELSE '([a-z-]+)'/g)].map((m) => m[1] ?? m[2]))].sort(),
    [...PLAYBACK_MAP_STATUSES].sort(),
  )

  // A rate is a measured slope: only the two methods that measure one may
  // carry it.
  const rate = checkBody('playback_pieces_rate_check')
  assert.deepEqual(inList('playback_pieces_rate_check', 'detectionMethod').sort(), ['audio-fingerprint', 'ocr-timestamp'])
  assert.match(rate, /"rateNum" > 0 AND "rateDen" > 0/)

  // CONTRACT §2: the evidence of a manual anchor is the actor plus the note,
  // in the exact shape anchorEvidenceRef writes.
  assert.match(
    checkBody('playback_anchors_actor_check'),
    /"evidenceRef" = 'operator:' \|\| "actorId" \|\|/,
  )
})

test('T-F4.012 every Wave 20 table is workspace-scoped, keyed and cascade-bound', () => {
  assert.equal([...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].length, TABLES.length)
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}" \\(`), `${table} is missing`)
    assert.match(sql, new RegExp(`CONSTRAINT "${table}_pkey" PRIMARY KEY \\("id"\\)`), `${table} has no primary key`)
    assert.match(
      sql,
      new RegExp(`CREATE UNIQUE INDEX "${table}_id_workspaceId_key" ON "${table}"\\("id", "workspaceId"\\)`),
      `${table} has no composite identity for other tables to point at`,
    )
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_workspaceId_fkey" FOREIGN KEY \\("workspaceId"\\) REFERENCES "workspaces"\\("id"\\) ON DELETE RESTRICT`),
      `${table} must refuse to have its workspace deleted out from under it`,
    )
    assert.match(schema, new RegExp(`@@map\\("${table}"\\)`), `${table} has no Prisma model`)
  }

  // Every foreign key is a trailing ALTER: the validator counts them with a
  // regex that cannot see an inline REFERENCES, so an inline one would be a
  // constraint no gate knows about.
  const creates = [...sql.matchAll(/CREATE TABLE "[^"]+" \([\s\S]*?\n\);/g)].map((match) => match[0])
  assert.equal(creates.length, TABLES.length)
  for (const create of creates) {
    assert.doesNotMatch(create, /\bREFERENCES\b/, 'foreign keys belong in a trailing ALTER TABLE')
  }
  assert.equal([...sql.matchAll(/ADD CONSTRAINT "[^"]+"\s+FOREIGN KEY/g)].length, 58)

  // Children cascade from the aggregate they belong to; nothing cascades from
  // a workspace.
  for (const [child, parent] of [
    ['multicam_observations', 'multicam_evidence_sets'],
    ['multicam_shot_decisions', 'multicam_directions'],
    ['multicam_shot_alternatives', 'multicam_shot_decisions'],
    ['multicam_angle_candidates', 'multicam_shot_decisions'],
    ['multicam_angle_score_components', 'multicam_angle_candidates'],
    ['color_measurement_dimensions', 'camera_color_measurements'],
    ['color_measurement_components', 'color_measurement_dimensions'],
    ['camera_match_transforms', 'multicam_match_plans'],
    ['match_range_overrides', 'multicam_match_plans'],
    ['match_non_comparable_ranges', 'multicam_match_plans'],
    ['match_plan_issues', 'multicam_match_plans'],
    ['color_critic_dimension_results', 'color_critic_reports'],
    ['color_critic_issues', 'color_critic_reports'],
    ['color_critic_proposed_deltas', 'color_critic_reports'],
    ['playback_pieces', 'playback_maps'],
    ['playback_anchors', 'playback_maps'],
    ['playback_uncovered_ranges', 'playback_maps'],
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${child}" ADD CONSTRAINT "${child}_\\w+_workspaceId_fkey" FOREIGN KEY \\("\\w+", "workspaceId"\\) REFERENCES "${parent}"\\("id", "workspaceId"\\) ON DELETE CASCADE`),
      `${child} must cascade from ${parent}`,
    )
  }

  // A measurement is cited by plans, so a plan may not delete it.
  assert.match(
    sql,
    /ALTER TABLE "match_plan_measurements" ADD CONSTRAINT "match_plan_measurements_measurementId_workspaceId_fkey" FOREIGN KEY \("measurementId", "workspaceId"\) REFERENCES "camera_color_measurements"\("id", "workspaceId"\) ON DELETE RESTRICT/,
  )

  // A plan is built against one reference camera, so at most one of its
  // measurements may claim to be the reference. A CHECK cannot say this: it
  // sees one row, and the rule is about the others.
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "match_plan_measurements_reference_key" ON "match_plan_measurements"\("workspaceId", "planId"\) WHERE "isReference";/,
  )
})

test('T-F4.012 versioned aggregates are chains with heads, and instants are claimed once', () => {
  for (const [table, owner] of [
    ['multicam_directions', ['workspaceId', 'sessionId', 'version']],
    ['multicam_match_plans', ['workspaceId', 'projectId', 'sessionId', 'version']],
    ['playback_maps', ['workspaceId', 'sessionId', 'reactionTrackId', 'version']],
  ]) {
    assert.match(
      checkBody(`${table}_chain_check`),
      /"version" = 1 AND "previousVersionHash" IS NULL[\s\S]*"version" > 1 AND "previousVersionHash" IS NOT NULL/,
      `${table} must be an append-only chain`,
    )
    assert.match(
      sql,
      new RegExp(`CREATE UNIQUE INDEX "[^"]+" ON "${table}"\\(${owner.map((column) => `"${column}"`).join(', ')}\\)`),
      `${table} must accept one row per version of its owner`,
    )
  }
  for (const [head, key] of [
    ['multicam_direction_heads', '"sessionId", "workspaceId"'],
    ['multicam_match_plan_heads', '"projectId", "sessionId", "workspaceId"'],
    ['playback_map_heads', '"workspaceId", "sessionId", "reactionTrackId"'],
  ]) {
    assert.match(
      sql,
      new RegExp(`CREATE UNIQUE INDEX "[^"]+" ON "${head}"\\(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
      `${head} must hold exactly one pointer per aggregate`,
    )
  }

  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist;/)
  for (const [table, parent, start, end] of [
    ['multicam_shot_decisions', 'directionId', 'sessionStartTicks', 'sessionEndTicks'],
    ['playback_pieces', 'mapId', 'reactionStartTicks', 'reactionEndTicks'],
    ['playback_uncovered_ranges', 'mapId', 'reactionStartTicks', 'reactionEndTicks'],
  ]) {
    assert.match(
      sql,
      new RegExp(`ADD CONSTRAINT "${table}_no_overlap_excl"\\s+EXCLUDE USING gist \\(\\s+"workspaceId" WITH =,\\s+"${parent}" WITH =,\\s+int8range\\("${start}", "${end}"\\) WITH &&`),
      `${table} must refuse two rows claiming one instant`,
    )
  }
})

test('T-F4.012 the migration is committed as LF and the command type is closed', () => {
  for (const [name, text] of [
    ['aggregates', sql],
    ['command type', commandMigration],
    ['rehydration', rehydration],
  ]) {
    assert.equal(text.includes('\r'), false, `the ${name} migration must be committed with LF endings`)
    assert.equal(text.includes('\u0000'), false, `the ${name} migration must not contain NUL bytes`)
  }
  assert.match(commandMigration, /ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";/)
  assert.match(commandMigration, /'direct-multicam-session'/)
})

/** One `model X { … }` block of the Prisma schema, brace-balanced. */
function modelBlock(model) {
  const anchor = schema.indexOf(`model ${model} {`)
  assert.notEqual(anchor, -1, `${model} is not declared by the Prisma schema`)
  const end = schema.indexOf('\n}', anchor)
  return schema.slice(anchor, end)
}

/**
 * Every child collection whose order the aggregate hash covers.
 *
 * `playback_anchors` is on this list because it was the one that was not: the
 * anchors were read back unordered and re-sorted by `(reactionTick, anchorId)`,
 * which is the order they are in only when a map has at most one anchor. A
 * second anchor placed before an existing one — the operator who answers the
 * later uncovered stretch first — wrote a map that could never be read again.
 */
const ORDERED_CHILDREN = Object.freeze([
  ['multicam_observations', 'evidenceSetId', 'multicam_observations_set_ordinal_key', 'V2MulticamObservation'],
  ['match_plan_measurements', 'planId', 'match_plan_measurements_plan_ordinal_key', 'V2MatchPlanMeasurement'],
  ['match_range_overrides', 'planId', 'match_range_overrides_plan_ordinal_key', 'V2MatchRangeOverride'],
  ['color_critic_proposed_deltas', 'reportId', 'color_critic_proposed_deltas_report_ordinal_key', 'V2ColorCriticProposedDelta'],
  ['playback_anchors', 'mapId', 'playback_anchors_map_ordinal_key', 'V2PlaybackAnchor'],
])

test('T-F4.015 every hashed child collection stores the order it is hashed in', () => {
  for (const [table, owner, index, model] of ORDERED_CHILDREN) {
    assert.ok(
      rehydration.includes(`ALTER TABLE "${table}" ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;`),
      `${table} must carry the position its owner hashed it in`,
    )
    assert.ok(
      rehydration.includes(`ALTER TABLE "${table}" ALTER COLUMN "ordinal" DROP DEFAULT;`),
      `${table}.ordinal must not keep a default a forgotten write could lean on`,
    )
    assert.ok(
      rehydration.includes(`ADD CONSTRAINT "${table}_ordinal_check" CHECK ("ordinal" >= 0)`),
      `${table}.ordinal must be a position and not a signed number`,
    )
    assert.ok(
      rehydration.includes(
        `CREATE UNIQUE INDEX "${index}" ON "${table}"("workspaceId", "${owner}", "ordinal");`,
      ),
      `${table} must refuse two children claiming one position`,
    )
    // The schema has to agree, or Prisma writes rows ordered by a column it
    // does not know about — which is the same as not ordering them.
    assert.match(modelBlock(model), /\n\s+ordinal\s+Int\b/, `${model} must declare the ordinal column`)
  }
})

test('T-F4.013 a JSON document that omits the key is refused, not tolerated', () => {
  // A CHECK is violated by FALSE and satisfied by unknown, and `jsonb ->> 'x'`
  // on a document without `x` is NULL. Every equality between a JSON path and
  // a projected column therefore has to be made false when the key is absent,
  // or the constraint refuses a document that names the wrong value and accepts
  // one that names none — which is the repair-script edit it exists to refuse.
  const naked = []
  for (const [name, text] of [['aggregates', sql], ['rehydration', rehydration]]) {
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trimStart().startsWith('--')) continue
      if (!line.includes("->>") && !line.includes("-> '")) continue
      if (line.includes('COALESCE')) continue
      naked.push(`${name}:${index + 1} ${line.trim()}`)
    }
  }
  assert.deepEqual(naked, [], 'these comparisons pass for a JSON document that simply omits the key')

  // And the one that is cast rather than compared says what type it expects
  // first, so a non-boolean is a refusal and not an invalid-input-syntax error
  // raised from underneath the writer.
  assert.match(
    rehydration,
    /jsonb_typeof\("transformJson"::jsonb -> 'enabled'\) = 'boolean'/,
    'the enabled flag must be type-checked before it is cast',
  )
})

/** The declared width of one `"column" VARCHAR(n)` inside one CREATE TABLE. */
function varcharWidth(table, column) {
  const anchor = sql.indexOf(`CREATE TABLE "${table}" (`)
  assert.notEqual(anchor, -1, `${table} is not created by the migration`)
  const body = sql.slice(anchor, sql.indexOf('\n);', anchor))
  const match = new RegExp(`"${column}" VARCHAR\\((\\d+)\\)`).exec(body)
  assert.notEqual(match, null, `${table}.${column} is not a VARCHAR`)
  return Number(match[1])
}

test('T-F4.015 an anchor note the domain accepts fits the column its evidence is built into', () => {
  // playback_anchors_actor_check DERIVES the evidence string from the actor and
  // the note: 'operator:' || actorId || ' (' || btrim(note) || ')'. A note the
  // domain accepts but the evidence column cannot hold is not a constraint
  // violation an application can classify — PostgreSQL raises 22001 from
  // underneath the repository and the whole map version is lost.
  const decoration = 'operator:'.length + ' ()'.length
  const actorId = varcharWidth('playback_anchors', 'actorId')
  const note = varcharWidth('playback_anchors', 'note')
  const evidenceRef = varcharWidth('playback_anchors', 'evidenceRef')

  assert.ok(
    note >= PLAYBACK_ANCHOR_NOTE_MAX,
    `playback_anchors.note holds ${note} characters but the domain accepts ${PLAYBACK_ANCHOR_NOTE_MAX}`,
  )
  assert.ok(
    evidenceRef >= decoration + actorId + PLAYBACK_ANCHOR_NOTE_MAX,
    `playback_anchors.evidenceRef holds ${evidenceRef} characters, short of the `
      + `${decoration + actorId + PLAYBACK_ANCHOR_NOTE_MAX} the CHECK can derive from the columns beside it`,
  )
})

test('T-F4.014 a critic report cites its measurements as rows a query can reach', () => {
  // The report kept the measured numbers inside sectionsJson, where nothing can
  // join to them: no foreign key, so camera_color_measurements' RESTRICT did
  // not extend to a verdict that cites one, and no query could ask which
  // verdicts rest on a measurement. The citation is a row now, shaped like
  // match_plan_measurements and bound the same way.
  assert.match(rehydration, /CREATE TABLE "color_critic_report_measurements" \(/)
  assert.ok(
    rehydration.includes('CONSTRAINT "color_critic_report_measurements_pkey" PRIMARY KEY ("id")'),
    'the citation table needs a primary key',
  )
  assert.ok(
    rehydration.includes(
      'CREATE UNIQUE INDEX "color_critic_report_measurements_cited_key" ON "color_critic_report_measurements"("workspaceId", "reportId", "stage", "measurementId");',
    ),
    'one report cites one measurement once per stage',
  )
  assertSet(
    'color_critic_report_measurements_stage_check', 'stage',
    COLOR_CRITIC_STAGES, 'COLOR_CRITIC_STAGES', rehydration,
  )
  assert.match(
    rehydration,
    /ADD CONSTRAINT "color_critic_report_measurements_reportId_workspaceId_fkey" FOREIGN KEY \("reportId", "workspaceId"\) REFERENCES "color_critic_reports"\("id", "workspaceId"\) ON DELETE CASCADE/,
    'the citation belongs to the report and goes when it goes',
  )
  assert.match(
    rehydration,
    /ADD CONSTRAINT "color_critic_report_measurements_measurementId_workspaceId_fkey" FOREIGN KEY \("measurementId", "workspaceId"\) REFERENCES "camera_color_measurements"\("id", "workspaceId"\) ON DELETE RESTRICT/,
    'a measurement a standing verdict rests on may not be deleted',
  )
  assert.match(schema, /@@map\("color_critic_report_measurements"\)/, 'the citation table has no Prisma model')
})

test('T-F4.013 the rehydration migration adds the columns the hash covers', () => {
  for (const [table, column, constraint] of [
    ['multicam_angle_candidates', 'evidenceJson', 'multicam_angle_candidates_evidence_check'],
    ['camera_match_transforms', 'transformJson', 'camera_match_transforms_transform_check'],
    ['match_range_overrides', 'transformJson', 'match_range_overrides_transform_check'],
  ]) {
    assert.ok(
      rehydration.includes(
        `ALTER TABLE "${table}"\n    ADD COLUMN "${column}" TEXT NOT NULL DEFAULT '{}';`,
      ),
      `${table}.${column} must exist`,
    )
    assert.ok(
      rehydration.includes(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT;`),
      `${table}.${column} must not keep a default that hides a forgotten write`,
    )
    assert.ok(
      rehydration.includes(`ADD CONSTRAINT "${constraint}"`),
      `${table}.${column} must be constrained by ${constraint}`,
    )
  }
})
