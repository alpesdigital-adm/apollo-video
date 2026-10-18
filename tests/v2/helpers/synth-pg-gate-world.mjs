import { randomUUID } from 'node:crypto'

import { seedSealedProject, testActor, uniqueRun } from './pg-output-world.mjs'

/**
 * The world the F4.016 gate is supposed to approve, written to PostgreSQL by
 * the repositories that own each aggregate.
 *
 * Why it exists: until this module the only 10/10 evaluation in the lane came
 * from a reader double, so "the gate approves when every condition holds" and
 * "removing one row fails exactly one condition" were both untested, and eight
 * of the ten criterion readers could be turned into rubber stamps without a
 * single test noticing.
 *
 * Two rules it follows:
 *
 * - **Nothing is hand-hashed.** Every aggregate is built by its own domain
 *   factory and stored through its own repository, so the hashes the gate
 *   re-derives are the hashes the product computes. A row written with a typed
 *   hash would prove only that PostgreSQL can store a string.
 * - **Each criterion has one removable row.** `experiments` names, per
 *   criterion, a single row whose deletion must fail that criterion and no
 *   other — which is the shape of the claim ADR-135 makes.
 *
 * The domain arrives through `await import`: tsx resolves a static `.ts`
 * specifier before transforming the target, and an `.mjs` that names one dies
 * at link time (the same reason `wave20-fixtures.mjs` is written this way).
 */

const {
  addCaptureSessionTrack,
  createCaptureSession,
} = await import('../../../src/v2/domain/capture-session.ts')
const { createColorPlan } = await import('../../../src/v2/domain/color-and-export.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')
const { currentProtocolForScenario } = await import(
  '../../../src/v2/domain/capture-protocol-catalog.ts'
)
const { evaluateCaptureProtocol } = await import(
  '../../../src/v2/domain/capture-protocol-evaluation.ts'
)
const { createMediaArtifactManifest } = await import('../../../src/v2/domain/media-artifact.ts')
const { createMulticamEvidenceSet } = await import('../../../src/v2/domain/multicam-evidence.ts')
const { directMulticam } = await import('../../../src/v2/domain/multicam-direction.ts')
const { createProjectColorPlan } = await import('../../../src/v2/domain/project-color-plan.ts')
const { createSessionClock } = await import('../../../src/v2/domain/session-clock.ts')
const { createTickInterval, rational } = await import('../../../src/v2/domain/session-time.ts')
const { createSyncDiagnostic, deriveTrackStatus } = await import(
  '../../../src/v2/domain/sync-diagnostic.ts'
)
const { evaluateSyncEvidence } = await import('../../../src/v2/domain/sync-evidence.ts')
const { STORY_GOLDEN_FIXTURES } = await import('../../../src/v2/domain/story-plan.ts')
const { createWorkspace } = await import('../../../src/v2/domain/workspace.ts')

const { createEditorialSynthesisService } = await import(
  '../../../src/v2/application/editorial-synthesis.ts'
)
const { compileSynthesisRenderPlanService } = await import(
  '../../../src/v2/application/compile-synthesis-to-directed-plan.ts'
)
const {
  compileReactPlaybackPlanService,
  editReactPlaybackAnchorService,
} = await import('../../../src/v2/application/react-playback-map.ts')

const { PrismaCaptureProtocolRepository } = await import(
  '../../../src/v2/infrastructure/prisma/capture-protocol-repository.ts'
)
const { PrismaCaptureSessionRepository } = await import(
  '../../../src/v2/infrastructure/prisma/capture-session-repository.ts'
)
const { PrismaCameraColorMeasurementRepository, PrismaMulticamMatchPlanRepository } = await import(
  '../../../src/v2/infrastructure/prisma/multicam-match-plan-repository.ts'
)
const { PrismaColorCriticReportRepository } = await import(
  '../../../src/v2/infrastructure/prisma/color-critic-report-repository.ts'
)
const { PrismaEditorialSynthesisRepository } = await import(
  '../../../src/v2/infrastructure/prisma/editorial-synthesis-repository.ts'
)
const { PrismaMulticamDirectionRepository } = await import(
  '../../../src/v2/infrastructure/prisma/multicam-direction-repository.ts'
)
const { PrismaPlaybackMapRepository } = await import(
  '../../../src/v2/infrastructure/prisma/playback-map-repository.ts'
)
const { PrismaRenderablePlanSnapshotRepository } = await import(
  '../../../src/v2/infrastructure/prisma/renderable-plan-snapshot-repository.ts'
)
const { PrismaRenderSourceRepository } = await import(
  '../../../src/v2/infrastructure/prisma/render-source-repository.ts'
)
const { PrismaSyncDiagnosticRepository } = await import(
  '../../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
)
const { PrismaWorkspaceRepository } = await import(
  '../../../src/v2/infrastructure/prisma/workspace-repository.ts'
)

const {
  buildDirectableMulticamWorld,
  buildMatchWorld,
  buildCriticReport,
  buildPlaybackWorld,
  fixtureInstant,
  fixtureSeconds,
  fixtureSha,
  fixtureTimebase,
} = await import('../wave20-fixtures.mjs')

const at = fixtureInstant
const sec = fixtureSeconds
const sha = fixtureSha
const TB = fixtureTimebase

const METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

const TWO_MINUTES_MS = 120_000
const TWO_HOURS_MS = 7_200_000
const SYNTHESIS_SHA = 'a'.repeat(63)

/** A colour transform that is an explicit no-op, in the shape ColorPlan asks for. */
function colourTransform(kind, id, parameters) {
  const sorted = Object.fromEntries(
    Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)),
  )
  return {
    id,
    kind,
    version: 'v1',
    enabled: false,
    input: METADATA,
    output: METADATA,
    implementation: {
      provider: 'apollo-test',
      version: 'v1',
      parameters: sorted,
      parametersHash: calculateCanonicalHash(sorted),
    },
  }
}

function observation(trackId, [from, to], kind, value, confidence = 0.9) {
  const id = `obs-${kind}-${trackId}-${from}-${to}`
  return {
    observationId: id,
    trackId,
    range: createTickInterval(sec(from), sec(to)),
    kind,
    value: { kind, ...value },
    confidence,
    provenance: {
      method: `fixture/${kind}`,
      evaluatorKind: 'controlled',
      evidenceRef: `run:${id}`,
      producedAt: at(0),
    },
  }
}

function lineage(operation, commandId) {
  return {
    commandId,
    operation,
    actorKind: 'human',
    actorId: 'operator-gate',
    occurredAt: at(0),
    note: null,
  }
}

function simpleTrack(trackId, role, assetId, deviceId) {
  return {
    trackId,
    role,
    device: { deviceId, recorderId: `${deviceId}-r`, make: null, model: null, serial: null },
    sourceAssetId: assetId,
    timebase: TB,
    streamIndex: 0,
    syncAudioPolicy: role === 'camera-main' ? 'final-candidate' : 'sync-only',
    includeInFinalMix: role === 'camera-main',
    parts: [{
      partId: `part-${trackId}`,
      ordinal: 0,
      sourceAssetId: assetId,
      timebase: TB,
      coverage: createTickInterval(0n, sec(600)),
      streamIndex: 0,
      splitReason: 'single-file',
      evidence: {
        ingestArtifactId: `artifact-${trackId}`,
        ingestSha256: sha('a'),
        probeHash: sha('b'),
        probeSource: 'packet-scan',
        observedAt: at(0),
      },
    }],
  }
}

