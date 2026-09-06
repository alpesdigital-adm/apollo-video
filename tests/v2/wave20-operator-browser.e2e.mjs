import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E — the three Wave 20 operator pages in a real browser, against a
 * production build and a real PostgreSQL.
 *
 * The domain decides honestly and the API says so plainly; every suite beside
 * this one proves that. What none of them can prove is that the answer
 * survives the last hop, and the last hop is where honesty is usually lost —
 * because a page that has a number for every cell looks finished, and a page
 * that admits it does not know looks unfinished.
 *
 * So the three assertions this file exists for are all the same assertion,
 * about three different screens:
 *
 * 1. **Direction.** A candidate whose coverage nobody measured must render as
 *    "não medida", never as `0,00 %`. Zero says "measured, and useless"; null
 *    says nobody looked, and an editor who reads the first will cut believing a
 *    camera was checked and rejected.
 * 2. **Colour.** A critic dimension that could not be read must render as "não
 *    medido", never as `0.000`. A grading surface that prints zero where no
 *    skin tone was found reports a perfect skin tone.
 * 3. **Playback.** A piece with no measured rate must render as "não medida"
 *    and its reference column must say the reference did not advance — never
 *    `1/1` and never an interval. A rate of one is a measurement, and printing
 *    it where none was taken makes a hand-answered map look verified.
 *
 * And two supporting claims: every angle that lost carries the sentence that
 * rejected it (a shot showing only its winner is a decision without a
 * defence), and every colour issue carries the number that was measured
 * against the threshold that bounded it, with the bytes the critic judged
 * reachable as evidence.
 *
 * The fixtures are the unhealthy ones on purpose: cameras that stop before the
 * directed range ends, a camera two and a half stops under its reference with
 * crushed blacks, and a reaction with a pause, a commentary, a replay, a seek
 * and a stretch the detector refused to guess at.
 *
 * Needs PostgreSQL, a production build and Chrome, so it is opt-in.
 */

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('E2E-F4.012/013/014/015 the Wave 20 operator pages never render an absence as a number', {
  skip: process.env.APOLLO_WAVE20_BROWSER_E2E !== '1'
    && 'set APOLLO_WAVE20_BROWSER_E2E=1 and use an isolated V2 database',
}, async () => {
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaCaptureSessionRepository } = await import('../../src/v2/infrastructure/prisma/capture-session-repository.ts')
  const { PrismaSyncDiagnosticRepository } = await import('../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts')
  const { PrismaMulticamDirectionRepository } = await import('../../src/v2/infrastructure/prisma/multicam-direction-repository.ts')
  const { PrismaMulticamMatchPlanRepository, PrismaCameraColorMeasurementRepository } = await import('../../src/v2/infrastructure/prisma/multicam-match-plan-repository.ts')
  const { PrismaColorCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/color-critic-report-repository.ts')
  const { PrismaPlaybackMapRepository } = await import('../../src/v2/infrastructure/prisma/playback-map-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { createMulticamEvidenceSet } = await import('../../src/v2/domain/multicam-evidence.ts')
  const { directMulticam } = await import('../../src/v2/domain/multicam-direction.ts')
  const { evaluateColorCritic } = await import('../../src/v2/domain/color-critic-report.ts')
  const { createTickInterval } = await import('../../src/v2/domain/session-time.ts')
  const { createProductionBrief } = await import('../../src/v2/domain/production-brief.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createDesiredAction, createDesiredActionReference } = await import('../../src/v2/domain/desired-action.ts')
  const { createEditorialAudioTimelineHash } = await import('../../src/v2/domain/production-modes.ts')
  const fixtures = await import('./wave20-fixtures.mjs')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `w20-ui-${suffix}`
  const projectId = `w20-ui-project-${suffix}`
  const sessionId = `w20-ui-session-${suffix}`
  const reactSessionId = `w20-ui-react-${suffix}`
  const projectVersionId = `w20-ui-version-${suffix}`
  const reportId = `w20-ui-report-${suffix}`
  // Track and asset ids are prefixed per run. `media_artifacts.id` is unique
  // across the whole database rather than per workspace, so two runs of this
  // suite against one cluster — or one run that was killed before its cleanup —
  // collide on `asset-cam-a` and the second one cannot even seed.
  const trackPrefix = `w20-${suffix}-`
  const masterCameraAssetId = `${trackPrefix}asset-cam-a`
  const uiUsername = `w20-ui-user-${suffix}`
  const uiPassword = `Wave20-Operator-${suffix}-secure`
  const createdAt = new Date('2029-08-01T09:00:00.000Z')
  const at = (second) => new Date(createdAt.getTime() + second * 1_000)
  const sec = fixtures.fixtureSeconds
  const instant = fixtures.fixtureInstant
  const sha = fixtures.fixtureSha
  // A scratch artifact root for the server, removed in `finally`: the commands
  // need one to exist, and the suite is not allowed to leave it behind.
  const artifactRoot = mkdtempSync(join(tmpdir(), 'apollo-w20-ui-'))
  let server
  let browser

  const clean = async () => {
    await client.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2ProjectVersion.updateMany({ where: { workspaceId }, data: { commandId: null } })
    for (const table of [
      client.v2ColorCriticProposedDelta, client.v2ColorCriticIssue,
      client.v2ColorCriticDimensionResult, client.v2ColorCriticReportMeasurement,
      client.v2ColorCriticReport,
      client.v2PlaybackUncoveredRange, client.v2PlaybackAnchor, client.v2PlaybackPiece,
      client.v2PlaybackMapHead, client.v2PlaybackMap,
      client.v2MatchPlanIssue, client.v2MatchNonComparableRange, client.v2MatchRangeOverride,
      client.v2CameraMatchTransform, client.v2MatchPlanMeasurement,
      client.v2MulticamMatchPlanHead, client.v2MulticamMatchPlan,
      client.v2ColorMeasurementComponent, client.v2ColorMeasurementDimension,
      client.v2CameraColorMeasurement,
      client.v2MulticamAngleScoreComponent, client.v2MulticamAngleCandidate,
      client.v2MulticamShotAlternative, client.v2MulticamShotDecision,
      client.v2MulticamDirectionHead, client.v2MulticamDirection,
      client.v2MulticamObservation, client.v2MulticamEvidenceSet,
      client.v2SyncDiagnosticHead, client.v2SyncDiagnostic,
      client.v2CaptureClockMap, client.v2CaptureTrackCoverage,
      client.v2CaptureSessionClock,
      client.v2CaptureSessionVersion, client.v2CaptureSessionHead,
      client.v2CommandArtifactInvalidation, client.v2PublicEventOutbox,
      client.v2EditCommand, client.v2ProjectVersion,
      client.v2ProjectMediaAsset, client.v2ProjectSnapshot,
      client.v2MediaArtifactManifest, client.v2MediaArtifact,
      client.v2Project,
    ]) {
      await table.deleteMany({ where: { workspaceId } })
    }
    // Before the API client, not after: bootstrap login provisions a UI
    // principal pointing at it, and that relation is onDelete: Restrict.
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await clean()
    await client.v2Workspace.create({
      data: {
        id: workspaceId, slug: workspaceId, name: 'Wave 20 operator E2E',
        status: 'active', createdAt, updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `w20-ui-client-${suffix}`,
      workspaceId,
      name: 'Wave 20 operator E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'Wave 20 operator E2E',
        status: 'reviewing-proxy', objective: 'discovery', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: issued.client.id,
        createdAt, updatedAt: createdAt,
      },
    })
    // The brief snapshot carries a real production brief rather than a stub.
    // The workspace read re-parses it and refuses a brief that is not the
    // canonical output of the factory — which is correct, and which means a
    // stub here would make the project version unreadable and take the pages'
    // fence with it.
    //
    // The edit plan is a real Director EditPlan for the same reason one step
    // further on: `run-direction` derives a new plan on top of the project's
    // current one, and the command repository both refuses a plan that is not
    // directed (`isDirected`) and re-hashes the bytes beside the snapshot. A
    // `{ kind: 'edit-plan' }` stub reads fine and makes the command
    // unreachable, which is exactly how a suite ends up asserting that a button
    // is enabled instead of asserting what it does.
    const desiredActionRef = createDesiredActionReference(createDesiredAction({ objective: 'discovery' }))
    const baseClips = [{
      id: 'clip-base-0001', sourceArtifactId: masterCameraAssetId,
      sourceInFrame: 0, sourceOutFrame: 9_000, timelineInFrame: 0, timelineOutFrame: 9_000, rate: 1,
    }]
    const basePlan = {
      schemaVersion: 2, state: 'compiled', id: `edit-plan-${projectVersionId}`, projectVersionId,
      storyPlanId: 'story-w20-ui', treatmentPlanId: 'treatment-w20-ui', directorRunId: 'director-run-w20-ui',
      fps: 30, durationFrames: 9_000,
      sources: [{ id: masterCameraAssetId, artifactId: masterCameraAssetId, kind: 'video', durationSeconds: 300 }],
      videoTracks: [{ id: 'track-primary-video', kind: 'base-video', clips: baseClips }],
      overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [], transitions: [],
      markers: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
      lineageRefs: [masterCameraAssetId],
      editorial: { commandType: 'source-ingest', exclusions: [], retainedSourceRanges: [] },
      retimedTranscript: { sourceTranscriptId: 'transcript-w20-ui', words: [] },
      movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 },
      composition: {
        layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5,
        faceSafeFallback: [0.14, 0.08, 0.72, 0.56], subtitleSafeRegion: [0.08, 0.7, 0.84, 0.24],
      },
      director: { plannerVersion: 'w20-ui-planner/v1', decisions: [], assumptions: [] },
      desiredActionRef,
      audioTimelineHash: createEditorialAudioTimelineHash({ fps: 30, clips: baseClips }),
      createdAt: createdAt.toISOString(),
    }
    const contentFor = (kind) => (kind === 'brief'
      ? { productionBrief: createProductionBrief({ ownerText: 'Wave 20 operator E2E' }) }
      : kind === 'edit-plan' ? basePlan : { kind })
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      const content = contentFor(kind)
      await client.v2ProjectSnapshot.create({
        data: {
          id: `w20-ui-snapshot-${kind}-${suffix}`, workspaceId, projectId, kind,
          schemaVersion: kind === 'edit-plan' ? 2 : 1,
          contentJson: stableSerialize(content), contentHash: calculateVersionHash(content),
          createdAt,
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: projectVersionId, workspaceId, projectId, sequence: 1,
        briefSnapshotId: `w20-ui-snapshot-brief-${suffix}`,
        editPlanSnapshotId: `w20-ui-snapshot-edit-plan-${suffix}`,
        policiesSnapshotId: `w20-ui-snapshot-policies-${suffix}`,
        baseHash: sha('2'), createdBy: issued.client.id, createdAt,
      },
    })
    // The colour page reads the project version through the workspace
    // capability and names it when it lists verdicts. Without a current
    // version there is nothing to name, and a list across versions would mix
    // judgements of different frames.
    await client.v2Project.update({
      where: { id: projectId }, data: { currentVersionId: projectVersionId },
    })

    // ---- F4.012: a session directed past the end of both cameras ----------
    // A real recording, because the direction command really opens one. Its
    // evidence sweep resolves every video part through
    // `LocalArtifactContentStorage`, which re-hashes the bytes on disk and
    // refuses a mismatch — so a part naming a file that does not exist is
    // exactly where an end-to-end direction stops, and the id and checksum the
    // fixture uses by default name nothing.
    //
    // One clip serves every part: 64×64 at five frames a second, small enough
    // that thirty decodes cost seconds, three hundred seconds long so it spans
    // the coverage the parts claim, and with real motion, which is what the
    // screen-activity measurement needs in order to measure anything at all.
    //
    // It carries a sound as well as a picture, and that is not decoration. The
    // same clip backs the microphone parts, and the direction measures those
    // with `-map 0:a:0`; against a video-only file ffmpeg answers "Stream map
    // '0:a:0' matches no streams" and exits 127, which the provider reports as
    // RENDER_EXECUTION_FAILED — a 422 whose only real cause was a fixture with
    // no audio in it. A sine is enough: the loudness sweep needs a stream it
    // can measure, not speech.
    const ffmpegPath = (await import('ffmpeg-static')).default
    const ingestArtifactId = `${trackPrefix}ingest`
    const ingestKey = `artifacts/${ingestArtifactId}.mp4`
    const ingestPath = join(artifactRoot, 'artifacts', `${ingestArtifactId}.mp4`)
    mkdirSync(join(artifactRoot, 'artifacts'), { recursive: true })
    execFileSync(ffmpegPath, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=300',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      ingestPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    const ingest = {
      artifactId: ingestArtifactId,
      sha256: createHash('sha256').update(readFileSync(ingestPath)).digest('hex'),
    }
    await client.v2MediaArtifact.create({
      data: {
        id: ingestArtifactId, workspaceId, artifactKey: ingestKey,
        sha256: ingest.sha256, byteSize: BigInt(statSync(ingestPath).size),
        mediaType: 'video', container: 'mp4', status: 'available', createdAt,
      },
    })

    const sessions = new PrismaCaptureSessionRepository(client)
    const world = fixtures.buildDirectableMulticamWorld({
      workspaceId, sessionId, projectId, trackPrefix, ingest,
    })
    // Every recording the direction may cut has to be a linked, available
    // project asset with a probed cadence, or the command refuses before it
    // reaches the domain. The reads above need none of this; the command does.
    for (const track of world.session.tracks) {
      const artifactId = track.sourceAssetId
      const mediaType = ['microphone', 'master-audio', 'scratch-audio'].includes(track.role) ? 'audio' : 'video'
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId, workspaceId, artifactKey: `artifacts/${artifactId}.mp4`,
          sha256: sha('f'), byteSize: BigInt(4_096), mediaType, container: 'mp4',
          status: 'available', createdAt,
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: `w20-ui-manifest-${artifactId}`, workspaceId, artifactId,
          schemaVersion: 'media-artifact-manifest/v1', manifestHash: sha('7'),
          recipeId: 'capture-ingest', recipeVersion: '1.0.0', parametersHash: sha('8'),
          manifestJson: JSON.stringify({
            artifact: { artifactKey: `artifacts/${artifactId}.mp4` },
            probe: { duration: 300, fps: 30, rFrameRate: '30/1' },
          }),
          createdAt,
        },
      })
      await client.v2ProjectMediaAsset.create({
        data: {
          // A UUID column, not a readable id: the row is keyed by one.
          id: randomUUID(), workspaceId, projectId, artifactId,
          role: artifactId === masterCameraAssetId ? 'source-master' : 'selected-insert',
          originalFileName: `${artifactId}.mp4`, createdAt,
        },
      })
    }
    for (const version of world.versions) {
      await sessions.appendVersion({
        session: version,
        ...(version.version > 1 ? { expectedVersion: version.version - 1 } : {}),
        occurredAt: at(1).toISOString(),
      })
    }
    await sessions.persistClock({ workspaceId, clock: world.clock, createdAt: at(1).toISOString() })
    for (const map of world.clockMaps) {
      await sessions.persistClockMap({ map, createdAt: at(1).toISOString() })
    }
    // Deliberately partial: the microphones carry no coverage, so their
    // candidacies come back with `availability: 'unmeasured'` and a null
    // confidence. That null is the thing this file is here to watch.
    const measuredCoverages = world.coverages.filter((coverage) => !coverage.trackId.includes('mic'))
    for (const coverage of measuredCoverages) {
      await sessions.persistCoverage({ coverage, sessionId, createdAt: at(1).toISOString() })
    }
    await new PrismaSyncDiagnosticRepository(client).appendVersion({
      diagnostic: world.diagnostic, occurredAt: at(2).toISOString(),
    })

    const speaks = (trackId, fromSecond, toSecond) => ({
      observationId: `obs-active-speaker-${trackId}-${fromSecond}-${toSecond}`,
      trackId,
      range: createTickInterval(sec(fromSecond), sec(toSecond)),
      kind: 'active-speaker',
      value: { kind: 'active-speaker', speakerKey: `cluster-${trackId}`, identityResolved: false },
      confidence: 0.9,
      provenance: {
        method: 'fixture/active-speaker',
        evaluatorKind: 'controlled',
        evidenceRef: `run:${trackId}-${fromSecond}`,
        producedAt: instant(0),
      },
    })
    const evidence = createMulticamEvidenceSet({
      session: world.session,
      observations: [
        speaks(`${trackPrefix}track-mic-a`, 1, 120),
        speaks(`${trackPrefix}track-mic-b`, 120, 250),
        speaks(`${trackPrefix}track-mic-a`, 250, 300),
      ],
      generatedAt: instant(130),
    })
    const direction = directMulticam({
      session: world.session,
      coverages: measuredCoverages,
      clockMaps: world.clockMaps,
      diagnostic: world.diagnostic,
      protocolCeiling: null,
      evidence,
      format: { aspectRatio: '16:9' },
      // Past the end of both cameras on purpose: the last hundred seconds have
      // no eligible angle, so `uncovered` is non-empty and a person is needed.
      range: createTickInterval(sec(1), sec(400)),
      generatedAt: instant(140),
    })
    assert.ok(direction.manualReviewRequired, 'the direction fixture must need a person')
    assert.ok(direction.uncovered.length >= 1, 'the direction fixture must carry an uncovered stretch')
    const directions = new PrismaMulticamDirectionRepository(client)
    await directions.persistEvidenceSet({ set: evidence, createdAt: at(3).toISOString() })
    await directions.appendVersion({ direction, base: null, occurredAt: at(4).toISOString() })

    // ---- F4.013/F4.014: a clamped match plan and a rejecting verdict ------
    const match = fixtures.buildMatchWorld({ workspaceId, projectId, sessionId, sessionVersion: world.session.version })
    assert.ok(match.plan.humanReviewRequired, 'the match fixture must need a person')
    const measurements = new PrismaCameraColorMeasurementRepository(client)
    for (const measurement of match.measurements) {
      await measurements.persist({ workspaceId, measurement, createdAt: at(5).toISOString() })
    }
    await new PrismaMulticamMatchPlanRepository(client).appendVersion({
      plan: match.plan, base: null, occurredAt: at(6).toISOString(),
    })

    // A camera two and a half stops under its reference, with crushed blacks
    // and a warm cast: hard issues with numbers, and two dimensions nobody
    // could read.
    const stage = (name, artifactId, digest) => [
      fixtures.buildMeasurement({
        measurementId: `${reportId}-${name}-a`, cameraId: 'camera-a',
        sourceAssetId: artifactId, sourceSha256: digest,
      }),
      fixtures.buildMeasurement({
        measurementId: `${reportId}-${name}-b`, cameraId: 'camera-b',
        sourceAssetId: artifactId, sourceSha256: digest,
        exposure: fixtures.lumaAtEv(0.5, -2.5), blacks: 0.09, rOverG: 1.25,
      }),
    ]
    const report = evaluateColorCritic({
      reportId,
      workspaceId,
      projectId,
      projectVersionId,
      subject: { kind: 'output', artifactId: 'artifact-output' },
      before: stage('before', 'artifact-intermediate', sha('d')),
      after: stage('after', 'artifact-output', sha('e')),
      matchPlan: match.plan,
      creativeIntent: { declared: false },
      evaluatedAt: at(7).toISOString(),
    })
    assert.equal(report.action, 'reject', 'the critic fixture must refuse the render')
    assert.ok(report.issues.length >= 3, 'the critic fixture must raise issues with numbers')
    await new PrismaColorCriticReportRepository(client).persist({ report, createdAt: at(8).toISOString() })

    // ---- F4.015: a reaction with a pause, a commentary, a replay, a seek --
    // Two real recordings, because `build-map` really opens both: it resolves
    // the reference and the reaction through the media port and the storage
    // re-hashes the bytes, so a part naming a file that does not exist stops
    // the command before the fingerprinter is ever asked anything.
    //
    // They are deliberately unalignable. The reference carries a 1 000 Hz tone
    // for thirty seconds, the reaction a 300 Hz tone for forty, and neither
    // contains the other: the reaction never played this reference. That is the
    // material the operator page has to be honest about — the detector finds no
    // window it can compare, and the answer must be that a person has to place
    // the first anchor, not a map built out of nothing.
    const reactMedia = async (name, seconds, hz, pattern) => {
      const artifactId = `${trackPrefix}${name}`
      const filePath = join(artifactRoot, 'artifacts', `${artifactId}.mp4`)
      execFileSync(ffmpegPath, [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `${pattern}=size=64x64:rate=5:duration=${seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', filePath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex')
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId, workspaceId, artifactKey: `artifacts/${artifactId}.mp4`,
          sha256: digest, byteSize: BigInt(statSync(filePath).size),
          mediaType: 'video', container: 'mp4', status: 'available', createdAt,
        },
      })
      return { artifactId, sha256: digest }
    }
    const playbackIngest = {
      reference: await reactMedia('reference-media', 30, 1_000, 'testsrc'),
      reaction: await reactMedia('reaction-media', 40, 300, 'smptebars'),
    }
    const playback = fixtures.buildPlaybackWorld({
      workspaceId, sessionId: reactSessionId, projectId, ingest: playbackIngest,
    })
    assert.equal(playback.map.status, 'needs-input', 'the playback fixture must need a person')
    await sessions.appendVersion({ session: playback.session, occurredAt: at(9).toISOString() })
    await new PrismaPlaybackMapRepository(client).appendVersion({
      map: playback.map, occurredAt: at(10).toISOString(),
    })

    // ---- the server ------------------------------------------------------
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let serverLogs = ''
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        // The write factories are composition roots: they build their media
        // resolver before any handler runs, so without an artifact root the
        // playback and colour commands answer 503 PERSISTENCE_NOT_CONFIGURED
        // and never reach the domain at all. The reads do not need it, which is
        // why a suite that only read never had to say so.
        APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_RENDER_WORK_ROOT: join(artifactRoot, 'work'),
        // Nothing here says where ffmpeg is, and that absence is the assertion.
        // `ffmpeg-static` resolves its binary as `path.join(__dirname,
        // 'ffmpeg.exe')`, and webpack rewrites `__dirname` to the chunk's own
        // folder — so inside `next start` the module used to point at
        // `.next/server/chunks/ffmpeg.exe`, which does not exist; every
        // provider failed to spawn and the direction answered 422
        // RENDER_EXECUTION_FAILED with nothing on the wire saying the binary
        // was simply not there. This suite got past it by naming `FFMPEG_BIN`,
        // which fixed one test and no deployment. `resolveFfmpegBinary` now
        // resolves it inside the server, and the direction reaching 201 below
        // is the only end-to-end proof of that there can be.
        // Without these the login page resolves to 'unavailable' and renders no
        // password form: the system fails closed when no auth mode is declared,
        // which is correct, and which a test has to opt into.
        APOLLO_AUTH_MODE: 'bootstrap',
        APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
        APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `w20-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: `w20-session-secret-${suffix}-at-least-32`,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    // ---- the API first ---------------------------------------------------
    // Stated plainly before the browser is involved, so a failure below is a
    // rendering failure rather than an ambiguous one.
    const authorization = `Bearer ${issued.token}`
    const read = async (path) => {
      // With a deadline: an unbounded fetch turns a server that stopped
      // answering into a suite that never finishes.
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization }, signal: AbortSignal.timeout(30_000),
      })
      const payload = await response.json()
      assert.equal(
        response.status, 200,
        `${path}: ${JSON.stringify(payload)}\n${serverLogs.slice(-4_000)}`,
      )
      return payload.data
    }

    const project = encodeURIComponent(projectId)
    const session = encodeURIComponent(sessionId)
    const reactSession = encodeURIComponent(reactSessionId)
    const encodedReport = encodeURIComponent(reportId)

    // The fence every command on these pages names comes from here. Asserted
    // before the browser because a page that cannot read the project version
    // cannot offer a command at all, and the symptom of that — a missing
    // button — looks like a rendering bug rather than a refused read.
    const workspace = await read(`/v1/projects/${project}/workspace`)
    assert.equal(workspace.version?.id, projectVersionId)
    assert.equal(workspace.version?.baseHash, sha('2'))

    const directionRead = await read(`/v1/projects/${project}/capture-sessions/${session}/direction`)
    assert.equal(directionRead.direction.manualReviewRequired, true)
    assert.ok(directionRead.direction.uncovered.length >= 1)
    const shotListing = await read(`/v1/projects/${project}/capture-sessions/${session}/direction/shots`)
    const candidateListing = await read(`/v1/projects/${project}/capture-sessions/${session}/direction/candidates`)
    const unmeasuredCandidates = candidateListing.windows
      .flatMap((window) => window.candidates)
      .filter((candidate) => candidate.coverage.confidenceBps === null)
    assert.ok(
      unmeasuredCandidates.length > 0,
      'the fixture must offer at least one angle whose coverage nobody measured',
    )

    const matchRead = await read(`/v1/projects/${project}/capture-sessions/${session}/color-match`)
    assert.equal(matchRead.plan.humanReviewRequired, true)
    const reportListing = await read(
      `/v1/projects/${project}/color-critic-reports?projectVersionId=${encodeURIComponent(projectVersionId)}`,
    )
    assert.equal(reportListing.reports.length, 1)
    assert.equal(reportListing.reports[0].action, 'reject')
    const reportRead = await read(`/v1/projects/${project}/color-critic-reports/${encodedReport}`)
    const unreadDimensions = reportRead.report.dimensions.filter((dimension) => dimension.value === null)
    assert.ok(
      unreadDimensions.length >= 2,
      'the fixture must carry dimensions the critic could not read',
    )
    const issueListing = await read(`/v1/projects/${project}/color-critic-reports/${encodedReport}/issues`)
    assert.ok(issueListing.issues.length >= 3)

    const reactor = encodeURIComponent(playback.map.reactionTrackId)
    const mapRead = await read(
      `/v1/projects/${project}/capture-sessions/${reactSession}/playback-map?reactionTrackId=${reactor}`,
    )
    assert.equal(mapRead.map.status, 'needs-input')
    assert.ok(mapRead.map.uncovered.length >= 1)
    const pieceListing = await read(
      `/v1/projects/${project}/capture-sessions/${reactSession}/playback-map/pieces?reactionTrackId=${reactor}`,
    )
    const unratedPieces = pieceListing.pieces.filter((piece) => piece.rate === null)
    assert.ok(
      unratedPieces.length > 0,
      'the fixture must carry pieces the fingerprinter measured no rate for',
    )

    // ---- the browser -----------------------------------------------------
    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the Wave 20 operator browser E2E')

    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } })
    // Bounded on purpose. A journey that drives six commands has many places to
    // wait, and a CI job that hangs says less than one that fails: the default
    // is generous enough for a production build on a cold cache and short
    // enough that the phase markers below still name where it stopped.
    context.setDefaultTimeout(20_000)
    context.setDefaultNavigationTimeout(20_000)
    const page = await context.newPage()

    const linkTo = (route, id) =>
      `${baseUrl}${route}?projeto=${encodeURIComponent(projectId)}&sessao=${encodeURIComponent(id)}`

    // Phases, with the clock. A browser journey that drives six commands takes
    // minutes; without this, a run that stalls is indistinguishable from a run
    // that is working, and the CI log says nothing about which step cost what.
    const startedAt = Date.now()
    const mark = (phase) => console.log(`w20-browser ${String(Date.now() - startedAt).padStart(7)} ms  ${phase}`)

    /**
     * Every command body this page puts on the wire, as the running page built
     * it.
     *
     * Reading the request rather than only the outcome is what makes a fence
     * checkable: a page that quietly took `baseVersionId` from the query string
     * would still get a 201 whenever the two happened to agree, and a suite
     * that watched only the status would never see it.
     */
    /**
     * Every command this page put on the wire, and every answer it got back.
     *
     * The request matters because a fence is only a fence if the page did not
     * choose it: a page that quietly read `baseVersionId` off the query string
     * would still get a 201 whenever the two agreed, and a suite watching only
     * the outcome would never see it.
     *
     * The answer matters because these pages clear their own message the moment
     * they reload — `load()` starts with `setMessage(null)` — so the sentence a
     * success puts on screen is gone a few hundred milliseconds later. Waiting
     * for it would be racing the reload the click itself triggered. The durable
     * facts are the status the server returned, the code inside a refusal, and
     * what the API says afterwards; those are what this suite asserts.
     */
    const channelFor = (target) => {
      const channel = { requests: [], answers: [] }
      target.on('request', (request) => {
        if (request.method() !== 'POST') return
        let body = null
        try { body = request.postDataJSON() } catch { body = null }
        channel.requests.push({ url: request.url(), body })
      })
      target.on('response', (response) => {
        if (response.request().method() !== 'POST') return
        const url = response.url()
        const status = response.status()
        void response.text()
          .then((text) => channel.answers.push({ url, status, text }))
          .catch(() => channel.answers.push({ url, status, text: '' }))
      })
      return channel
    }
    const operator = channelFor(page)

    const endsWith = (url, path) => url.split('?')[0].endsWith(path)

    /** The next POST to `path` after `from`, waited for rather than assumed. */
    const waitForPost = async (channel, path, from) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const entry = channel.requests.slice(from).find((item) => endsWith(item.url, path))
        if (entry) return entry
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.fail(`no POST reached ${path}`)
    }

    /**
     * The answer to that POST, with its status and its envelope.
     *
     * `code` is the discriminator the pages branch on, so a suite that asserts
     * a page's remedy has to know which refusal actually arrived — and a public
     * error message is deliberately uninformative, which is why the envelope is
     * read rather than the sentence on screen.
     */
    const waitForAnswer = async (channel, path, from, what) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const entry = channel.answers.slice(from).find((item) => endsWith(item.url, path))
        if (entry) {
          let parsed = null
          try { parsed = JSON.parse(entry.text) } catch { parsed = null }
          return { ...entry, code: parsed?.error?.code ?? null, data: parsed?.data ?? null }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.fail(`${what}: no answer to POST ${path}\n${serverLogs.slice(-2_000)}`)
    }

    /**
     * What a live region says, without waiting for it to exist.
     *
     * `textContent()` on an absent element waits out the whole default timeout,
     * so a poll built on it costs the timeout times the attempt count — which is
     * how a loop that looked bounded at thirty seconds became an eighty-minute
     * hang the first time a message was cleared before it was read.
     */
    const shownText = async (target, testId) => {
      const locator = target.getByTestId(testId)
      if (await locator.count() === 0) return ''
      return (await locator.first().textContent())?.trim() ?? ''
    }

    /** Wait until the screen says it. Only for messages a reload does not clear. */
    const waitForText = async (target, testId, pattern, what) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const shown = await shownText(target, testId)
        if (pattern.test(shown)) return shown
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.fail(
        `${what}; the screen said ${JSON.stringify(await shownText(target, testId))}\n`
        + serverLogs.slice(-2_000),
      )
    }

    const waitForAttribute = async (target, testId, name, expected, what) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const value = await target.getByTestId(testId).getAttribute(name).catch(() => null)
        if (value === expected) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const value = await target.getByTestId(testId).getAttribute(name).catch(() => null)
      assert.fail(`${what}; it was ${JSON.stringify(value)} and not ${JSON.stringify(expected)}`)
    }

    mark('login')
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/capture-sessions')}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL('**/capture-sessions**')

    // Every one of the three pages is reachable from the session list; the
    // shell has a fixed set of destinations and none of these is one of them,
    // so a broken link here means the page cannot be found at all.
    //
    // Reachable once a session is chosen, and not before. Offered on the empty
    // form they pointed at `?projeto=&sessao=` — the empty form their own
    // comment says they exist to avoid — and a visibility assertion was
    // satisfied by exactly that state, so the absence is asserted first and the
    // hrefs after it.
    for (const testId of ['open-multicam-direction', 'open-color-match', 'open-playback-map']) {
      assert.equal(
        await page.getByTestId(testId).count(), 0,
        `${testId} was offered before a session was chosen and would have led to an empty form`,
      )
    }
    await page.locator('input[name="projectId"]').fill(projectId)
    await page.getByRole('button', { name: 'Carregar' }).click()
    await page.getByTestId(`session-${sessionId}`).waitFor({ state: 'visible' })
    await page.getByTestId(`session-${sessionId}`).getByRole('button', { name: 'Ver sincronização' }).click()
    await page.getByTestId('open-multicam-direction').waitFor({ state: 'visible' })
    for (const [testId, route] of [
      ['open-multicam-direction', '/multicam-direction'],
      ['open-color-match', '/color-match'],
      ['open-playback-map', '/playback-map'],
    ]) {
      assert.equal(
        await page.getByTestId(testId).locator('a').getAttribute('href'),
        `${route}?projeto=${encodeURIComponent(projectId)}&sessao=${encodeURIComponent(sessionId)}`,
        `${testId} did not carry the project and session the operator had just chosen`,
      )
    }

    mark('capture-sessions links')
    // ---- the direction page ---------------------------------------------
    await page.goto(linkTo('/multicam-direction', sessionId))
    await page.getByTestId('direction-summary').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('manual-review').getAttribute('data-required'), 'true')
    await page.getByTestId('direction-uncovered').waitFor({ state: 'visible' })

    // The assertion this page exists for: nobody measured it, and the screen
    // says so rather than printing a percentage.
    for (const candidate of unmeasuredCandidates) {
      const shown = (await page.getByTestId(`coverage-${candidate.candidateId}`).textContent())?.trim() ?? ''
      assert.match(
        shown,
        /não medida/,
        `an unmeasured coverage confidence was rendered as "${shown}"`,
      )
      assert.doesNotMatch(shown, /0[,.]00 %/, 'an unmeasured coverage was rendered as zero per cent')
    }

    // And every angle that lost says why, in the words the server used.
    let alternatives = 0
    for (const shot of shotListing.shots) {
      assert.equal(
        (await page.getByTestId(`chosen-${shot.shotId}`).textContent())?.trim(),
        shot.chosen.trackId,
      )
      for (const alternative of shot.alternatives) {
        const lost = (await page.getByTestId(`lost-${alternative.candidateId}`).textContent())?.trim()
        assert.equal(
          lost,
          alternative.rejectedBecause,
          `the angle ${alternative.trackId} lost and the page did not say why`,
        )
        alternatives += 1
      }
    }
    assert.ok(alternatives > 0, 'the fixture must offer angles that lost')

    for (const warning of directionRead.direction.warnings) {
      const shown = await page.getByTestId(`warning-${warning.code}`).first().textContent()
      assert.ok(
        (shown ?? '').includes(warning.detail),
        `the direction warned "${warning.code}" and the page did not carry its detail`,
      )
    }

    mark('direction page read')
    // ---- the colour page -------------------------------------------------
    await page.goto(linkTo('/color-match', sessionId))
    await page.getByTestId('match-plan').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('match-review').getAttribute('data-required'), 'true')

    const exposureCell = await page
      .getByTestId(`exposure-${matchRead.plan.cameraTransforms[0].cameraId}`)
      .textContent()
    assert.match(exposureCell ?? '', /-2\.50 EV/, 'a measured exposure delta was not shown as measured')

    await page.getByTestId(`open-critic-${reportId}`).click()
    await page.getByTestId('critic-report').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('critic-report').getAttribute('data-action'), 'reject')

    // The assertion this page exists for.
    for (const dimension of unreadDimensions) {
      const shown = (await page.getByTestId(`measured-${dimension.dimension}`).textContent())?.trim()
      assert.equal(
        shown,
        'não medido',
        `the critic could not read ${dimension.dimension} and the page showed "${shown}"`,
      )
    }

    // The bytes it judged, reachable from the verdict.
    for (const section of reportRead.report.sections) {
      for (const bytes of section.bytesEvaluated) {
        const source = await page.getByTestId(`evidence-${bytes.artifactId}`).getAttribute('src')
        assert.equal(source, `/v1/artifacts/${encodeURIComponent(bytes.artifactId)}/content`)
      }
    }

    await page.getByTestId('critic-issues').waitFor({ state: 'visible' })
    const issueText = (await page.getByTestId('critic-issues').textContent()) ?? ''
    for (const issue of issueListing.issues) {
      assert.ok(issueText.includes(issue.code), `the issue ${issue.code} never reached the screen`)
      // An insufficient-evidence issue has nothing measured, and the page has
      // to say that rather than print a number — so the expected text is
      // derived from the answer, not assumed to be a number.
      assert.ok(
        issueText.includes(issue.measured === null ? 'não medido' : issue.measured.toFixed(3)),
        `the issue ${issue.code} was shown without the number that was measured`,
      )
      assert.ok(
        issueText.includes(issue.threshold === null ? 'não medido' : issue.threshold.toFixed(3)),
        `the issue ${issue.code} was shown without the threshold that bounded it`,
      )
    }

    mark('colour page read')
    // ---- the two colour commands, as requests ----------------------------
    // Neither of these can be driven to a 201 on this fixture: both write a
    // ColorPlan, and that write needs one unambiguous trusted colour
    // compilation per source, which nothing here seeds. So what is asserted is
    // the request the running page built — the fences it carried, and the scope
    // it now carries — plus the rule that it may not report a scope it did not
    // send. The outcome is deliberately not asserted, because this suite cannot
    // honestly produce one.
    await page.getByTestId('reference-camera').fill(matchRead.plan.referenceCameraId)
    const fromDerive = operator.requests.length
    await page.getByTestId('derive-match').click()
    const derived = await waitForPost(operator, '/color-match', fromDerive)
    assert.equal(derived.body.referenceCameraId, matchRead.plan.referenceCameraId)
    assert.equal(
      derived.body.baseVersionId, `${sessionId}:v${world.session.version}`,
      'the derivation named a session fence the page did not read',
    )
    assert.equal(derived.body.projectBaseVersionId, projectVersionId)
    assert.equal(derived.body.projectBaseHash, sha('2'))
    const deriveAnswer = await waitForAnswer(operator, '/color-match', fromDerive, 'the derivation')
    // The answer, by its real shape rather than "something came back". On this
    // project no source carries a trusted colour compilation, so the ColorPlan
    // context refuses to be read at all — `project-color-plan-repository.ts:311`
    // — and the derivation cannot write the layer it exists to write.
    //
    // Worth naming, because the code is doing double duty: PERSISTENCE_CONFLICT
    // means both "the head moved" and "the stored projections cannot support
    // this", and `_operator/refusal.ts` lists it among the stale-fence codes.
    // The operator is therefore told to reload, and a reload cannot fix a
    // missing compilation. Asserted as it is rather than as it should be.
    assert.equal(
      deriveAnswer.status, 409,
      `the derivation answered ${deriveAnswer.status} ${deriveAnswer.code ?? ''}: `
      + `${deriveAnswer.text.slice(0, 400)}
${serverLogs.slice(-2_000)}`,
    )
    assert.equal(
      deriveAnswer.code, 'PERSISTENCE_CONFLICT',
      `the derivation was refused as ${deriveAnswer.code} rather than for the compilation it needs`,
    )
    // The refusal reaches the operator as a sentence, and the plan on screen is
    // still the one that was stored: a refused derivation writes nothing.
    await waitForText(
      page, 'color-message', /Recarregue antes de repetir/,
      'the refused derivation said nothing on screen',
    )
    const afterDerive = await read(`/v1/projects/${project}/capture-sessions/${session}/color-match`)
    assert.equal(afterDerive.versionRef, matchRead.versionRef, 'a refused derivation moved the plan')

    // The scope the page could not carry at all until now: an override without
    // a range grades the whole camera, and the copy used to promise otherwise.
    const gradedCamera = matchRead.plan.cameraTransforms[0].cameraId
    await page.getByTestId('override-camera').fill(gradedCamera)
    await page.getByTestId('override-range-start').fill('90000')
    await page.getByTestId('override-range-end').fill('180000')
    await page.getByTestId('override-reason').fill('a produção quis esta câmera mais quente só neste trecho')
    const fromOverride = operator.requests.length
    await page.getByTestId('apply-override').click()
    const override = await waitForPost(operator, '/color-match/overrides', fromOverride)
    assert.deepEqual(
      override.body.override.range, { start: '90000', end: '180000' },
      'the trecho the operator typed never reached the request, so the correction graded the whole camera',
    )
    assert.equal(override.body.override.cameraId, gradedCamera)
    assert.equal(
      override.body.baseVersionId, matchRead.versionRef,
      'the override named a plan fence the page did not read',
    )
    assert.equal(override.body.baseHash, matchRead.plan.planHash)
    assert.equal(override.body.projectBaseVersionId, projectVersionId)
    const overrideAnswer = await waitForAnswer(operator, '/color-match/overrides', fromOverride, 'the override')
    assert.equal(
      overrideAnswer.status, 409,
      `the override answered ${overrideAnswer.status} ${overrideAnswer.code ?? ''}: `
      + `${overrideAnswer.text.slice(0, 400)}
${serverLogs.slice(-2_000)}`,
    )
    assert.equal(
      overrideAnswer.code, 'PERSISTENCE_CONFLICT',
      `the override was refused as ${overrideAnswer.code} rather than for the compilation it needs`,
    )
    // And what the refusal left behind, which is not nothing.
    //
    // DEFECT, reported and not repaired here: `addMulticamMatchRangeOverride`
    // appends the new match-plan version and only then reads the ColorPlan
    // context (`multicam-color-match.ts:884-890`), so this 409 arrives after
    // the chain has already advanced. The derivation gets the same precondition
    // right — it reads the context first (`:531`) and refuses before writing
    // anything, which is why the plan was still v1 above. The remedy is to read
    // the context before the append, and the assertion below will fail when
    // somebody does, which is the point of writing down what is true now.
    const afterOverride = await read(`/v1/projects/${project}/capture-sessions/${session}/color-match`)
    assert.equal(
      afterOverride.versionRef, `${sessionId}:match:v2`,
      'the override was answered 409 and the match plan chain did not advance, which would mean the defect is fixed',
    )
    // The half this suite could never assert while the outcome sat inside an
    // `if (status < 400)`: the trecho the operator typed reached the stored
    // plan, rather than a correction that graded the whole camera.
    const scoped = afterOverride.plan.rangeOverrides.find(
      (entry) => entry.overrideId === override.body.override.overrideId,
    )
    assert.ok(scoped, 'the override reached the plan without the range the operator typed')
    assert.deepEqual(
      scoped.range, { start: '90000', end: '180000' },
      'the stored override says it covers the whole camera',
    )
    assert.equal(scoped.cameraId, gradedCamera)

    // Half a range is refused on screen rather than shipped as a 400. The
    // message stays up because the page never got as far as reloading.
    await page.getByTestId('override-range-end').fill('')
    const fromHalf = operator.requests.length
    await page.getByTestId('apply-override').click()
    await waitForText(
      page, 'color-message', /Preencha os dois instantes/,
      'half a range was accepted by the screen',
    )
    assert.equal(
      operator.requests.slice(fromHalf).filter((entry) => entry.url.endsWith('/overrides')).length, 0,
      'half a range was put on the wire',
    )

    mark('colour commands')
    // ---- the playback page ----------------------------------------------
    await page.goto(linkTo('/playback-map', reactSessionId))
    await page.getByTestId('playback-summary').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('playback-map-page').getAttribute('data-status'), 'needs-input')

    // The assertion this page exists for.
    for (const piece of unratedPieces) {
      assert.equal(
        (await page.getByTestId(`rate-${piece.pieceId}`).textContent())?.trim(),
        'não medida',
        'a piece with no measured rate was rendered with one',
      )
      assert.equal(
        (await page.getByTestId(`residual-${piece.pieceId}`).textContent())?.trim(),
        'não medido',
        'a piece with no residual was rendered with one',
      )
      assert.equal(
        (await page.getByTestId(`reference-${piece.pieceId}`).textContent())?.trim(),
        'a referência não andou',
        'a stretch where the reference produced no time was given an interval',
      )
      // Scoped to the row, not to the table: a piece the fingerprinter DID
      // measure at 1/1 is a measurement and belongs on screen. What must never
      // appear is that same string on a row where nothing was measured.
      const row = (await page.getByTestId(`piece-${piece.pieceId}`).textContent()) ?? ''
      assert.doesNotMatch(row, /1\/1/, 'a piece with no measured rate was rendered as 1/1')
    }
    // And a measured rate must still be shown as measured, or "não medida"
    // would be proved by a page that says it everywhere.
    const ratedPieces = pieceListing.pieces.filter((piece) => piece.rate !== null)
    assert.ok(ratedPieces.length > 0, 'the fixture must also carry pieces with a measured rate')
    for (const piece of ratedPieces) {
      assert.equal(
        (await page.getByTestId(`rate-${piece.pieceId}`).textContent())?.trim(),
        piece.rate,
        'a measured rate was not shown as the server measured it',
      )
    }

    await page.getByTestId('uncovered-0').waitFor({ state: 'visible' })
    await page.getByTestId('anchor-editor').waitFor({ state: 'visible' })

    mark('playback page read')
    // ---- the anchor command, end to end ----------------------------------
    // The button being enabled was the whole of the old assertion, which proves
    // nothing about the anchor. An anchor answers one stretch nobody could
    // measure: the map version has to advance, the list has to grow by exactly
    // one, and the stretch it answered has to close.
    const anchorsBefore = mapRead.map.anchors.length
    const uncoveredBefore = mapRead.map.uncovered.length
    await page.getByTestId('answer-0').click()
    await page.getByTestId('anchor-mode').selectOption('commentary-only')
    await page.getByTestId('anchor-note').fill('o reator falou por cima com o vídeo parado')
    const fromAnchor = operator.requests.length
    await page.getByTestId('add-anchor').click()
    const anchorRequest = await waitForPost(operator, '/playback-map/anchors', fromAnchor)
    assert.equal(
      anchorRequest.body.baseVersionId, pieceListing.versionRef,
      'the anchor named a map fence the page did not read',
    )
    assert.equal(
      anchorRequest.body.baseHash, pieceListing.map.mapHash,
      'the anchor named a map hash the page did not read',
    )
    assert.equal(anchorRequest.body.anchor.reactionTick, mapRead.map.uncovered[0].range.start)
    assert.equal(
      anchorRequest.body.anchor.referenceTick, null,
      'an absent reference instant has to be sent as null, not omitted',
    )
    assert.equal(anchorRequest.body.anchor.mode, 'commentary-only')
    const anchorAnswer = await waitForAnswer(operator, '/playback-map/anchors', fromAnchor, 'the anchor')
    assert.equal(
      anchorAnswer.status, 201,
      `the anchor command was refused: ${anchorAnswer.status} ${anchorAnswer.code ?? ''} ${anchorAnswer.text.slice(0, 300)}`,
    )

    const anchored = await read(
      `/v1/projects/${project}/capture-sessions/${reactSession}/playback-map?reactionTrackId=${reactor}`,
    )
    assert.equal(
      anchored.map.version, mapRead.map.version + 1,
      'the anchor was accepted and the map stayed on the same version',
    )
    assert.equal(
      anchored.map.anchors.length, anchorsBefore + 1,
      'the anchor list did not grow by exactly one',
    )
    assert.equal(
      anchored.map.uncovered.length, uncoveredBefore - 1,
      'the stretch the anchor answered is still unanswered',
    )
    const manualAnchor = anchored.map.anchors.find((entry) => entry.origin === 'manual')
    assert.ok(manualAnchor, 'the anchor a person placed came back without a manual origin')
    // And the screen followed the write rather than only reporting it.
    await page.getByTestId(`anchor-${manualAnchor.anchorId}`).waitFor({ state: 'visible' })

    mark('anchor command')
    // ---- the build-map command, end to end -------------------------------
    // The measurement itself, which no test in this repository had ever
    // issued. It is the only command on this page that opens the recordings,
    // and the two staged for it were never played one into the other — so the
    // honest answer is that nothing could be compared and a person has to place
    // the first anchor. What is asserted is that answer: the fence the page
    // carried, the code the server named, the sentence the operator was given,
    // and that the map a person had just anchored did not move.
    const reactorInput = await page.getByTestId('reactor-input').inputValue()
    assert.equal(
      reactorInput, playback.map.reactionTrackId,
      'the page did not name the reactor it had read, so the build would have asked about nothing',
    )
    const fromBuild = operator.requests.length
    await page.getByTestId('build-map').click()
    const buildRequest = await waitForPost(operator, '/playback-map', fromBuild)
    assert.equal(
      buildRequest.body.baseVersionId, `${reactSessionId}:v${playback.session.version}`,
      'the build named a session fence the page did not read',
    )
    assert.equal(
      buildRequest.body.baseHash, playback.session.sessionHash,
      'the build named a session hash the page did not read',
    )
    assert.equal(buildRequest.body.reactionTrackId, playback.map.reactionTrackId)
    assert.deepEqual(
      Object.keys(buildRequest.body).sort(), ['baseHash', 'baseVersionId', 'reactionTrackId'],
      'the build sent more than the session and the reactor, which is the whole of what it may send',
    )
    const buildAnswer = await waitForAnswer(operator, '/playback-map', fromBuild, 'the build')
    assert.equal(
      buildAnswer.status, 422,
      `the build answered ${buildAnswer.status} ${buildAnswer.code ?? ''}: `
      + `${buildAnswer.text.slice(0, 400)}
${serverLogs.slice(-2_000)}`,
    )
    assert.equal(
      buildAnswer.code, 'PLAYBACK_EVIDENCE_INSUFFICIENT',
      `the build was refused as ${buildAnswer.code} rather than for the evidence it could not find`,
    )
    await waitForText(page, 'playback-message', /.+/, 'the refused build said nothing on screen')
    const afterBuild = await read(
      `/v1/projects/${project}/capture-sessions/${reactSession}/playback-map?reactionTrackId=${reactor}`,
    )
    assert.equal(
      afterBuild.map.version, anchored.map.version,
      'a refused measurement replaced the map a person had answered',
    )
    assert.equal(afterBuild.map.mapHash, anchored.map.mapHash)

    mark('build-map command')
    // Cross navigation: each page carries its siblings, because the shell will
    // not carry them.
    for (const testId of ['link-capture-sessions', 'link-multicam-direction', 'link-color-match', 'link-sync-diagnostic']) {
      await page.getByTestId(testId).waitFor({ state: 'visible' })
    }

    // And the edge runs both ways. /sync-diagnostic used to be nominated as a
    // sibling by all three pages and carry no link back to any of them, so an
    // operator standing on the diagnostic could not reach the direction, the
    // colour or the playback of the session in front of them.
    await page.goto(linkTo('/sync-diagnostic', sessionId))
    await page.getByTestId('diagnostic-siblings').waitFor({ state: 'visible' })
    for (const [testId, route] of [
      ['link-capture-sessions', '/capture-sessions'],
      ['link-multicam-direction', '/multicam-direction'],
      ['link-color-match', '/color-match'],
      ['link-playback-map', '/playback-map'],
    ]) {
      const href = await page.getByTestId(testId).getAttribute('href')
      assert.ok(
        href?.startsWith(route),
        `the diagnostic did not link back to ${route}; it offered ${JSON.stringify(href)}`,
      )
      if (route !== '/capture-sessions') {
        assert.ok(
          href.includes(`sessao=${encodeURIComponent(sessionId)}`),
          `the diagnostic's link to ${route} dropped the session in front of the operator`,
        )
      }
    }

    mark('cross navigation')
    // ---- the two direction commands, end to end --------------------------
    // Last, because directing advances the project version and the colour
    // verdicts above are listed against the version that was current when they
    // were read.
    //
    // Two pages on purpose. A fence is only proved by a second reader that
    // still holds the superseded one, and the two refusals that matter — the
    // stale version and the repeated request — are both reachable only from
    // there. They arrive as the same 409 and need different answers.
    const stalePage = await context.newPage()
    const stale = channelFor(stalePage)
    await stalePage.goto(linkTo('/multicam-direction', sessionId))
    await stalePage.getByTestId('direction-summary').waitFor({ state: 'visible' })

    await page.goto(linkTo('/multicam-direction', sessionId))
    await page.getByTestId('direction-summary').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('direction-summary').getAttribute('data-version'), '1')

    const fromDirect = operator.requests.length
    await page.getByTestId('run-direction').click()
    const directRequest = await waitForPost(operator, '/direction', fromDirect)
    assert.equal(
      directRequest.body.baseVersionId, projectVersionId,
      'the direction named a project version the page did not read',
    )
    assert.equal(
      directRequest.body.baseHash, sha('2'),
      'the direction named a base hash the page did not read',
    )
    assert.deepEqual(directRequest.body.format, { aspectRatio: '16:9' })
    const directAnswer = await waitForAnswer(operator, '/direction', fromDirect, 'the direction')
    assert.equal(
      directAnswer.status, 201,
      `the direction command was refused: ${directAnswer.status} ${directAnswer.code ?? ''} `
      + `${directAnswer.text.slice(0, 400)}\n${serverLogs.slice(-3_000)}`,
    )
    assert.equal(directAnswer.data.replayed, false, 'a first cut was reported as a replay')

    await waitForAttribute(
      page, 'direction-summary', 'data-version', '2',
      'the session was directed and the direction chain did not advance',
    )
    const advanced = await read(`/v1/projects/${project}/workspace`)
    assert.notEqual(
      advanced.version.id, projectVersionId,
      'directing a session left the project version where it was',
    )
    assert.ok(
      ((await page.getByTestId('direction-fence').textContent()) ?? '').includes(advanced.version.id),
      'the page kept naming the version it directed against instead of the one that now exists',
    )

    // A stale fence. A different format gives this page a different idempotency
    // key, so what it meets is the version check rather than the stored answer.
    await stalePage.getByTestId('aspect-ratio').selectOption('9:16')
    const fromStale = stale.requests.length
    await stalePage.getByTestId('run-direction').click()
    const staleRequest = await waitForPost(stale, '/direction', fromStale)
    assert.equal(
      staleRequest.body.baseVersionId, projectVersionId,
      'the stale page sent a fence it never read',
    )
    const staleAnswer = await waitForAnswer(stale, '/direction', fromStale, 'the stale direction')
    assert.equal(staleAnswer.status, 409, 'a superseded project version was not refused')
    assert.equal(
      staleAnswer.code, 'VERSION_CONFLICT',
      `the stale fence produced ${staleAnswer.code} rather than a version conflict`,
    )
    await waitForText(
      stalePage, 'direction-message', /Recarregue antes de dirigir/,
      'a stale project version was not refused as one',
    )
    await stalePage.getByTestId('stale-conflict').waitFor({ state: 'visible' })
    assert.ok(
      ((await stalePage.getByTestId('stale-conflict').textContent()) ?? '').includes(advanced.version.id),
      'the refusal did not name the version the server is actually holding',
    )
    await stalePage.getByTestId('reload-direction').waitFor({ state: 'visible' })

    // The same request twice. Back on 16:9 this page rebuilds the exact key and
    // the exact payload the other one sent, so the server hands back the answer
    // it already gave instead of cutting the session a second time.
    await stalePage.getByTestId('aspect-ratio').selectOption('16:9')
    const fromReplay = stale.requests.length
    await stalePage.getByTestId('run-direction').click()
    const replayRequest = await waitForPost(stale, '/direction', fromReplay)
    assert.deepEqual(
      replayRequest.body, directRequest.body,
      'the repeat was not the same request, so a replay would prove nothing',
    )
    const replayAnswer = await waitForAnswer(stale, '/direction', fromReplay, 'the repeated direction')
    // 200 and `replayed: true`, not 201: the server handed back the answer it
    // already gave. The message the page shows for this is cleared by the
    // reload that follows it, so the status is what is asserted.
    assert.equal(
      replayAnswer.status, 200,
      `the repeated direction was answered ${replayAnswer.status} rather than replayed`,
    )
    assert.equal(replayAnswer.data.replayed, true, 'the repeated direction cut the session again')
    const afterReplay = await read(`/v1/projects/${project}/workspace`)
    assert.equal(
      afterReplay.version.id, advanced.version.id,
      'a replayed direction cut the session a second time',
    )

    // Both pages are on the same version again — the first because it reloaded
    // after directing, the second because a replay is a success and reloads
    // too. That is the state the repeated-request refusal needs.
    await waitForAttribute(
      stalePage, 'direction-summary', 'data-version', '2',
      'the replayed page did not come back to the direction that stands',
    )
    await page.getByTestId('protect-shot').selectOption({ index: 1 })
    const protectedShot = await page.getByTestId('protect-shot').inputValue()
    await page.getByTestId('protect-note').fill('a produção quer este ângulo neste plano')
    const fromProtect = operator.requests.length
    await page.getByTestId('submit-protect').click()
    const protectRequest = await waitForPost(operator, '/direction/protected-selections', fromProtect)
    assert.equal(
      protectRequest.body.baseVersionId, advanced.version.id,
      'the protected selection named a project version the page did not read',
    )
    assert.equal(protectRequest.body.baseHash, advanced.version.baseHash)
    assert.equal(protectRequest.body.protectedSelections.length, 1)
    assert.equal(
      protectRequest.body.protectedSelections[0].note, 'a produção quer este ângulo neste plano',
      'the operator\'s own words did not reach the request',
    )
    const protectAnswer = await waitForAnswer(
      operator, '/direction/protected-selections', fromProtect, 'the protected selection',
    )
    assert.equal(
      protectAnswer.status, 201,
      `the protected selection was refused: ${protectAnswer.status} ${protectAnswer.code ?? ''} ${protectAnswer.text.slice(0, 400)}`,
    )

    // The same key with different words. `protect-<shot>-<projectVersion>` does
    // not carry the note, so this collides with the request above on purpose —
    // and this is the 409 that a reload does not fix. It used to be reported as
    // "the project moved, reload", which sends the operator round a loop.
    await stalePage.getByTestId('protect-shot').selectOption(protectedShot)
    await stalePage.getByTestId('protect-note').fill('outro motivo, inteiramente diferente')
    const fromRepeat = stale.requests.length
    await stalePage.getByTestId('submit-protect').click()
    const repeatAnswer = await waitForAnswer(
      stale, '/direction/protected-selections', fromRepeat, 'the repeated protected selection',
    )
    assert.equal(repeatAnswer.status, 409, 'the same key with a different body was not refused')
    assert.equal(
      repeatAnswer.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      `the repeat produced ${repeatAnswer.code} rather than a payload mismatch`,
    )
    await waitForText(
      stalePage, 'direction-message', /já foi enviado com outro conteúdo/,
      'a repeated request with a different body was reported as a stale project version',
    )
    assert.equal(
      await stalePage.getByTestId('stale-conflict').count(), 0,
      'the repeated request offered a reload, which is not what fixes it',
    )
    mark('direction commands')
    await stalePage.close()

    console.log(
      `browser: ${unmeasuredCandidates.length} unmeasured coverages rendered as "não medida"; `
      + `${alternatives} losing angles each with the sentence that rejected them; `
      + `${unreadDimensions.length} unread critic dimensions as "não medido"; `
      + `${issueListing.issues.length} issues with measured-vs-threshold; `
      + `${unratedPieces.length} pieces with no rate and no reference interval; `
      + `${uncoveredBefore} uncovered stretch(es), ${uncoveredBefore - anchored.map.uncovered.length} answered `
      + `by an anchor driven through the page (map v${mapRead.map.version} -> v${anchored.map.version}); `
      + `the build-map command answered ${buildAnswer.status} ${buildAnswer.code} and left the map where it was; `
      + `the two colour commands answered ${deriveAnswer.status} ${deriveAnswer.code} and `
      + `${overrideAnswer.status} ${overrideAnswer.code}; `
      + `direction v1 -> v2 and project version ${projectVersionId} -> ${advanced.version.id}, `
      + 'with the replay, the stale fence and the repeated request each answered differently',
    )
  } finally {
    if (browser) await browser.close()
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // Reported, not rethrown: a cleanup failure that masks the real assertion
    // turns one clear defect into two confusing ones.
    try {
      await clean()
    } catch (error) {
      console.error('cleanup failed:', error?.message ?? error)
    } finally {
      await client.$disconnect()
      try {
        rmSync(artifactRoot, { recursive: true, force: true })
      } catch (error) {
        console.error('artifact root cleanup failed:', error?.message ?? error)
      }
    }
  }
})
