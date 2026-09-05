import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * The Wave 20 tables against a real PostgreSQL (F4.012 to F4.015).
 *
 * The structural suite (`wave20-persistence.test.mjs`) reads the migration as
 * text and proves the CHECK bodies name the domain's own constants. It cannot
 * prove they are constraints. Only a database can, and there is no database on
 * the machine this was written on: the CHECK and EXCLUDE bodies are parsed for
 * the first time when CI applies the migration, so everything below has never
 * been executed locally.
 *
 * Four things are checked here that no fake and no text search can check:
 *
 * - **The refusals are refusals.** A row that lies about a derived flag, an
 *   action that contradicts its cause, a measurement that is "unavailable" and
 *   still carries a number, a match plan that claims to run after the creative
 *   LUT, a paused piece that claims the reference advanced, a manual anchor
 *   whose evidence dropped the actor — each is offered to the database and
 *   each must come back rejected by the constraint that names it.
 * - **Two rows cannot claim one instant.** The EXCLUDE constraints are the only
 *   part of this schema Prisma cannot express, so they are also the only part
 *   nothing else would notice were missing.
 * - **BigInt ticks survive the driver.** A tick is 64-bit; a driver handing it
 *   back as a double would round it silently, and the value used here is past
 *   what a double represents exactly.
 * - **Workspace isolation is a foreign key, not a WHERE clause.** A child
 *   pointing at a parent in another workspace is refused by the composite key
 *   rather than by whoever remembered to filter.
 */

const RUN = process.env.APOLLO_WAVE20_PERSISTENCE_E2E === '1'

