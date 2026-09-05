import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
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
  const fixtures = await import('./wave20-fixtures.mjs')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `w20-ui-${suffix}`
  const projectId = `w20-ui-project-${suffix}`
  const sessionId = `w20-ui-session-${suffix}`
  const reactSessionId = `w20-ui-react-${suffix}`
  const projectVersionId = `w20-ui-version-${suffix}`
  const reportId = `w20-ui-report-${suffix}`
  const uiUsername = `w20-ui-user-${suffix}`
  const uiPassword = `Wave20-Operator-${suffix}-secure`
  const createdAt = new Date('2029-08-01T09:00:00.000Z')
  const at = (second) => new Date(createdAt.getTime() + second * 1_000)
  const sec = fixtures.fixtureSeconds
  const instant = fixtures.fixtureInstant
  const sha = fixtures.fixtureSha
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
      client.v2EditCommand, client.v2ProjectVersion, client.v2ProjectSnapshot,
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
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `w20-ui-snapshot-${kind}-${suffix}`, workspaceId, projectId, kind,
          schemaVersion: 1, contentJson: JSON.stringify({ kind }), contentHash: sha('1'),
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
    const sessions = new PrismaCaptureSessionRepository(client)
    const world = fixtures.buildDirectableMulticamWorld({ workspaceId, sessionId, projectId })
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
        speaks('track-mic-a', 1, 120),
        speaks('track-mic-b', 120, 250),
        speaks('track-mic-a', 250, 300),
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
    const playback = fixtures.buildPlaybackWorld({
      workspaceId, sessionId: reactSessionId, projectId,
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
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization } })
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
    const page = await context.newPage()

    const linkTo = (route, id) =>
      `${baseUrl}${route}?projeto=${encodeURIComponent(projectId)}&sessao=${encodeURIComponent(id)}`

    await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/capture-sessions')}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL('**/capture-sessions**')

    // Every one of the three pages is reachable from the session list; the
    // shell has a fixed set of destinations and none of these is one of them,
    // so a broken link here means the page cannot be found at all.
    for (const testId of ['open-multicam-direction', 'open-color-match', 'open-playback-map']) {
      await page.getByTestId(testId).waitFor({ state: 'visible' })
    }

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
      assert.ok(
        issueText.includes(issue.measured.toFixed(3)),
        `the issue ${issue.code} was shown without the number that was measured`,
      )
      assert.ok(
        issueText.includes(issue.threshold.toFixed(3)),
        `the issue ${issue.code} was shown without the threshold that bounded it`,
      )
    }

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
    }
    const pieceTable = (await page.getByTestId('pieces').textContent()) ?? ''
    assert.doesNotMatch(pieceTable, /1\/1/, 'an unmeasured rate was rendered as 1/1 somewhere in the table')

    await page.getByTestId('uncovered-0').waitFor({ state: 'visible' })
    await page.getByTestId('anchor-editor').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('add-anchor').isEnabled(), true,
      'the map has an unanswered stretch and the editor refused to offer an anchor')

    // Cross navigation: each page carries its siblings, because the shell will
    // not carry them.
    for (const testId of ['link-capture-sessions', 'link-multicam-direction', 'link-color-match', 'link-sync-diagnostic']) {
      await page.getByTestId(testId).waitFor({ state: 'visible' })
    }

    console.log(
      `browser: ${unmeasuredCandidates.length} unmeasured coverages rendered as "não medida"; `
      + `${alternatives} losing angles each with the sentence that rejected them; `
      + `${unreadDimensions.length} unread critic dimensions as "não medido"; `
      + `${issueListing.issues.length} issues with measured-vs-threshold; `
      + `${unratedPieces.length} pieces with no rate and no reference interval; `
      + `${mapRead.map.uncovered.length} uncovered stretch(es) answerable by anchor`,
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
    }
  }
})