export async function buildGateWorld({
  client,
  workspaceId,
  /** Pins the project's id (the creation Command allocates every other identity). */
  projectId: pinnedProjectId,
  clientId,
  otherWorkspaceId = null,
  otherProjectId: pinnedOtherProjectId,
  otherClientId = null,
  /**
   * Who compiles the two renderable plans criteria 4 and 6 need.
   *
   * `'repository'` keeps the seeded world complete, which is what every suite
   * that wants an approvable gate asks for. `'omit'` leaves both plans out so a
   * caller can write them through the published routes instead — the proof that
   * the compile hop is reachable from outside a test, which it was not until
   * `playback-map/plan` and `editorial-syntheses/{id}/render-plan` existed.
   */
  renderablePlans = 'repository',
  /** The invocation's identity: every id this world writes carries it (sealed rows are append-only, nothing is deleted). */
  run = uniqueRun('gate').run,
}) {
  const workspaceIds = [workspaceId, ...(otherWorkspaceId ? [otherWorkspaceId] : [])]
  /** Catalogue rows this world published, so cleanup takes back only its own. */
  const protocolRowIds = []
  /** `u('x')` is `x-<run>`: the one way this world names a row. */
  const u = (name) => `${name}-${run}`

  const sessions = new PrismaCaptureSessionRepository(client)
  const protocols = new PrismaCaptureProtocolRepository(client)
  const diagnostics = new PrismaSyncDiagnosticRepository(client)
  const directions = new PrismaMulticamDirectionRepository(client)
  const playbackMaps = new PrismaPlaybackMapRepository(client)
  const snapshots = new PrismaRenderablePlanSnapshotRepository(client)
  const renderSources = new PrismaRenderSourceRepository(client)
  const syntheses = new PrismaEditorialSynthesisRepository(client)
  const measurements = new PrismaCameraColorMeasurementRepository(client)
  const matchPlans = new PrismaMulticamMatchPlanRepository(client)
  const criticReports = new PrismaColorCriticReportRepository(client)

  // ---- workspace, client, project, version --------------------------------
  // The project is born the way the product makes one: the creation Command (root Version) and one explicit output
  // variant. The variant Version is the head every row below hangs off; the Version guards only admit Versions born
  // with their sealed State, so nothing here writes a project, snapshot or Version row by hand.
  const workspaces = new PrismaWorkspaceRepository(client)
  for (const id of workspaceIds) {
    await workspaces.create(createWorkspace({
      id, slug: id, name: 'F4.016 gate', status: 'active', createdAt: at(0),
    }))
  }
  const sealedActor = (id, workspace) => testActor({
    workspaceId: workspace, clientId: id, environment: 'sandbox', scopes: ['projects:read', 'projects:write'],
  })
  const sealed = await seedSealedProject(client, {
    workspaceId, actor: sealedActor(clientId, workspaceId), prefix: 'f4016',
    ...(pinnedProjectId ? { ids: { project: pinnedProjectId } } : {}), name: 'F4.016 gate', objective: 'discovery',
  })
  const otherSealed = otherWorkspaceId
    ? await seedSealedProject(client, {
      workspaceId: otherWorkspaceId, actor: sealedActor(otherClientId, otherWorkspaceId), prefix: 'f4016-other',
      ...(pinnedOtherProjectId ? { ids: { project: pinnedOtherProjectId } } : {}), name: 'F4.016 gate', objective: 'discovery',
    })
    : null
  const projectId = sealed.projectId
  const otherProjectId = otherSealed?.projectId ?? null
  const head = sealed.head
  const versionId = head.version.id
  const versionHash = head.version.baseHash
  // A renderable plan is born with the child of the head it is compiled on, and that child becomes the head: the gate judges the
  // CURRENT Version (its colour critic above all), so the world compiles on the head it finds and re-homes the critic's verdict on
  // the head each compile leaves. `versionId` stays the Version the world's other rows hang from.
  const headOf = async () => (await client.v2Project.findUniqueOrThrow({ where: { id: projectId }, select: { currentVersionId: true } })).currentVersionId
  let rehomeCriticReport = async () => {}
  // The director run and the export chain name a snapshot of each kind. A sealed project carries brief, policies and
  // edit-plan (a fourth or fifth would break the bundle's snapshot membership), so those kinds share the head's rows.
  const refs = head.version.snapshotRefs
  const snapshotIds = {
    brief: refs.brief,
    'edit-plan': refs.editPlan,
    policies: refs.policies,
    perception: refs.editPlan,
    treatment: refs.editPlan,
    story: refs.editPlan,
    'quality-report': refs.editPlan,
  }
  const qualitySnapshotHash = head.editPlanSnapshot.contentHash

  const ids = {
    podcastSession: u('f4016-session-podcast'),
    teacherSession: u('f4016-session-teacher'),
    insufficientSession: u('f4016-session-insufficient'),
    reactSession: u('f4016-session-react'),
  }

  // ---- criterion 1 and 5: a synchronised podcast, directed ----------------
  // Coverage rows are stored under `<trackId>:coverage`, a primary key that is not scoped to the workspace
  // (capture-session-repository.ts persistCoverage), so a track id another run already stored would collide: every track
  // of this world carries the run.
  const podcastTrack = (name) => `${u('podcast')}-${name}`
  const podcast = buildDirectableMulticamWorld({
    workspaceId, projectId, sessionId: ids.podcastSession, endSecond: 600, trackPrefix: `${u('podcast')}-`,
  })
  await storeCaptureWorld({ sessions, diagnostics, workspaceId, world: podcast })
  const podcastProtocol = currentProtocolForScenario('podcast')
  await publishAndEvaluate({
    protocols, workspaceId, protocol: podcastProtocol, session: podcast.session, second: 60,
    protocolRowIds,
  })
  // One session may hold evaluations against protocols of different scenarios
  // — the key is [workspace, session, sessionVersion, protocol, version] — and
  // this one does, deliberately. It is what separates "the evaluation whose
  // protocol says podcast" from "this session's newest evaluation": criteria 1
  // and 2 were both satisfied by whichever happened to be newer, so one row
  // answered two conditions ADR-135 asks to see independently. It is dated
  // BEFORE the teacher session's own evaluation, so the teacher criterion
  // still resolves to the teacher session.
  await publishAndEvaluate({
    protocols,
    workspaceId,
    protocol: currentProtocolForScenario('teacher-and-screen'),
    session: podcast.session,
    second: 61,
    protocolRowIds,
  })

  const evidenceSet = createMulticamEvidenceSet({
    session: podcast.session,
    observations: [
      observation(podcastTrack('track-mic-a'), [1, 120], 'active-speaker', { speakerKey: 'cluster-a', identityResolved: false }),
      observation(podcastTrack('track-mic-b'), [120, 250], 'active-speaker', { speakerKey: 'cluster-b', identityResolved: false }),
      observation(podcastTrack('track-camera-a'), [300, 360], 'demonstration', { surface: 'screen' }),
      observation(podcastTrack('track-screen'), [300, 360], 'screen-activity', { activityBps: 8_000 }, 0.95),
      observation(podcastTrack('track-mic-a'), [380, 500], 'active-speaker', { speakerKey: 'cluster-a', identityResolved: false }),
    ],
    generatedAt: at(130),
  })
  const direction = directMulticam({
    session: podcast.session,
    coverages: podcast.coverages,
    clockMaps: podcast.clockMaps,
    diagnostic: podcast.diagnostic,
    protocolCeiling: null,
    evidence: evidenceSet,
    format: { aspectRatio: '16:9' },
    range: createTickInterval(sec(1), sec(560)),
    generatedAt: at(140),
  })
  await directions.persistEvidenceSet({ set: evidenceSet, createdAt: new Date(at(141)) })
  await directions.appendVersion({ direction, base: null, occurredAt: new Date(at(142)) })

  // ---- criterion 2: a teacher-and-screen session with unequal tracks ------
  const teacher = buildDirectableMulticamWorld({
    workspaceId,
    projectId,
    sessionId: ids.teacherSession,
    endSecond: 600,
    cameraEndSecond: 420,
    // Coverage is keyed by track alone, so the two worlds must not share a
    // track id or the second one silently steals the first one's rows.
    trackPrefix: `${u('teacher')}-`,
  })
  await storeCaptureWorld({ sessions, diagnostics, workspaceId, world: teacher })
  const teacherProtocol = currentProtocolForScenario('teacher-and-screen')
  await publishAndEvaluate({
    protocols, workspaceId, protocol: teacherProtocol, session: teacher.session, second: 62,
    protocolRowIds,
  })

  // ---- criterion 3: evidence that cannot resolve, and says so -------------
  const insufficientBase = createCaptureSession({
    workspaceId,
    projectId,
    sessionId: ids.insufficientSession,
    clock: { timebase: TB, rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [simpleTrack('track-camera-main', 'camera-main', 'asset-camera', 'device-a')],
    lineage: lineage('create-session', 'command-insufficient-1'),
    createdAt: at(0),
  })
  const insufficientSession = addCaptureSessionTrack(insufficientBase, {
    track: simpleTrack('track-phone', 'phone', 'asset-phone', 'device-phone'),
    lineage: lineage('add-track', 'command-insufficient-2'),
  })
  await sessions.appendVersion({ session: insufficientBase, occurredAt: at(10) })
  await sessions.appendVersion({ session: insufficientSession, expectedVersion: 1, occurredAt: at(11) })
  const syncEvidence = evaluateSyncEvidence({
    sessionId: ids.insufficientSession,
    trackId: 'track-phone',
    referenceTrackId: 'track-camera-main',
    sessionTimebase: TB,
    sessionFrameRate: rational(30, 1),
    sessionBounds: createTickInterval(0n, sec(600)),
    signals: [],
  })
  await sessions.persistSyncEvidence({ workspaceId, record: syncEvidence, createdAt: at(12) })
  const unusableTrack = {
    trackId: 'track-phone',
    methods: [],
    confidence: 0,
    offsetMs: null,
    residualMs: null,
    driftPpm: null,
    coverageBps: null,
    gaps: [],
    automaticAnchors: [],
    manualAnchors: [],
    pieceIds: [],
    warnings: ['insufficient-evidence'],
    previewSampleMs: [],
  }
  const insufficientDiagnostic = createSyncDiagnostic({
    workspaceId,
    sessionId: ids.insufficientSession,
    referenceTrackId: insufficientSession.referenceTrackId,
    version: 1,
    previousVersionHash: null,
    sessionVersion: insufficientSession.version,
    referenceEpoch: insufficientSession.referenceEpoch,
    tracks: [{
      ...unusableTrack,
      status: deriveTrackStatus({ ...unusableTrack, hasContradictoryAnchors: false }),
    }],
    protocolCeiling: 'manual-anchors-required',
    generatedAt: at(120),
  })
  await diagnostics.appendVersion({ diagnostic: insufficientDiagnostic, occurredAt: at(121) })
  // A multicam protocol over a session with no shared evidence: the ceiling is
  // the protocol's own answer, not a constant this fixture types in.
  await publishAndEvaluate({
    protocols,
    workspaceId,
    protocol: currentProtocolForScenario('multicam'),
    session: insufficientSession,
    second: 63,
    protocolRowIds,
  })

  // ---- criterion 4: a react session cut through a piecewise map ----------
  const react = buildPlaybackWorld({
    workspaceId, projectId, sessionId: ids.reactSession, uncoveredStretches: 1,
    // The parts' ingest artifacts become `media_artifacts` rows, whose ids are unique across the database.
    ingest: {
      reaction: { artifactId: u('artifact-track-reaction'), sha256: sha('a') },
      reference: { artifactId: u('artifact-track-reference'), sha256: sha('c') },
    },
  })
  await sessions.appendVersion({ session: react.session, occurredAt: at(40) })
  for (const track of react.session.tracks) {
    const [part] = track.parts
    await storeArtifact({
      client,
      workspaceId,
      projectId,
      artifactId: part.evidence.ingestArtifactId,
      sha256: part.evidence.ingestSha256,
      durationSeconds: Number(part.coverage.end - part.coverage.start) /
        (Number(part.timebase.secondsPerTick.den) / Number(part.timebase.secondsPerTick.num)),
      key: `workspaces/${workspaceId}/sources/${track.trackId}.mp4`,
    })
  }
  await playbackMaps.appendVersion({ map: react.map, occurredAt: at(41) })
  const reactActor = {
    workspaceId,
    kind: 'human',
    id: 'operator-gate',
    credentialId: 'credential-gate',
    authenticationKind: 'ui-session',
  }
  let reactSecond = 42
  const reactClock = () => new Date(at((reactSecond += 1)))
  const anchorReact = editReactPlaybackAnchorService({
    repository: playbackMaps, snapshots, clock: reactClock,
  })
  // The one stretch the evidence cannot explain is answered by a person, which
  // is what takes the map from `needs-input` to `resolved`. Compiling an
  // unresolved map is exactly what the F4.015 lane refuses.
  const resolvedReact = await anchorReact({
    actor: reactActor,
    sessionId: ids.reactSession,
    reactionTrackId: 'track-reaction',
    baseVersionId: `${ids.reactSession}:playback:track-reaction:v${react.map.version}`,
    baseHash: react.map.mapHash,
    anchor: {
      anchorId: u('f4016-anchor-1'),
      reactionTick: react.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
      note: 'O player ficou escondido; a reação continua falando.',
    },
  })
  const compileReact = compileReactPlaybackPlanService({
    repository: playbackMaps,
    sessions,
    sources: renderSources,
    snapshots,
    clock: reactClock,
  })
  if (renderablePlans === 'repository') await compileReact({
    actor: reactActor,
    sessionId: ids.reactSession,
    reactionTrackId: 'track-reaction',
    // The map version the anchor produced: the compile is fenced on the pair,
    // like every other playback command.
    baseVersionId: `${ids.reactSession}:playback:track-reaction:v${resolvedReact.map.version}`,
    baseHash: resolvedReact.map.mapHash,
    projectVersionId: await headOf(),
    objective: 'discovery',
    planFps: rational(30n, 1n),
  })

  // ---- criterion 6: two hours of master as a two-minute multi-range cut ---
  const masterArtifactId = u('artifact-master-interview')
  await storeArtifact({
    client,
    workspaceId,
    projectId,
    artifactId: masterArtifactId,
    sha256: `${SYNTHESIS_SHA}1`,
    durationSeconds: TWO_HOURS_MS / 1_000,
    key: `workspaces/${workspaceId}/sources/master-interview.mp4`,
  })
  const storyPlan = {
    ...STORY_GOLDEN_FIXTURES.linear,
    id: u('f4016-story-plan'),
    targetDurationMs: { min: 100_000, max: 140_000 },
    blocks: STORY_GOLDEN_FIXTURES.linear.blocks.map((block) => ({
      ...block,
      durationTargetMs: { min: 20_000, ideal: 30_000, max: 45_000 },
    })),
  }
  const synthesisLineage = {
    sourceArtifactId: masterArtifactId,
    sourceArtifactSha256: `${SYNTHESIS_SHA}1`,
    sourceManifestId: `manifest-${masterArtifactId}`,
    sourceManifestHash: `${SYNTHESIS_SHA}2`,
    indexRunId: u('f4016-index-run'),
    momentId: u('f4016-moment'),
    momentHash: `${SYNTHESIS_SHA}3`,
    evaluationId: u('f4016-evaluation'),
    evaluationHash: `${SYNTHESIS_SHA}4`,
  }
  const windows = [
    { rangeId: 'range-1', startMs: 120_000, endMs: 145_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
    { rangeId: 'range-2', startMs: 900_000, endMs: 918_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
    { rangeId: 'range-3', startMs: 1_800_000, endMs: 1_822_000, claimIds: ['claim-1'], qualifierIds: [], proofContextIds: [] },
    { rangeId: 'range-4', startMs: 3_600_000, endMs: 3_615_000, claimIds: [], qualifierIds: ['qualifier-1'], proofContextIds: [] },
    { rangeId: 'range-5', startMs: 5_400_000, endMs: 5_425_000, claimIds: [], qualifierIds: [], proofContextIds: ['proof-1'] },
    { rangeId: 'range-6', startMs: 7_000_000, endMs: 7_015_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
  ].map((window) => ({
    ...window,
    lineage: synthesisLineage,
    rightsSnapshotId: u('f4016-rights-master'),
    rightsStatus: 'approved',
    consentStatus: 'approved',
  }))
  const createSynthesis = createEditorialSynthesisService({
    repository: syntheses,
    storyPlans: {
      async read({ storyPlanId }) {
        return storyPlanId === storyPlan.id
          ? { plan: storyPlan, requestFingerprint: `${SYNTHESIS_SHA}5`, idempotencyKey: u('f4016-story-key') }
          : null
      },
    },
    clock: () => new Date(at(50)),
  })
  const synthesis = await createSynthesis({
    workspaceId,
    projectId,
    synthesisId: u('f4016-synthesis'),
    objective: 'two-minute cut of the founder interview',
    targetDurationMs: TWO_MINUTES_MS,
    toleranceMs: 2_000,
    sourceDurationMs: TWO_HOURS_MS,
    frameRate: rational(30_000n, 1_001n),
    storyPlanId: storyPlan.id,
    editPlanId: u('f4016-edit-plan'),
    ranges: windows,
    joins: windows.slice(0, -1).map((window, index) => ({
      beforeRangeId: window.rangeId,
      afterRangeId: windows[index + 1].rangeId,
      kind: 'spliced',
      justification: `window ${index + 1} closes the thought that window ${index + 2} opens`,
      continuityRisks: ['argument'],
    })),
  })
  const compileSynthesis = compileSynthesisRenderPlanService({
    syntheses, sources: renderSources, snapshots, clock: () => new Date(at(51)),
  })
  if (renderablePlans === 'repository') await compileSynthesis({
    workspaceId,
    projectId,
    synthesisId: synthesis.synthesis.id,
    projectVersionId: await headOf(),
    objective: 'discovery',
    actor: { kind: 'human', id: u('f4016-operator') },
  })

  // ---- criterion 7: the camera match, and the colour plan it resolves in --
  const match = buildMatchWorld({
    workspaceId, projectId, sessionId: ids.podcastSession, sessionVersion: podcast.session.version,
  })
  for (const measurement of match.measurements) {
    await measurements.persist({ workspaceId, measurement, createdAt: at(60) })
  }
  await matchPlans.appendVersion({ plan: match.plan, base: null, occurredAt: at(61) })
  await client.v2EditCommand.create({
    data: {
      id: u('f4016-command-colour'),
      workspaceId,
      projectId,
      baseVersionId: versionId,
      baseHash: versionHash,
      type: 'set-project-color-plan',
      scopeJson: JSON.stringify({ kind: 'project' }),
      payloadJson: JSON.stringify({ plan: 'f4016' }),
      reason: 'the gate fixture needs a stored colour plan to resolve',
      actorType: 'api-client',
      actorId: clientId,
      idempotencyKey: u('f4016-colour-key'),
      requestFingerprint: sha('3'),
      createdAt: new Date(at(62)),
    },
  })
  const colourPlan = createProjectColorPlan({
    id: u('f4016-colour-plan'),
    workspaceId,
    projectId,
    commandId: u('f4016-command-colour'),
    baseVersionId: versionId,
    resultVersionId: versionId,
    plan: {
      schemaVersion: 'color-plan/v1',
      metadata: METADATA,
      outputMetadata: METADATA,
      global: [
        colourTransform('technical', 'global-technical', { mode: 'identity' }),
        colourTransform('match', 'global-match', { mode: 'bypass' }),
        colourTransform('creative-lut', 'global-creative', { mode: 'none' }),
        colourTransform('output', 'global-output', { mode: 'identity' }),
      ],
    },
    targets: [{ cameraId: match.plan.referenceCameraId }],
    createdAt: at(63),
  })
  await client.v2ProjectColorPlan.create({
    data: {
      id: colourPlan.id,
      workspaceId,
      projectId,
      commandId: colourPlan.commandId,
      baseVersionId: colourPlan.baseVersionId,
      resultVersionId: colourPlan.resultVersionId,
      schemaVersion: colourPlan.schemaVersion,
      planJson: JSON.stringify(colourPlan.plan),
      planHash: colourPlan.plan.planHash ?? calculateCanonicalHash(colourPlan.plan),
      compiledManifestJson: JSON.stringify(colourPlan.compiled),
      compiledManifestHash: colourPlan.compiled.manifestHash ??
        calculateCanonicalHash(colourPlan.compiled),
      recordJson: JSON.stringify(colourPlan),
      recordHash: colourPlan.recordHash,
      createdAt: new Date(at(63)),
    },
  })
  await client.v2ProjectColorPlanHead.create({
    data: { workspaceId, projectId, colorPlanId: colourPlan.id, updatedAt: new Date(at(63)) },
  })

  // ---- criterion 8: the colour critic's verdict on the current version ----
  const criticFor = (projectVersionId, reportId) => buildCriticReport({
    workspaceId,
    projectId,
    projectVersionId,
    reportId,
    matchPlan: match.plan,
  })
  // The verdict is on the current Version: when a compile moves the head, the same verdict is re-issued for the Version it left.
  let rehomed = 0
  rehomeCriticReport = async () => {
    const current = await headOf()
    if (current === criticReport.projectVersionId) return
    criticReport = criticFor(current, u(`f4016-critic-report-head-${(rehomed += 1)}`))
    await criticReports.persist({ report: criticReport, createdAt: at(70) })
  }
  let criticReport = criticFor(await headOf(), u('f4016-critic-report'))
  await criticReports.persist({ report: criticReport, createdAt: at(70) })

  // ---- criterion 9: the delivered MP4, its artifact and its manifest -----
  const exportIds = {
    proxyOperation: u('f4016-proxy-operation'),
    finalOperation: u('f4016-final-operation'),
    directorRun: u('f4016-director-run'),
    directorCommand: u('f4016-command-director'),
    proxyReview: u('f4016-proxy-review'),
    sourceArtifact: u('f4016-artifact-source'),
    proxyArtifact: u('f4016-artifact-proxy'),
    outputArtifact: u('f4016-artifact-output'),
  }
  const artifacts = {}
  for (const [key, seed, role] of [
    ['sourceArtifact', '4', 'source-master'],
    ['proxyArtifact', '5', 'editorial-proxy'],
    ['outputArtifact', '6', 'final-export'],
  ]) {
    artifacts[key] = await storeArtifact({
      client,
      workspaceId,
      projectId,
      artifactId: exportIds[key],
      sha256: sha(seed),
      durationSeconds: 120,
      key: `workspaces/${workspaceId}/${role}/${exportIds[key]}.mp4`,
      byteSize: 8_192,
      role,
      // The export chain names its artifacts by id; nothing renders FROM them,
      // so they are not project render sources.
      link: false,
    })
  }
  await client.v2EditCommand.create({
    data: {
      id: exportIds.directorCommand,
      workspaceId,
      projectId,
      baseVersionId: versionId,
      baseHash: versionHash,
      type: 'run-director',
      scopeJson: JSON.stringify({ kind: 'project' }),
      payloadJson: JSON.stringify({ reason: 'finalise the multicam cut' }),
      reason: 'the gate fixture needs a director run to hang the export off',
      actorType: 'api-client',
      actorId: clientId,
      idempotencyKey: u('f4016-director-key'),
      requestFingerprint: sha('7'),
      createdAt: new Date(at(80)),
    },
  })
  await client.v2DirectorRun.create({
    data: {
      id: exportIds.directorRun,
      workspaceId,
      projectId,
      commandId: exportIds.directorCommand,
      baseVersionId: versionId,
      resultVersionId: versionId,
      status: 'succeeded',
      plannerVersion: 'planner/1.0.0',
      criticVersion: 'critic/1.0.0',
      objective: 'discovery',
      objectiveVersion: 1,
      rubricRef: 'awareness-discovery/v1',
      perceptionSnapshotId: snapshotIds.perception,
      treatmentSnapshotId: snapshotIds.treatment,
      storySnapshotId: snapshotIds.story,
      editPlanSnapshotId: snapshotIds['edit-plan'],
      qualitySnapshotId: snapshotIds['quality-report'],
      decisionsJson: JSON.stringify([]),
      assumptionsJson: JSON.stringify([]),
      initiatedByType: 'api-client',
      initiatedById: clientId,
      createdAt: new Date(at(81)),
      updatedAt: new Date(at(81)),
    },
  })
  const operationRow = (id, type, targetId) => ({
    id,
    workspaceId,
    projectId,
    clientId,
    type,
    status: 'succeeded',
    phase: 'completed',
    targetType: 'media-artifact',
    targetId,
    // The canonical progress CHECK ties status, phase and the counters
    // together: a succeeded render is completed at 4 of 4 render steps.
    progressCompleted: 4,
    progressTotal: 4,
    progressUnit: 'render',
    cancelable: false,
    retryable: false,
    // A succeeded operation carries its result; the state CHECK ties the two.
    resultJson: JSON.stringify({ artifactId: targetId }),
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: `${id}-key`,
    requestFingerprint: sha('8'),
    createdAt: new Date(at(82)),
    updatedAt: new Date(at(83)),
    startedAt: new Date(at(82)),
    completedAt: new Date(at(83)),
  })
  await client.v2PublicOperation.create({
    data: operationRow(exportIds.proxyOperation, 'project-proxy-render', exportIds.proxyArtifact),
  })
  await client.v2ProjectProxyRenderOperation.create({
    data: {
      operationId: exportIds.proxyOperation,
      workspaceId,
      projectId,
      projectVersionId: versionId,
      editPlanSnapshotId: snapshotIds['edit-plan'],
      sourceArtifactId: exportIds.sourceArtifact,
      sourceManifestId: `manifest-${exportIds.sourceArtifact}`,
      colorPipelineBindingsJson: JSON.stringify([]),
      inputHash: sha('9'),
      outputArtifactId: exportIds.proxyArtifact,
      outputManifestId: `manifest-${exportIds.proxyArtifact}`,
      originalFileName: 'master.mp4',
      createdAt: new Date(at(84)),
    },
  })
  await client.v2ProxyReview.create({
    data: {
      id: exportIds.proxyReview,
      workspaceId,
      projectId,
      projectVersionId: versionId,
      operationId: exportIds.proxyOperation,
      proxyArtifactId: exportIds.proxyArtifact,
      proxyManifestId: `manifest-${exportIds.proxyArtifact}`,
      inputHash: sha('9'),
      outputSpecId: 'proxy-16x9',
      rangeCacheKey: sha('a'),
      specJson: JSON.stringify({ id: 'proxy-16x9' }),
      status: 'ready-for-final',
      technicalIssuesJson: JSON.stringify([]),
      criticIssuesJson: JSON.stringify([]),
      warningsAcknowledged: true,
      acknowledgedByType: 'api-client',
      acknowledgedById: clientId,
      acknowledgedAt: new Date(at(86)),
      finalAllowed: true,
      reviewHash: sha('b'),
      revision: 1,
      uploadReceivedAt: new Date(at(85)),
      renderCompletedAt: new Date(at(86)),
      timeToFirstProxyMs: BigInt(1_000),
      createdAt: new Date(at(86)),
      updatedAt: new Date(at(86)),
    },
  })
  await client.v2PublicOperation.create({
    data: operationRow(exportIds.finalOperation, 'project-final-export', exportIds.outputArtifact),
  })
  await client.v2ProjectFinalExportOperation.create({
    data: {
      operationId: exportIds.finalOperation,
      workspaceId,
      projectId,
      projectVersionId: versionId,
      projectVersionHash: versionHash,
      editPlanSnapshotId: snapshotIds['edit-plan'],
      directorRunId: exportIds.directorRun,
      qualitySnapshotId: snapshotIds['quality-report'],
      qualitySnapshotHash,
      proxyReviewId: exportIds.proxyReview,
      proxyReviewHash: sha('b'),
      proxyArtifactId: exportIds.proxyArtifact,
      sourceArtifactId: exportIds.sourceArtifact,
      sourceManifestId: `manifest-${exportIds.sourceArtifact}`,
      colorPipelineBindingsJson: JSON.stringify([]),
      inputHash: sha('c'),
      outputArtifactId: exportIds.outputArtifact,
      outputManifestId: `manifest-${exportIds.outputArtifact}`,
      outputAspectRatio: '16:9',
      outputWidth: 1_920,
      outputHeight: 1_080,
      outputFps: 30,
      outputCodec: 'h264',
      outputAudioCodec: 'aac',
      outputContainer: 'mp4',
      outputQuality: 'final',
      approvedByType: 'api-client',
      approvedById: clientId,
      approvalNote: 'approved by the F4.016 gate fixture',
      approvedAt: new Date(at(87)),
      originalFileName: 'master.mp4',
      createdAt: new Date(at(87)),
    },
  })
  await client.v2ProjectFinalExportAttempt.create({
    data: {
      operationId: exportIds.finalOperation,
      workspaceId,
      attempt: 1,
      status: 'promoted',
      validatorsJson: JSON.stringify([]),
      outputArtifactId: exportIds.outputArtifact,
      outputManifestId: `manifest-${exportIds.outputArtifact}`,
      outputSha256: sha('6'),
      outputByteSize: BigInt(8_192),
      startedAt: new Date(at(88)),
      completedAt: new Date(at(89)),
    },
  })

  return {
    renderablePlans,
    ids,
    exportIds,
    artifacts,
    insufficientDiagnostic,
    unusableTrack,
    podcast,
    teacher,
    react,
    resolvedReact,
    direction,
    synthesis: synthesis.synthesis,
    match,
    colourPlan,
    get criticReport() { return criticReport },
    insufficientSession,
    snapshotIds,
    protocolRowIds,
    run,
    projectId,
    otherProjectId,
    versionId,
    versionHash,
    head,
    /** The project head now: the Version the last compile left, or `versionId` while nothing compiled. */
    headVersionId: headOf,
    /** Re-issue the colour critic's verdict for the current head (a compile outside the world moved it). */
    rehomeCriticReport: () => rehomeCriticReport(),
  }
}

/**
 * One ingested recording: the artifact, its manifest and the project link.
 *
 * The manifest is built by the domain factory, so `manifestHash` is the hash
 * the product computes over the body — the gate re-derives exactly that, and a
 * typed-in hash would make criterion 9's probe check pass on a lie.
 */
async function storeArtifact({
  client,
  workspaceId,
  projectId,
  artifactId,
  sha256,
  durationSeconds,
  key,
  byteSize = 4_096,
  mediaType = 'video',
  container = 'mp4',
  role = 'source-master',
  /** Whether the project links the artifact as a render source. */
  link = true,
  width = 1_920,
  height = 1_080,
  fps = 30,
}) {
  const manifest = createMediaArtifactManifest({
    artifactKey: key,
    artifactSha256: sha256,
    byteSize,
    mediaType,
    container,
    recipe: { id: role, version: '1.0.0', parameters: {} },
    sources: [],
    probe: { width, height, fps, duration: durationSeconds },
  })
  await client.v2MediaArtifact.create({
    data: {
      id: artifactId,
      workspaceId,
      artifactKey: key,
      sha256,
      byteSize: BigInt(byteSize),
      mediaType,
      container,
      status: 'available',
      createdAt: new Date(at(0)),
    },
  })
  await client.v2MediaArtifactManifest.create({
    data: {
      id: `manifest-${artifactId}`,
      workspaceId,
      artifactId,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      recipeId: manifest.recipe.id,
      recipeVersion: manifest.recipe.version,
      parametersHash: manifest.recipe.parametersHash,
      manifestJson: JSON.stringify(manifest),
      createdAt: new Date(at(0)),
    },
  })
  if (!link) return manifest
  await client.v2ProjectMediaAsset.create({
    data: {
      id: randomUUID(),
      workspaceId,
      projectId,
      artifactId,
      role,
      originalFileName: `${artifactId}.mp4`,
      createdAt: new Date(at(0)),
    },
  })
  return manifest
}

async function storeCaptureWorld({ sessions, diagnostics, workspaceId, world }) {
  for (const [index, version] of world.versions.entries()) {
    await sessions.appendVersion({
      session: version,
      ...(index === 0 ? {} : { expectedVersion: index }),
      occurredAt: at(20 + index),
    })
  }
  await sessions.persistClock({ workspaceId, clock: world.clock, createdAt: at(30) })
  for (const coverage of world.coverages) {
    await sessions.persistCoverage({
      coverage,
      sessionId: world.session.sessionId,
      createdAt: at(31),
    })
  }
  for (const map of world.clockMaps) {
    await sessions.persistClockMap({ map, createdAt: at(32) })
  }
  await diagnostics.appendVersion({ diagnostic: world.diagnostic, occurredAt: at(33) })
}

async function publishAndEvaluate({
  protocols,
  workspaceId,
  protocol,
  session,
  second,
  protocolRowIds,
}) {
  const published = await protocols.publish({ protocol, createdAt: at(second) })
  // Only a row this world actually wrote is ours to delete later.
  if (!published.replayed && protocolRowIds) {
    protocolRowIds.push(`${protocol.protocolId}:v${protocol.version}`)
  }
  const evaluation = evaluateCaptureProtocol({
    workspaceId,
    protocol,
    session,
    markers: { confirmedPositions: ['start', 'end'] },
    evaluatedAt: at(second),
  })
  await protocols.persistEvaluation({ evaluation, createdAt: at(second) })
  return evaluation
}
