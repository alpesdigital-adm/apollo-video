// Dynamic imports: a suite run under tsx loses the names of a static named import of a .ts module from an .mjs file.
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')
const { stableSerialize } = await import('../../../src/v2/application/version-hash.ts')
const { requestDirectorFaceWindows } = await import('../../../src/v2/application/director-face-window-requests.ts')
const { createDirectorPerceptionEvidenceReport } = await import('../../../src/v2/domain/director-perception-evidence.ts')
const { policyRef, resolveEditorialPolicies } = await import('../../../src/v2/domain/editorial-policy-resolution.ts')
const { createBriefInterpretation, deriveEditorialRequestFromBrief } = await import('../../../src/v2/domain/editorial-request.ts')
const { assembleServerPerceptionSnapshot } = await import('../../../src/v2/domain/server-perception-snapshot.ts')
const { createDesiredAction } = await import('../../../src/v2/domain/desired-action.ts')
const { createProductionBrief, normalizeBriefingText } = await import('../../../src/v2/domain/production-brief.ts')

/**
 * Fixtures for the sealed editorial request of a Director run (ADR-160), for the tests that seed a DirectorRun by hand instead of running
 * the Director. A run the Director really produces carries a v5 quality report bound to the request in its brief and to a policy
 * resolution snapshot; these helpers build exactly those pieces from the brief the fixture's Version holds, so the final-export admission
 * reads them the way it reads a real run.
 */

/** The perception evidence section of a v5 report, over a snapshot with no sealed evidence at all (every modality absent). */
async function emptyPerceptionEvidence({ workspaceId, projectId, projectVersionId }) {
  const clip = { id: 'clip-fixture-1', sourceArtifactId: 'artifact-fixture-source', sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }
  const snapshot = assembleServerPerceptionSnapshot({
    workspaceId, projectId, projectVersionId,
    editPlan: { snapshotId: 'snapshot-fixture-edit', snapshotHash: null, fps: 30, durationFrames: 300, clips: [clip] },
  })
  const faces = await requestDirectorFaceWindows({}, {
    workspaceId, projectId, baseVersionId: projectVersionId,
    authenticationAudit: { clientId: 'client-fixture', contextHash: 'c'.repeat(64) },
    fps: 30, durationFrames: 300, clips: [clip], sealedWindows: [],
  })
  return createDirectorPerceptionEvidenceReport({ snapshot, rights: [], faceWindows: faces.report, faceRequests: faces.state, decisions: [] })
}

/**
 * The request and the resolution a brief states, and the v5 quality report that was judged against them.
 *
 * @param {object} input
 * @param {string} input.briefContentJson  the contentJson of the Brief Snapshot of the Version the run directs (its request is derived from it)
 * @param {object} input.strategic         the strategic quality report (createQualityReport)
 * @param {Record<string, boolean>} [input.checks]  overrides by hard check id (a check that did not hold)
 */
export async function sealedEditorialFixture({ briefContentJson, strategic, suffix, evaluatedAt, workspaceId, projectId, projectVersionId, status = 'review-required', checks = {}, removalRuleIds = [], issues = [] }) {
  const request = deriveEditorialRequestFromBrief(JSON.parse(briefContentJson), removalRuleIds)
  const resolution = resolveEditorialPolicies(request, { transcriptLanguage: 'xx-YY', hasSelectedInsert: false }, {})
  const perceptionEvidence = await emptyPerceptionEvidence({ workspaceId, projectId, projectVersionId })
  const passes = (id) => checks[id] ?? true
  const check = (id, kind, key) => ({ id, kind, passed: passes(id), policyRef: key ? policyRef(resolution, key) : null, evidence: [`${id}=fixture`] })
  const qualityReport = {
    schemaVersion: 'director-quality-report/v5',
    id: `quality-report-${suffix}`,
    desiredActionRef: { id: `action-${suffix}` },
    status,
    strategic,
    faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: [
      check('requestHonored', 'request'),
      check('movementMatchesPolicy', 'request', 'movement'),
      check('openingMatchesPolicy', 'request', 'opening'),
      check('forbiddenSpeechAbsent', 'request', 'speechRemovals'),
      check('captionsFitMeasured', 'invariant', 'captions'),
      check('timelineContinuous', 'invariant'),
      check('sourceRightsCertain', 'invariant'),
    ],
    score: strategic.score / 100,
    issues,
    perceptionEvidence,
    requestHash: request.requestHash,
    policyResolutionHash: resolution.policyResolutionHash,
    criticVersion: 'apollo-director-critic/v5',
    evaluatedAt,
  }
  return { request, resolution, qualityReport }
}

/** The project snapshot row that holds a sealed resolution (what a real run writes next to its quality report). */
export function policySnapshotRow({ id, workspaceId, projectId, resolution, createdAt }) {
  return {
    id, workspaceId, projectId, kind: 'policy-resolution', schemaVersion: 2,
    contentJson: stableSerialize(resolution), contentHash: calculateCanonicalHash(resolution), createdAt,
  }
}

/**
 * The `editorialRequest` part of a brief whose briefing was read by an interpreter that found nothing to map: the state of a project whose
 * `revise-editorial-request` has run on a briefing the model could not translate into a directive. A briefing with text and no reading is
 * refused by the Director (ADR-160 F6); tests that are about something else say that the briefing was read.
 */
export function readByInterpreter(ownerText, found = {}) {
  const briefingText = normalizeBriefingText(ownerText)
  return {
    interpretation: createBriefInterpretation({
      briefingText, interpreter: { provider: 'test-double', model: 'stub-1', promptVersion: 'brief-interpreter/v1' }, directives: [], ...found,
    }),
  }
}

/** The contentJson of a Brief Snapshot as the project creation writes it, for a given objective and (optional) free briefing. */
export function controlledBriefJson({ objective = 'discovery', ownerText, readByDefault = true } = {}) {
  return stableSerialize({
    schemaVersion: 2, objective, desiredAction: createDesiredAction({ objective }),
    productionBrief: createProductionBrief({ ...(ownerText ? { ownerText } : {}) }),
    ...(ownerText && readByDefault ? { editorialRequest: readByInterpreter(ownerText) } : {}),
  })
}