test(
  'E2E-FR-150/151/152/153 the Wave 20 constraints refuse what the domain refuses',
  { skip: RUN ? false : 'set APOLLO_WAVE20_PERSISTENCE_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )

    const client = new PrismaClient()
    const workspaceId = 'w20-persistence-workspace'
    const otherWorkspaceId = 'w20-persistence-other-workspace'
    const projectId = 'w20-persistence-project'
    const sessionId = 'w20-persistence-session'
    const versionId = 'w20-persistence-version'
    const directionId = `${sessionId}:m1`
    const mapId = `${sessionId}:p1`
    const planId = `${sessionId}:mp1`
    const measurementId = 'w20-measurement-camera-a'
    const hash = (char) => char.repeat(64)
    const at = (second) => new Date(Date.parse('2029-05-01T09:00:00.000Z') + second * 1_000)

    // 90 kHz for ten minutes is 54,000,000 ticks; this is past 2^53, where a
    // double stops counting by ones.
    const rangeStart = BigInt('9007199254740993')
    const rangeEnd = rangeStart + BigInt(54_000_000)

    const clean = async () => {
      for (const table of [
        client.v2ColorCriticProposedDelta, client.v2ColorCriticIssue,
        client.v2ColorCriticDimensionResult, client.v2ColorCriticReport,
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
        client.v2CaptureSessionHead,
      ]) {
        await table.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
      }
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId } })
      await client.v2Project.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
      await client.v2Workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
    }

    t.after(async () => {
      // Reported rather than rethrown: a cleanup failure that masks the real
      // assertion turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })

    await clean()

    /**
     * Offer a row the database must refuse, and prove which rule refused it.
     *
     * CHECK and EXCLUDE violations reach the driver as raw PostgreSQL messages
     * that name the constraint, so those are matched by name. Unique and
     * foreign-key violations are translated by Prisma into P2002/P2003, whose
     * message names the fields rather than the index, so those pass a wider
     * pattern — accepting "some unique constraint" would be too weak, which is
     * why the caller passes the alternative spelling rather than `.*`.
     */
    let refusals = 0
    const refused = async (evidence, write) => {
      let error = null
      try {
        await write()
      } catch (caught) {
        error = caught
      }
      assert.notEqual(error, null, `${evidence} accepted a row it must refuse`)
      assert.match(
        String(error?.message ?? ''),
        evidence instanceof RegExp ? evidence : new RegExp(evidence),
        `the row was refused, but not by ${evidence}`,
      )
      refusals += 1
    }

    const workspaces = new PrismaWorkspaceRepository(client)
    for (const id of [workspaceId, otherWorkspaceId]) {
      await workspaces.create(
        createWorkspace({ id, slug: id, name: 'Wave 20 persistence', status: 'active', createdAt: at(0).toISOString() }),
      )
    }
    for (const [id, workspace] of [[projectId, workspaceId], [`${projectId}-other`, otherWorkspaceId]]) {
      await client.v2Project.create({
        data: {
          id,
          workspaceId: workspace,
          name: 'Wave 20 persistence',
          status: 'reviewing-proxy',
          objective: 'discovery',
          format: '9:16',
          locale: 'pt-BR',
          createdByType: 'api-client',
          createdById: 'w20-persistence-client',
          createdAt: at(0),
          updatedAt: at(0),
        },
      })
    }
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `w20-snapshot-${kind}`,
          workspaceId,
          projectId,
          kind,
          schemaVersion: 1,
          contentJson: JSON.stringify({ kind }),
          contentHash: hash('1'),
          createdAt: at(0),
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: versionId,
        workspaceId,
        projectId,
        sequence: 1,
        briefSnapshotId: 'w20-snapshot-brief',
        editPlanSnapshotId: 'w20-snapshot-edit-plan',
        policiesSnapshotId: 'w20-snapshot-policies',
        baseHash: hash('2'),
        createdBy: 'w20-persistence-client',
        createdAt: at(0),
      },
    })
    for (const [id, workspace, project] of [
      [sessionId, workspaceId, projectId],
      [`${sessionId}-other`, otherWorkspaceId, `${projectId}-other`],
    ]) {
      await client.v2CaptureSessionHead.create({
        data: {
          id,
          workspaceId: workspace,
          projectId: project,
          sessionId: id,
          version: 1,
          sessionHash: hash('3'),
          status: 'synced',
          createdAt: at(0),
          updatedAt: at(0),
        },
      })
    }

    // ---------------------------------------------------------------------
    // F4.012 — direction
    // ---------------------------------------------------------------------

    const direction = {
      id: directionId,
      workspaceId,
      sessionId,
      schemaVersion: 'multicam-direction/v1',
      version: 1,
      previousVersionHash: null,
      sessionVersion: 1,
      referenceEpoch: 1,
      diagnosticVersion: 1,
      diagnosticHash: hash('4'),
      evidenceHash: hash('5'),
      rangeStartTicks: rangeStart,
      rangeEndTicks: rangeEnd,
      aspectRatio: '9:16',
      policyCalibrationVersion: 'multicam-direction-2026-09-v1',
      policyJson: JSON.stringify({ schemaVersion: 'direction-policy/v1' }),
      audioTrackId: 'track-master-audio',
      shotCount: 2,
      lowConfidenceShotCount: 0,
      uncoveredCount: 0,
      warningCount: 0,
      manualReviewRequired: false,
      generatedAt: at(10),
      directionHash: hash('6'),
      createdAt: at(10),
    }
    await client.v2MulticamDirection.create({ data: direction })

    const stored = await client.v2MulticamDirection.findUniqueOrThrow({ where: { id: directionId } })
    assert.equal(typeof stored.rangeStartTicks, 'bigint')
    assert.equal(stored.rangeStartTicks, rangeStart)
    assert.equal(stored.rangeEndTicks, rangeEnd)
    assert.equal(stored.rangeEndTicks - stored.rangeStartTicks, BigInt(54_000_000))

    // The chain is append-only and its version is unique per session: a second
    // writer that computed version 2 against the same head loses here, in the
    // index, rather than in whichever service remembered to look first.
    await refused(/Unique constraint|multicam_directions_workspaceId_sessionId_version_key/, () =>
      client.v2MulticamDirection.create({
        data: { ...direction, id: `${directionId}-duplicate`, directionHash: hash('7') },
      }))
    await refused('multicam_directions_chain_check', () =>
      client.v2MulticamDirection.create({
        data: {
          ...direction, id: `${directionId}-v2`, version: 2, previousVersionHash: null,
          directionHash: hash('8'),
        },
      }))
    // The derived flag cannot be told a different story from its evidence.
    await refused('multicam_directions_manual_review_check', () =>
      client.v2MulticamDirection.create({
        data: {
          ...direction, id: `${directionId}-lying`, version: 2, previousVersionHash: hash('6'),
          warningCount: 1, manualReviewRequired: false, directionHash: hash('9'),
        },
      }))

    const shot = (ordinal, startTicks, endTicks) => ({
      id: `${directionId}:${ordinal}`,
      workspaceId,
      directionId,
      sessionId,
      shotId: `shot-${ordinal}`,
      ordinal,
      schemaVersion: 'shot-decision/v1',
      sessionStartTicks: startTicks,
      sessionEndTicks: endTicks,
      trackId: 'track-camera-main',
      cameraId: 'camera-main',
      candidateId: `candidate-${ordinal}`,
      candidateHash: hash('a'),
      sourcePieceId: 'piece-1',
      audioTrackId: 'track-master-audio',
      rule: 'speech-prefers-active-speaker',
      reason: 'speech-prefers-active-speaker: camera-main carried the active speaker',
      evidenceRefsJson: JSON.stringify(['diagnostic:1', 'coverage:1']),
      evidenceRefCount: 2,
      evidenceRefsTruncated: 0,
      confidence: 0.9,
      confidenceBand: 'high',
      alternativeCount: 1,
      decisionHash: hash('b'),
    })
    const midpoint = rangeStart + BigInt(27_000_000)
    await client.v2MulticamShotDecision.create({ data: shot(0, rangeStart, midpoint) })
    // Half-open: a shot may start exactly where the previous one ended.
    await client.v2MulticamShotDecision.create({ data: shot(1, midpoint, rangeEnd) })
    await refused('multicam_shot_decisions_no_overlap_excl', () =>
      client.v2MulticamShotDecision.create({
        data: { ...shot(2, midpoint - BigInt(1), rangeEnd), shotId: 'shot-overlap' },
      }))
    // The band is the confidence, read through the policy's floors.
    await refused('multicam_shot_decisions_confidence_check', () =>
      client.v2MulticamShotDecision.create({
        data: { ...shot(3, rangeEnd, rangeEnd + BigInt(1_000)), shotId: 'shot-band', confidence: 0.2, confidenceBand: 'high' },
      }))
    // A truncation count with a citation that never reached the cap.
    await refused('multicam_shot_decisions_evidence_check', () =>
      client.v2MulticamShotDecision.create({
        data: {
          ...shot(4, rangeEnd, rangeEnd + BigInt(1_000)), shotId: 'shot-refs',
          evidenceRefCount: 2, evidenceRefsTruncated: 3,
        },
      }))

    const candidate = {
      id: `${directionId}:0:candidate-0`,
      workspaceId,
      shotId: `${directionId}:0`,
      directionId,
      candidateId: 'candidate-0',
      schemaVersion: 'angle-candidate/v1',
      trackId: 'track-camera-main',
      sourceAssetId: 'asset-camera-main',
      role: 'camera-main',
      context: 'speaker',
      sessionStartTicks: rangeStart,
      sessionEndTicks: midpoint,
      coverageAvailability: 'available',
      coverageConfidenceBps: 9_000,
      syncStatus: 'reference',
      syncConfidence: 1,
      sameAngleTicks: BigInt(0),
      spatialRelation: 'unknown',
      eligible: true,
      rejectionReasonsJson: JSON.stringify([]),
      rejectionCount: 0,
      scoreTotal: 1.35,
      candidateHash: hash('a'),
    }
    await client.v2MulticamAngleCandidate.create({ data: candidate })
    // ADR-118: eligibility is the emptiness of the rejection list, not a
    // second opinion about it.
    await refused('multicam_angle_candidates_eligible_check', () =>
      client.v2MulticamAngleCandidate.create({
        data: {
          ...candidate, id: `${directionId}:0:candidate-1`, candidateId: 'candidate-1',
          eligible: true, rejectionCount: 1,
          rejectionReasonsJson: JSON.stringify(['coverage-below-floor']),
        },
      }))
    await client.v2MulticamAngleScoreComponent.create({
      data: {
        id: `${candidate.id}:speaker`,
        workspaceId,
        candidateId: candidate.id,
        name: 'speaker',
        value: 1,
        evidenceRefsJson: JSON.stringify(['observation-1']),
        evidenceRefCount: 1,
      },
    })
    await refused('multicam_angle_score_components_name_check', () =>
      client.v2MulticamAngleScoreComponent.create({
        data: {
          id: `${candidate.id}:total`, workspaceId, candidateId: candidate.id,
          name: 'total', value: 1.35, evidenceRefCount: 0,
        },
      }))

    // A child may not reach across workspaces: the composite key is what says
    // so, not a filter somebody has to remember.
    await refused(/Foreign key constraint|multicam_shot_decisions_directionId_workspaceId_fkey/, () =>
      client.v2MulticamShotDecision.create({
        data: { ...shot(9, rangeStart, midpoint), id: 'cross-workspace-shot', workspaceId: otherWorkspaceId, sessionId: `${sessionId}-other` },
      }))

    // ---------------------------------------------------------------------
    // F4.013 — measurements and match plans
    // ---------------------------------------------------------------------

    const measurement = {
      id: measurementId,
      workspaceId,
      sessionId,
      schemaVersion: 'camera-color-measurement/v1',
      measurementId,
      sourceAssetId: 'asset-camera-main',
      sourceSha256: hash('c'),
      cameraId: 'camera-main',
      rangeStartTicks: rangeStart,
      rangeEndTicks: midpoint,
      sourceStartFrame: 0,
      sourceEndFrame: 120,
      sampledFrames: 12,
      pixelFormat: 'yuv420p',
      hdrMode: 'sdr',
      metadataJson: JSON.stringify({ primaries: 'bt709' }),
      comparable: true,
      confidence: 0.8,
      measuredDimensions: 8,
      measurementHash: hash('d'),
      createdAt: at(20),
    }
    await client.v2CameraColorMeasurement.create({ data: measurement })
    // Comparable means SDR bytes, enough frames and the four match dimensions
    // actually read. Two frames is a pair of stills.
    await refused('camera_color_measurements_comparable_check', () =>
      client.v2CameraColorMeasurement.create({
        data: {
          ...measurement, id: 'w20-measurement-thin', measurementId: 'w20-measurement-thin',
          sampledFrames: 2, measuredDimensions: 0, comparable: true, measurementHash: hash('e'),
        },
      }))

    await client.v2ColorMeasurementDimension.create({
      data: {
        id: `${measurementId}:exposure`,
        workspaceId,
        measurementId,
        dimension: 'exposure',
        status: 'measured',
        value: 0.42,
        unit: 'normalized-luma',
        evaluatorId: 'apollo-color-probe',
        evaluatorKind: 'measured',
        evaluatorVersion: 'v1',
        evidenceRef: 'probe-run-1',
      },
    })
    // Not measured is NULL, never 0: a zero here would be "we looked, and the
    // answer is nothing", which is a different sentence.
    await refused('color_measurement_dimensions_resolution_check', () =>
      client.v2ColorMeasurementDimension.create({
        data: {
          id: `${measurementId}:skin`, workspaceId, measurementId,
          dimension: 'skin', status: 'unavailable', value: 0,
          reason: 'no skin-band pixels were found in the sampled frames',
        },
      }))
    await refused('color_measurement_dimensions_unit_check', () =>
      client.v2ColorMeasurementDimension.create({
        data: {
          id: `${measurementId}:contrast`, workspaceId, measurementId,
          dimension: 'contrast', status: 'measured', value: 0.2, unit: 'degrees',
          evaluatorId: 'apollo-color-probe', evaluatorKind: 'measured',
          evaluatorVersion: 'v1', evidenceRef: 'probe-run-1',
        },
      }))

    const plan = {
      id: planId,
      workspaceId,
      projectId,
      sessionId,
      schemaVersion: 'multicam-match-plan/v1',
      planId,
      version: 1,
      previousVersionHash: null,
      sessionVersion: 1,
      referenceEpoch: 1,
      referenceCameraId: 'camera-main',
      selectedByKind: 'human',
      selectedById: 'operator-1',
      selectedAt: at(30),
      selectionBaseVersionId: `${sessionId}:v1`,
      selectionBaseHash: hash('3'),
      confidence: 0.75,
      pipelineStage: 'match',
      humanReviewRequired: false,
      transformCount: 1,
      issueCount: 0,
      reviewIssueCount: 0,
      lineageJson: JSON.stringify({ colorProbeIds: ['probe-run-1'] }),
      planHash: hash('f'),
      createdAt: at(30),
    }
    await client.v2MulticamMatchPlan.create({ data: plan })
    // F4.013 in the database: a match never runs after the creative LUT.
    await refused('multicam_match_plans_stage_check', () =>
      client.v2MulticamMatchPlan.create({
        data: { ...plan, id: `${planId}-late`, planId: `${planId}-late`, pipelineStage: 'creative-lut', planHash: hash('1') },
      }))
    await refused('multicam_match_plans_review_check', () =>
      client.v2MulticamMatchPlan.create({
        data: {
          ...plan, id: `${planId}-lying`, planId: `${planId}-lying`, planHash: hash('2'),
          issueCount: 1, reviewIssueCount: 1, humanReviewRequired: false,
        },
      }))

    await refused('camera_match_transforms_bounds_check', () =>
      client.v2CameraMatchTransform.create({
        data: {
          id: `${planId}:camera-alt`, workspaceId, planId, cameraId: 'camera-alt',
          transformId: 'match-camera-alt', provider: 'apollo-match', providerVersion: 'v2',
          mode: 'adjust', enabled: true,
          parametersJson: JSON.stringify({ mode: 'adjust' }),
          deltasJson: JSON.stringify({}),
          brightness: 0.1, contrast: 1.05, saturation: 1.02,
          // A channel gain of four is a grade, not a white balance.
          redGain: 4, greenGain: 1, blueGain: 1,
          derivedFromJson: JSON.stringify([measurementId]), derivedFromCount: 1,
          rangePairs: 1, confidence: 0.7,
        },
      }))

    // ---------------------------------------------------------------------
    // F4.014 — the colour critic
    // ---------------------------------------------------------------------

    const report = {
      id: 'w20-critic-report',
      workspaceId,
      projectId,
      projectVersionId: versionId,
      schemaVersion: 'color-critic-report/v1',
      reportId: 'w20-critic-report',
      subjectKind: 'camera',
      subjectCameraId: 'camera-main',
      referenceCameraId: 'camera-main',
      matchPlanId: planId,
      matchPlanHash: hash('f'),
      sectionCount: 2,
      sectionsJson: JSON.stringify([{ stage: 'before-output-transform' }, { stage: 'after-output-transform' }]),
      evaluatorsJson: JSON.stringify([{ id: 'apollo-color-critic' }]),
      dimensionCount: 12,
      unavailableDimensionCount: 0,
      issueCount: 0,
      hardIssueCount: 0,
      insufficientEvidenceCount: 0,
      creativeIntentDeclared: false,
      creativeIntentJson: JSON.stringify({ declared: false }),
      castAllowedDelta: null,
      maxDeclaredCastAllowance: 0.25,
      cause: 'no-defect',
      action: 'approve',
      proposedDeltaCount: 0,
      confidence: 0.9,
      confidenceBand: 'high',
      thresholdVersion: 'color-critic-thresholds/v1',
      thresholdsJson: JSON.stringify({ calibrationVersion: 'color-critic-thresholds/v1' }),
      evaluatedAt: at(40),
      reportHash: hash('3'),
      createdAt: at(40),
    }
    await client.v2ColorCriticReport.create({ data: report })
    // ADR-147's cause table is a lookup, not an average: 'no-defect' has
    // exactly one action and it is not 'reject'.
    await refused('color_critic_reports_cause_action_check', () =>
      client.v2ColorCriticReport.create({
        data: { ...report, id: 'w20-critic-mismatch', reportId: 'w20-critic-mismatch', action: 'reject', reportHash: hash('4') },
      }))
    // Nothing is approved while a dimension went unread.
    await refused('color_critic_reports_verdict_check', () =>
      client.v2ColorCriticReport.create({
        data: {
          ...report, id: 'w20-critic-unread', reportId: 'w20-critic-unread',
          unavailableDimensionCount: 1, reportHash: hash('5'),
        },
      }))
    // A bounded correction exists exactly when the verdict is one, and only
    // above the confidence floor.
    await refused('color_critic_reports_correction_check', () =>
      client.v2ColorCriticReport.create({
        data: {
          ...report, id: 'w20-critic-correction', reportId: 'w20-critic-correction',
          cause: 'correctable-technical-defect', action: 'bounded-correction',
          correctionIteration: 3, correctionMaxIterations: 2, proposedDeltaCount: 1,
          correctionReason: 'exposure is 0.6 EV under the reference', reportHash: hash('6'),
        },
      }))

    // ---------------------------------------------------------------------
    // F4.015 — react playback
    // ---------------------------------------------------------------------

    const reactionDuration = BigInt(90_000) * BigInt(600)
    const map = {
      id: mapId,
      workspaceId,
      sessionId,
      schemaVersion: 'react-playback-map/v1',
      mapId,
      version: 1,
      previousVersionHash: null,
      sessionVersion: 1,
      referenceEpoch: 1,
      reactionTrackId: 'track-reaction',
      referenceTrackId: 'track-reference-video',
      referenceAssetId: 'asset-reference',
      referenceSha256: hash('7'),
      referenceDurationTicks: BigInt(48_000) * BigInt(300),
      referenceTimebaseNum: BigInt(1),
      referenceTimebaseDen: BigInt(48_000),
      reactionAssetId: 'asset-reaction',
      reactionSha256: hash('8'),
      reactionDurationTicks: reactionDuration,
      status: 'resolved',
      warningsJson: JSON.stringify([]),
      pieceCount: 2,
      referencedPieceCount: 1,
      uncoveredCount: 0,
      anchorCount: 1,
      manualAnchorCount: 1,
      mapHash: hash('9'),
      createdAt: at(50),
    }
    await client.v2PlaybackMap.create({ data: map })
    // The status is derived: uncovered stretches mean a person is needed.
    await refused('playback_maps_status_check', () =>
      client.v2PlaybackMap.create({
        data: { ...map, id: `${mapId}-lying`, mapId: `${mapId}-lying`, uncoveredCount: 1, mapHash: hash('a') },
      }))

    const half = reactionDuration / BigInt(2)
    await client.v2PlaybackPiece.create({
      data: {
        id: `${mapId}:0`, workspaceId, mapId, pieceId: 'piece-0', ordinal: 0, mode: 'playing',
        reactionStartTicks: BigInt(0), reactionEndTicks: half,
        referenceStartTicks: BigInt(0), referenceEndTicks: BigInt(48_000) * BigInt(150),
        rateNum: BigInt(1), rateDen: BigInt(1), direction: 'forward', confidence: 0.9,
        evidenceRefsJson: JSON.stringify(['fingerprint-1']), evidenceRefCount: 1,
        detectionMethod: 'audio-fingerprint', residualTicks: BigInt(12),
        discontinuityReason: null, pieceHash: hash('b'),
      },
    })
    await client.v2PlaybackPiece.create({
      data: {
        id: `${mapId}:1`, workspaceId, mapId, pieceId: 'piece-1', ordinal: 1, mode: 'paused',
        reactionStartTicks: half, reactionEndTicks: reactionDuration,
        referenceStartTicks: null, referenceEndTicks: null, rateNum: null, rateDen: null,
        direction: 'none', confidence: 0.8,
        evidenceRefsJson: JSON.stringify(['player-visual-1']), evidenceRefCount: 1,
        detectionMethod: 'player-visual', residualTicks: null,
        discontinuityReason: 'pause', pieceHash: hash('c'),
      },
    })
    // ADR-135: a paused piece that names a reference range asserts the
    // reference advanced while it was stopped.
    await refused('playback_pieces_reference_check', () =>
      client.v2PlaybackPiece.create({
        data: {
          id: `${mapId}:2`, workspaceId, mapId, pieceId: 'piece-2', ordinal: 2, mode: 'paused',
          reactionStartTicks: reactionDuration, reactionEndTicks: reactionDuration + BigInt(1_000),
          referenceStartTicks: BigInt(0), referenceEndTicks: BigInt(1_000),
          rateNum: null, rateDen: null, direction: 'none', confidence: 0.5,
          evidenceRefCount: 1, detectionMethod: 'player-visual',
          discontinuityReason: 'pause', pieceHash: hash('d'),
        },
      }))
    // A rate is a measured slope, and a person placing an anchor measures none.
    await refused('playback_pieces_rate_check', () =>
      client.v2PlaybackPiece.create({
        data: {
          id: `${mapId}:3`, workspaceId, mapId, pieceId: 'piece-3', ordinal: 3, mode: 'playing',
          reactionStartTicks: reactionDuration, reactionEndTicks: reactionDuration + BigInt(1_000),
          referenceStartTicks: BigInt(0), referenceEndTicks: BigInt(1_000),
          rateNum: BigInt(1), rateDen: BigInt(1), direction: 'forward', confidence: 0.5,
          evidenceRefCount: 1, detectionMethod: 'manual-anchor',
          discontinuityReason: 'manual-anchor', pieceHash: hash('e'),
        },
      }))
    await refused('playback_pieces_no_overlap_excl', () =>
      client.v2PlaybackPiece.create({
        data: {
          id: `${mapId}:4`, workspaceId, mapId, pieceId: 'piece-4', ordinal: 4, mode: 'playing',
          reactionStartTicks: half - BigInt(1), reactionEndTicks: reactionDuration,
          referenceStartTicks: BigInt(0), referenceEndTicks: BigInt(1_000),
          rateNum: null, rateDen: null, direction: 'forward', confidence: 0.5,
          evidenceRefCount: 1, detectionMethod: 'player-visual',
          discontinuityReason: 'seek', pieceHash: hash('f'),
        },
      }))

    await client.v2PlaybackAnchor.create({
      data: {
        id: `${mapId}:anchor-1`, workspaceId, mapId, anchorId: 'anchor-1', origin: 'manual',
        reactionTick: half, referenceTick: null, mode: 'commentary-only', method: 'manual-anchor',
        confidence: 0.9, evidenceRef: 'operator:operator-1 (the player was off screen)',
        actorKind: 'human', actorId: 'operator-1', note: 'the player was off screen',
        createdAt: at(60),
      },
    })
    // CONTRACT §2: the note never displaces the actor. An evidence string that
    // dropped the operator records who was inconvenienced, not who moved it.
    await refused('playback_anchors_actor_check', () =>
      client.v2PlaybackAnchor.create({
        data: {
          id: `${mapId}:anchor-2`, workspaceId, mapId, anchorId: 'anchor-2', origin: 'manual',
          reactionTick: half, referenceTick: null, mode: 'commentary-only', method: 'manual-anchor',
          confidence: 0.9, evidenceRef: 'the player was off screen',
          actorKind: 'human', actorId: 'operator-1', note: 'the player was off screen',
          createdAt: at(60),
        },
      }))

    // ---------------------------------------------------------------------
    // Deleting an aggregate takes its children and nothing else.
    // ---------------------------------------------------------------------

    assert.equal(await client.v2MulticamAngleScoreComponent.count({ where: { workspaceId } }), 1)
    await client.v2MulticamDirection.delete({ where: { id: directionId } })
    assert.equal(await client.v2MulticamShotDecision.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2MulticamAngleCandidate.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2MulticamAngleScoreComponent.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2CameraColorMeasurement.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2PlaybackPiece.count({ where: { workspaceId } }), 2)

    console.log(
      `wave20 persistence: tick ${rangeStart} survived the driver, ` +
        `${await client.v2PlaybackPiece.count({ where: { workspaceId } })} playback pieces kept ` +
        `after the direction cascade, ${refusals} refusals confirmed`,
    )
  },
)
