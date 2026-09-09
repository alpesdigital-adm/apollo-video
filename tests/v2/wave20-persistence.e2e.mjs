import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * The Wave 20 tables against a real PostgreSQL (F4.012 to F4.015).
 *
 * The structural suite (`wave20-persistence.test.mjs`) reads the migration as
 * text and proves the CHECK bodies name the domain's own constants. It cannot
 * prove they are constraints. Only a database can. When this was written there
 * was none on the machine and everything below had run only in CI; the three
 * tests have since been executed against a throwaway PostgreSQL 16 cluster
 * migrated from empty, and CI remains the reference measurement.
 *
 * Five things are checked here that no fake and no text search can check:
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
 * - **What "immutable history" means here, measured rather than asserted.**
 *   The third test below reads the catalogue and then deletes a version row,
 *   because the phrase covers an UPDATE and does not cover a DELETE, and the
 *   difference belongs in a number rather than in prose.
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
    // The ColorMetadata a match transform declares on both sides of itself
    // (color-and-export.ts:16-23). Rec.709 limited-range 8-bit is the plain
    // case; nothing here is testing the metadata, it is testing that a
    // transform row carries a whole transform.
    const colorMetadata = {
      colorSpace: 'bt709', transfer: 'bt709', primaries: 'bt709',
      matrix: 'bt709', range: 'limited', bitDepth: 8,
    }

    // 90 kHz for ten minutes is 54,000,000 ticks; this is past 2^53, where a
    // double stops counting by ones.
    const rangeStart = BigInt('9007199254740993')
    const rangeEnd = rangeStart + BigInt(54_000_000)

    const clean = async () => {
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
      policyCalibrationVersion: 'multicam-direction-2026-09-v2',
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
      ordinal: 0,
      eligible: true,
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
      // The four readings the candidate hash covers, in the shape
      // `candidateEvidenceOf` writes (multicam-direction-repository.ts:101).
      // NOT NULL with the default dropped: a row without it never reaches a
      // CHECK, it is refused by the ORM, and every refusal below would then
      // assert against an argument error instead of the constraint it names.
      evidenceJson: JSON.stringify({
        activeSpeaker: { score: 0.82, observationRefs: ['observation-1'] },
        screenActivity: { score: 0.1, observationRefs: [] },
        reaction: { score: 0.3, observationRefs: ['observation-1'] },
        technicalQuality: { score: 0.95, observationRefs: [] },
      }),
      scoreTotal: 1.35,
      candidateHash: hash('a'),
    }
    await client.v2MulticamAngleCandidate.create({ data: candidate })
    // ADR-118: a REJECTED angle is a row here, and this is the row the phase-2
    // schema could not hold. It carries the reasons the domain gave, and the
    // count is the length of that list.
    const rejectedCandidate = {
      ...candidate,
      id: `${directionId}:0:candidate-1`,
      candidateId: 'candidate-1',
      ordinal: 1,
      trackId: 'track-camera-alt',
      sourceAssetId: 'asset-camera-alt',
      role: 'camera-alt',
      coverageAvailability: 'gap',
      coverageConfidenceBps: null,
      syncStatus: 'partial',
      syncConfidence: 0.4,
      eligible: false,
      rejectionReasonsJson: JSON.stringify(['coverage-gap', 'sync-below-threshold']),
      rejectionCount: 2,
      candidateHash: hash('b'),
    }
    await client.v2MulticamAngleCandidate.create({ data: rejectedCandidate })
    // Eligibility IS the emptiness of the list, and the count IS its length.
    // Neither half can be nudged on its own.
    await refused('multicam_angle_candidates_eligibility_check', () =>
      client.v2MulticamAngleCandidate.create({
        data: { ...rejectedCandidate, id: `${directionId}:0:candidate-2`, candidateId: 'candidate-2', ordinal: 2, eligible: true },
      }))
    await refused('multicam_angle_candidates_eligibility_check', () =>
      client.v2MulticamAngleCandidate.create({
        data: { ...rejectedCandidate, id: `${directionId}:0:candidate-3`, candidateId: 'candidate-3', ordinal: 3, rejectionCount: 1 },
      }))
    // Two candidates of one shot cannot claim one position in the list the shot
    // hash covers.
    await refused('multicam_angle_candidates_workspaceId_shotId_ordinal_key', () =>
      client.v2MulticamAngleCandidate.create({
        data: { ...rejectedCandidate, id: `${directionId}:0:candidate-4`, candidateId: 'candidate-4', candidateHash: hash('c') },
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
          // The transform the projected columns are a projection OF. Without
          // it the row never reaches a CHECK — Prisma refuses the call for a
          // missing required argument, and `refused()` would be asserting
          // against an ORM message rather than against
          // camera_match_transforms_bounds_check. It agrees with `provider`,
          // `providerVersion`, `parametersJson` and `enabled` on purpose, so
          // the only thing left to refuse is the channel gain of four.
          transformJson: JSON.stringify({
            id: 'match-camera-alt',
            kind: 'match',
            version: 'v1',
            enabled: true,
            input: colorMetadata,
            output: colorMetadata,
            implementation: {
              provider: 'apollo-match',
              version: 'v2',
              parameters: { mode: 'adjust' },
              parametersHash: hash('9'),
            },
          }),
          parametersJson: JSON.stringify({ mode: 'adjust' }),
          deltasJson: JSON.stringify({}),
          brightness: 0.1, contrast: 1.05, saturation: 1.02,
          // A channel gain of four is a grade, not a white balance.
          redGain: 4, greenGain: 1, blueGain: 1,
          derivedFromJson: JSON.stringify([measurementId]), derivedFromCount: 1,
          rangePairs: 1, confidence: 0.7,
        },
      }))

    // A transform document that simply OMITS the implementation. Before the
    // COALESCE wrappers every one of those equalities was NULL here, and a
    // CHECK is satisfied by unknown: the row that carried no provider at all
    // was accepted while the row that carried the wrong one was refused.
    await refused('camera_match_transforms_transform_check', () =>
      client.v2CameraMatchTransform.create({
        data: {
          id: `${planId}:camera-hollow`, workspaceId, planId, cameraId: 'camera-hollow',
          transformId: 'match-camera-hollow', provider: 'apollo-match', providerVersion: 'v2',
          mode: 'adjust', enabled: true,
          transformJson: JSON.stringify({ id: 'match-camera-hollow', kind: 'match' }),
          parametersJson: JSON.stringify({ mode: 'adjust' }),
          deltasJson: JSON.stringify({}),
          brightness: 0.1, contrast: 1.05, saturation: 1.02,
          redGain: 1, greenGain: 1, blueGain: 1,
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
    // A cause outside ADR-147's table. The CASE that looks the action up
    // returns NULL for a cause it does not list, and `action = NULL` is
    // unknown, which a CHECK accepts — so this pair was stored until the two
    // vocabularies were closed in front of the lookup.
    await refused('color_critic_reports_cause_action_check', () =>
      client.v2ColorCriticReport.create({
        data: {
          ...report, id: 'w20-critic-unknown-cause', reportId: 'w20-critic-unknown-cause',
          cause: 'not-a-real-cause', action: 'reject', reportHash: hash('8'),
        },
      }))
    // An action outside COLOR_CRITIC_ACTIONS. The lookup alone already refused
    // this one — the CASE cannot return 'banana' — so this row exercises the
    // closed action set rather than proving it; the set is what makes the
    // column's vocabulary readable in the schema instead of implied by a CASE.
    await refused('color_critic_reports_cause_action_check', () =>
      client.v2ColorCriticReport.create({
        data: {
          ...report, id: 'w20-critic-unknown-action', reportId: 'w20-critic-unknown-action',
          action: 'banana', reportHash: hash('b'),
        },
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
        id: `${mapId}:anchor-1`, workspaceId, mapId, anchorId: 'anchor-1', ordinal: 0,
        origin: 'manual',
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
          id: `${mapId}:anchor-2`, workspaceId, mapId, anchorId: 'anchor-2', ordinal: 1,
          origin: 'manual',
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

test(
  'E2E-FR-150/151/152/153 the Wave 20 repositories hand back the aggregate that was stored',
  { skip: RUN ? false : 'set APOLLO_WAVE20_PERSISTENCE_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { stringifyWithTicks } = await import('../../src/v2/infrastructure/prisma/bigint-json.ts')
    const { calculateMulticamDirectionHash } = await import('../../src/v2/domain/multicam-direction.ts')
    const { calculateMulticamMatchPlanHash } = await import('../../src/v2/domain/multicam-match-plan.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )
    const { PrismaMulticamDirectionRepository } = await import(
      '../../src/v2/infrastructure/prisma/multicam-direction-repository.ts'
    )
    const {
      PrismaCameraColorMeasurementRepository,
      PrismaMulticamMatchPlanRepository,
    } = await import('../../src/v2/infrastructure/prisma/multicam-match-plan-repository.ts')
    const { PrismaColorCriticReportRepository } = await import(
      '../../src/v2/infrastructure/prisma/color-critic-report-repository.ts'
    )
    const { PrismaPlaybackMapRepository } = await import(
      '../../src/v2/infrastructure/prisma/playback-map-repository.ts'
    )
    const {
      anchorPlaybackMap,
      buildCriticReport,
      buildDirectionWorld,
      buildMatchWorld,
      buildPlaybackWorld,
    } = await import('./wave20-fixtures.mjs')

    const client = new PrismaClient()
    const A = 'w20r-workspace-a'
    const B = 'w20r-workspace-b'
    // The same session id in both workspaces on purpose: an isolation check
    // whose two rows could not have collided anyway proves only that two
    // different keys are different.
    const SESSION = 'w20r-session'
    const REACT = 'w20r-react'
    const REACTION_TRACK = 'track-reaction'
    const project = (workspace) => (workspace === A ? 'w20r-project-a' : 'w20r-project-b')
    const version = (workspace) => (workspace === A ? 'w20r-version-a' : 'w20r-version-b')
    const at = (second) => new Date(Date.parse('2029-05-02T09:00:00.000Z') + second * 1_000)
    const digest = (character) => character.repeat(64)

    const clean = async () => {
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
        client.v2CaptureSessionHead,
      ]) {
        await table.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      }
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2Project.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2Workspace.deleteMany({ where: { id: { in: [A, B] } } })
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

    const workspaces = new PrismaWorkspaceRepository(client)
    for (const id of [A, B]) {
      await workspaces.create(createWorkspace({
        id, slug: id, name: 'Wave 20 round trip', status: 'active', createdAt: at(0).toISOString(),
      }))
      await client.v2Project.create({
        data: {
          id: project(id),
          workspaceId: id,
          name: 'Wave 20 round trip',
          status: 'reviewing-proxy',
          objective: 'discovery',
          format: '16:9',
          locale: 'pt-BR',
          createdByType: 'api-client',
          createdById: 'w20r-client',
          createdAt: at(0),
          updatedAt: at(0),
        },
      })
      for (const kind of ['brief', 'edit-plan', 'policies']) {
        await client.v2ProjectSnapshot.create({
          data: {
            id: `${version(id)}-${kind}`,
            workspaceId: id,
            projectId: project(id),
            kind,
            schemaVersion: 1,
            contentJson: JSON.stringify({ kind }),
            contentHash: digest('1'),
            createdAt: at(0),
          },
        })
      }
      await client.v2ProjectVersion.create({
        data: {
          id: version(id),
          workspaceId: id,
          projectId: project(id),
          sequence: 1,
          briefSnapshotId: `${version(id)}-brief`,
          editPlanSnapshotId: `${version(id)}-edit-plan`,
          policiesSnapshotId: `${version(id)}-policies`,
          baseHash: digest('2'),
          createdBy: 'w20r-client',
          createdAt: at(0),
        },
      })
      for (const sessionId of [SESSION, REACT]) {
        await client.v2CaptureSessionHead.create({
          data: {
            id: `${id}:${sessionId}`,
            workspaceId: id,
            projectId: project(id),
            sessionId,
            version: 1,
            sessionHash: digest('3'),
            status: 'synced',
            createdAt: at(0),
            updatedAt: at(0),
          },
        })
      }
    }

    /** Byte-identity, not "looks the same": the canonical bytes and the shape. */
    const identical = (stored, built, what) => {
      assert.equal(stringifyWithTicks(stored), stringifyWithTicks(built), `${what} did not survive the round trip`)
      assert.deepEqual(stored, built, `${what} came back structurally different`)
    }
    const refusedOnRead = async (read, what) => {
      await assert.rejects(read, (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT', `${what}: ${error.code} — ${error.message}`)
        return true
      }, `${what} was believed after being edited underneath`)
    }

    // -----------------------------------------------------------------
    // F4.012 — multicam evidence and direction
    // -----------------------------------------------------------------

    const directions = new PrismaMulticamDirectionRepository(client)
    const worldA = buildDirectionWorld({ workspaceId: A, sessionId: SESSION, projectId: project(A) })
    const worldB = buildDirectionWorld({ workspaceId: B, sessionId: SESSION, projectId: project(B) })

    // The fixture is the unhealthy one: the cameras stop before the directed
    // range does, so this is not the happy path a naive mapping also survives.
    assert.ok(worldA.direction.uncovered.length >= 1, 'the direction fixture must carry an uncovered stretch')
    assert.ok(worldA.direction.manualReviewRequired, 'the direction fixture must need a person')
    assert.ok(
      worldA.direction.shots.some((shot) => shot.chosen.activeSpeaker !== null),
      'the direction fixture must cite speaker evidence on at least one shot',
    )
    assert.ok(
      worldA.direction.shots.some((shot) => shot.chosen.activeSpeaker === null),
      'and must have one shot decided with none, so both evidence shapes are stored',
    )

    const firstEvidence = await directions.persistEvidenceSet({
      set: worldA.evidence, createdAt: at(1).toISOString(),
    })
    assert.equal(firstEvidence.replayed, false)
    const replayedEvidence = await directions.persistEvidenceSet({
      set: worldA.evidence, createdAt: at(2).toISOString(),
    })
    assert.equal(replayedEvidence.replayed, true, 'the same evidence written twice is one set')
    identical(
      await directions.readEvidenceSet({ workspaceId: A, evidenceHash: worldA.evidence.evidenceHash }),
      worldA.evidence,
      'the evidence set',
    )
    assert.equal(
      await directions.readEvidenceSet({ workspaceId: B, evidenceHash: worldA.evidence.evidenceHash }),
      null,
      'workspace B could read workspace A evidence by its hash',
    )

    const storedDirection = await directions.appendVersion({
      direction: worldA.direction, base: null, occurredAt: at(3).toISOString(),
    })
    assert.equal(storedDirection.replayed, false)
    assert.equal(storedDirection.stored.version, 1)
    identical(storedDirection.stored.direction, worldA.direction, 'direction version 1')

    const replayedDirection = await directions.appendVersion({
      direction: worldA.direction, base: null, occurredAt: at(4).toISOString(),
    })
    assert.equal(replayedDirection.replayed, true, 'the same direction written twice is one version')

    // A second version of the same direction: the same decisions, generated a
    // second later, so the body and the hash differ while nothing else does.
    // It has to be a different body: the chain is unique on (workspace, hash),
    // so re-offering version 1's bytes as version 2 is refused by the index
    // before the head fence is ever consulted.
    const laterBody = (() => {
      const { directionHash, ...body } = worldA.direction
      const moved = { ...body, generatedAt: new Date(Date.parse(body.generatedAt) + 1_000).toISOString() }
      return Object.freeze({ ...moved, directionHash: calculateMulticamDirectionHash(moved) })
    })()
    assert.notEqual(laterBody.directionHash, worldA.direction.directionHash)

    // The fence is the pair, not the number. A writer that names the right
    // version and the wrong hash was looking at a document that no longer
    // exists, and a version-only fence would have let it through.
    await assert.rejects(
      () => directions.appendVersion({
        direction: laterBody,
        base: { version: 1, directionHash: digest('9') },
        occurredAt: at(5).toISOString(),
      }),
      (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT')
        assert.equal(error.details.currentVersion, 1, 'the loser is told which version is current')
        assert.equal(error.details.currentHash, worldA.direction.directionHash, 'and which hash')
        return true
      },
      'a stale base hash advanced the direction head',
    )
    assert.equal(
      await directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 2 }),
      null,
      'the refused append left a version 2 behind',
    )
    const advanced = await directions.appendVersion({
      direction: laterBody,
      base: { version: 1, directionHash: worldA.direction.directionHash },
      occurredAt: at(6).toISOString(),
    })
    assert.equal(advanced.stored.version, 2)
    assert.equal(advanced.stored.previousVersionHash, worldA.direction.directionHash)
    identical(
      (await directions.readHead({ workspaceId: A, sessionId: SESSION })).direction,
      laterBody,
      'the direction head',
    )
    identical(
      (await directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 1 })).direction,
      worldA.direction,
      'direction version 1 after version 2 arrived',
    )

    // Workspace B stores its own direction for a session with the same id.
    await directions.persistEvidenceSet({ set: worldB.evidence, createdAt: at(7).toISOString() })
    await directions.appendVersion({ direction: worldB.direction, base: null, occurredAt: at(7).toISOString() })
    const headB = await directions.readHead({ workspaceId: B, sessionId: SESSION })
    assert.equal(headB.version, 1, 'workspace B saw the chain next door instead of its own')
    identical(headB.direction, worldB.direction, 'the workspace B direction')
    assert.notEqual(worldB.direction.directionHash, worldA.direction.directionHash)
    const dependentsA = await directions.findDependents({
      workspaceId: A, diagnosticHash: worldA.direction.diagnosticHash,
    })
    assert.equal(dependentsA.length, 2, 'both versions name the diagnostic they were computed from')
    assert.deepEqual(dependentsA.map((entry) => entry.isHead).sort(), [false, true])

    // A shot whose confidence and band were edited *together* satisfies every
    // CHECK on the row — the band really is the confidence read through the
    // floors — and is still refused, because the hash covers both.
    const tamperedShot = await client.v2MulticamShotDecision.findFirstOrThrow({
      where: { workspaceId: A, sessionId: SESSION, directionId: { endsWith: 'md1' } },
      orderBy: { ordinal: 'asc' },
    })
    await client.$executeRawUnsafe(
      'UPDATE "multicam_shot_decisions" SET "confidence" = 0.95, "confidenceBand" = \'high\' WHERE "id" = $1',
      tamperedShot.id,
    )
    await refusedOnRead(
      () => directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 1 }),
      'a shot whose confidence was raised in the database',
    )
    await client.$executeRawUnsafe(
      'UPDATE "multicam_shot_decisions" SET "confidence" = $2, "confidenceBand" = $3 WHERE "id" = $1',
      tamperedShot.id, tamperedShot.confidence, tamperedShot.confidenceBand,
    )
    identical(
      (await directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 1 })).direction,
      worldA.direction,
      'direction version 1 once the edit was undone',
    )

    // -----------------------------------------------------------------
    // F4.013 — colour measurements and match plans
    // -----------------------------------------------------------------

    const measurements = new PrismaCameraColorMeasurementRepository(client)
    const plans = new PrismaMulticamMatchPlanRepository(client)
    const matchA = buildMatchWorld({ workspaceId: A, projectId: project(A), sessionId: SESSION })
    const matchB = buildMatchWorld({ workspaceId: B, projectId: project(B), sessionId: SESSION })

    assert.ok(matchA.plan.humanReviewRequired, 'the match fixture must be the clamped one')
    assert.ok(matchA.plan.issues.some((issue) => issue.humanReviewRequired))

    const firstMeasurement = await measurements.persist({
      workspaceId: A, measurement: matchA.measurements[0], createdAt: at(10).toISOString(),
    })
    assert.equal(firstMeasurement.replayed, false)
    assert.equal(
      (await measurements.persist({
        workspaceId: A, measurement: matchA.measurements[0], createdAt: at(11).toISOString(),
      })).replayed,
      true,
      'the same measurement written twice is one measurement',
    )
    identical(
      await measurements.read({ workspaceId: A, measurementId: matchA.measurements[0].measurementId }),
      matchA.measurements[0],
      'the camera colour measurement',
    )
    // `skin` is not-applicable in the fixture: it comes back with a reason and
    // no `value` key at all, which is a different object from one carrying
    // `value: undefined` — the reason the round trip is checked byte-wise.
    const storedMeasurement = await measurements.read({
      workspaceId: A, measurementId: matchA.measurements[0].measurementId,
    })
    assert.equal(storedMeasurement.dimensions.skin.status, 'not-applicable')
    assert.equal(Object.hasOwn(storedMeasurement.dimensions.skin, 'value'), false)
    assert.equal(
      await measurements.read({ workspaceId: B, measurementId: matchA.measurements[0].measurementId }),
      null,
      'workspace B could read a workspace A measurement',
    )

    const storedPlan = await plans.appendVersion({
      plan: matchA.plan, base: null, occurredAt: at(12).toISOString(),
    })
    assert.equal(storedPlan.stored.version, 1)
    identical(storedPlan.stored.plan, matchA.plan, 'match plan version 1')
    assert.equal(
      (await plans.appendVersion({ plan: matchA.plan, base: null, occurredAt: at(13).toISOString() })).replayed,
      true,
      'the same plan written twice is one version',
    )

    // The next version has to be a different body: the chain is unique on
    // (workspace, planHash), so re-offering version 1's bytes as version 2 is
    // refused by the index before the head fence is ever consulted.
    const laterPlan = (() => {
      const { planHash, ...planBody } = matchA.plan
      const moved = { ...planBody, createdAt: new Date(Date.parse(planBody.createdAt) + 1_000).toISOString() }
      return Object.freeze({ ...moved, planHash: calculateMulticamMatchPlanHash(moved) })
    })()
    assert.notEqual(laterPlan.planHash, matchA.plan.planHash)

    await assert.rejects(
      () => plans.appendVersion({
        plan: laterPlan,
        base: { version: 1, planHash: digest('9') },
        occurredAt: at(14).toISOString(),
      }),
      (error) => {
        assert.equal(error.code, 'PERSISTENCE_CONFLICT')
        assert.equal(error.details.currentVersion, 1)
        assert.equal(error.details.currentHash, matchA.plan.planHash)
        return true
      },
      'a stale base hash advanced the match plan head',
    )
    const advancedPlan = await plans.appendVersion({
      plan: laterPlan,
      base: { version: 1, planHash: matchA.plan.planHash },
      occurredAt: at(16).toISOString(),
    })
    assert.equal(advancedPlan.stored.version, 2)
    identical(
      (await plans.readVersion({
        workspaceId: A, projectId: project(A), sessionId: SESSION, version: 1,
      })).plan,
      matchA.plan,
      'match plan version 1 after version 2 arrived',
    )

    await plans.appendVersion({ plan: matchB.plan, base: null, occurredAt: at(15).toISOString() })
    const planHeadB = await plans.readHead({ workspaceId: B, projectId: project(B), sessionId: SESSION })
    identical(planHeadB.plan, matchB.plan, 'the workspace B match plan')
    assert.equal(
      await plans.readHead({ workspaceId: A, projectId: project(B), sessionId: SESSION }),
      null,
      'workspace A could read a workspace B plan by naming its project',
    )
    const planDependents = await plans.findDependents({
      workspaceId: A, measurementId: matchA.measurements[1].measurementId,
    })
    assert.equal(planDependents.length, 2, 'both versions were built on that measurement')
    assert.deepEqual(planDependents.map((entry) => entry.isHead).sort(), [false, true])

    // A transform confidence edited in the database keeps every bound the
    // CHECKs enforce and still fails the plan hash.
    const tamperedTransform = await client.v2CameraMatchTransform.findFirstOrThrow({
      where: { workspaceId: A },
    })
    await client.$executeRawUnsafe(
      'UPDATE "camera_match_transforms" SET "confidence" = 0.5 WHERE "id" = $1',
      tamperedTransform.id,
    )
    await refusedOnRead(
      () => plans.readVersion({ workspaceId: A, projectId: project(A), sessionId: SESSION, version: 1 }),
      'a match transform whose confidence was lowered in the database',
    )
    await client.$executeRawUnsafe(
      'UPDATE "camera_match_transforms" SET "confidence" = $2 WHERE "id" = $1',
      tamperedTransform.id, tamperedTransform.confidence,
    )

    // -----------------------------------------------------------------
    // F4.014 — the colour critic
    // -----------------------------------------------------------------

    const reports = new PrismaColorCriticReportRepository(client)
    const reportA = buildCriticReport({
      workspaceId: A, projectId: project(A), projectVersionId: version(A),
      reportId: 'w20r-report-a', matchPlan: matchA.plan,
    })
    const reportB = buildCriticReport({
      workspaceId: B, projectId: project(B), projectVersionId: version(B),
      reportId: 'w20r-report-b', matchPlan: matchB.plan,
    })

    assert.equal((await reports.persist({ report: reportA, createdAt: at(20).toISOString() })).replayed, false)
    assert.equal(
      (await reports.persist({ report: reportA, createdAt: at(21).toISOString() })).replayed,
      true,
      'the same bytes judged against the same thresholds are one report',
    )
    identical(await reports.read({ workspaceId: A, reportId: reportA.reportId }), reportA, 'the colour critic report')
    identical(
      await reports.readByHash({ workspaceId: A, reportHash: reportA.reportHash }),
      reportA,
      'the colour critic report read by hash',
    )
    assert.equal(
      await reports.read({ workspaceId: B, reportId: reportA.reportId }),
      null,
      'workspace B could read a workspace A verdict',
    )
    await reports.persist({ report: reportB, createdAt: at(22).toISOString() })
    const listed = await reports.listForProjectVersion({
      workspaceId: A, projectId: project(A), projectVersionId: version(A),
    })
    assert.equal(listed.length, 1, 'the project version listing crossed a workspace')
    const criticDependents = await reports.findDependentsOfMatchPlan({
      workspaceId: A, matchPlanId: reportA.matchPlanId,
    })
    assert.equal(criticDependents.length, 1)
    assert.equal(criticDependents[0].action, reportA.action)

    // The same question asked of the evidence: which verdicts rest on this
    // measurement. It is answerable because the citation is a row, and the row
    // exists because `persist` writes the measurements it judged the way the
    // match plan does.
    const citedMeasurement = reportA.sections[0].measurements[0]
    const measurementDependents = await reports.findDependentsOfMeasurement({
      workspaceId: A, measurementId: citedMeasurement.measurementId,
    })
    assert.equal(measurementDependents.length, 1, 'the verdict over that measurement was not found')
    assert.equal(measurementDependents[0].reportId, reportA.reportId)
    assert.deepEqual(
      await reports.findDependentsOfMeasurement({
        workspaceId: B, measurementId: citedMeasurement.measurementId,
      }),
      [],
      'workspace B saw a workspace A citation',
    )
    identical(
      await measurements.read({ workspaceId: A, measurementId: citedMeasurement.measurementId }),
      citedMeasurement,
      'the measurement the verdict was reached over',
    )
    // RESTRICT, not CASCADE: deleting the measurement a standing verdict rests
    // on would leave a judgement of numbers nobody can look up.
    const citedRow = await client.v2CameraColorMeasurement.findFirstOrThrow({
      where: { workspaceId: A, measurementId: citedMeasurement.measurementId },
      select: { id: true },
    })
    await assert.rejects(
      () => client.v2CameraColorMeasurement.delete({ where: { id: citedRow.id } }),
      (error) => {
        assert.match(
          String(error?.message ?? ''),
          /color_critic_report_measurements_measurementId_workspaceId_fkey|[Ff]oreign key constraint/,
          `the delete was refused, but not by the citation's foreign key: ${error?.message}`,
        )
        return true
      },
      'a measurement a standing verdict rests on was deleted',
    )

    // The confidence and its band move together, so the row stays legal — and
    // the verdict is still refused.
    await client.$executeRawUnsafe(
      'UPDATE "color_critic_reports" SET "confidence" = 0.9, "confidenceBand" = \'high\' WHERE "workspaceId" = $1 AND "reportId" = $2',
      A, reportA.reportId,
    )
    await refusedOnRead(
      () => reports.read({ workspaceId: A, reportId: reportA.reportId }),
      'a critic report whose confidence was edited in the database',
    )
    await client.$executeRawUnsafe(
      'UPDATE "color_critic_reports" SET "confidence" = $3, "confidenceBand" = $4 WHERE "workspaceId" = $1 AND "reportId" = $2',
      A, reportA.reportId, reportA.confidence, reportA.confidenceBand,
    )
    identical(await reports.read({ workspaceId: A, reportId: reportA.reportId }), reportA, 'the restored report')

    // -----------------------------------------------------------------
    // F4.015 — react playback maps
    // -----------------------------------------------------------------

    const maps = new PrismaPlaybackMapRepository(client)
    const playbackA = buildPlaybackWorld({ workspaceId: A, sessionId: REACT, projectId: project(A) })
    const playbackB = buildPlaybackWorld({ workspaceId: B, sessionId: REACT, projectId: project(B) })

    assert.equal(playbackA.map.status, 'needs-input', 'the playback fixture must be the one a person has to finish')
    assert.ok(playbackA.map.pieces.some((piece) => piece.mode === 'paused' && piece.rate === null))
    assert.ok(playbackA.map.pieces.some((piece) => piece.mode === 'replay' && piece.direction === 'backward'))

    const storedMap = await maps.appendVersion({ map: playbackA.map, occurredAt: at(30).toISOString() })
    assert.equal(storedMap.replayed, false)
    identical(
      await maps.readHead({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK }),
      playbackA.map,
      'playback map version 1',
    )
    assert.equal(
      (await maps.appendVersion({ map: playbackA.map, occurredAt: at(31).toISOString() })).replayed,
      true,
      'the same map written twice is one version',
    )

    const anchored = anchorPlaybackMap(playbackA.map, {
      anchorId: 'w20r-anchor-1',
      actorId: 'operator-7',
      note: 'the player was off screen for this stretch',
      createdAt: at(32).toISOString(),
    })
    assert.equal(anchored.version, 2)
    assert.equal(anchored.previousVersionHash, playbackA.map.mapHash)
    await assert.rejects(
      () => maps.appendVersion({
        map: anchored, expectedVersion: 1, expectedHash: digest('9'), occurredAt: at(33).toISOString(),
      }),
      (error) => {
        assert.equal(error.code, 'PLAYBACK_MAP_VERSION_STALE')
        assert.equal(error.details.currentVersion, 1)
        assert.equal(error.details.currentHash, playbackA.map.mapHash)
        return true
      },
      'a stale expected hash advanced the playback head',
    )
    await maps.appendVersion({ map: anchored, occurredAt: at(34).toISOString() })
    identical(
      await maps.readHead({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK }),
      anchored,
      'playback map version 2',
    )
    identical(
      await maps.readVersion({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK, version: 1 }),
      playbackA.map,
      'playback map version 1 after the anchor',
    )
    // The manual anchor's actor was projected out of its evidence string and
    // survives as the columns the CHECK reads.
    const anchorRow = await client.v2PlaybackAnchor.findFirstOrThrow({
      where: { workspaceId: A, anchorId: 'w20r-anchor-1' },
    })
    assert.equal(anchorRow.actorId, 'operator-7')
    assert.equal(anchorRow.actorKind, 'human')
    assert.equal(anchorRow.note, 'the player was off screen for this stretch')

    await maps.appendVersion({ map: playbackB.map, occurredAt: at(35).toISOString() })
    const mapHeadB = await maps.readHead({ workspaceId: B, sessionId: REACT, reactionTrackId: REACTION_TRACK })
    assert.equal(mapHeadB.version, 1, 'workspace B saw the chain next door instead of its own')
    const referenceDependents = await maps.findDependentsOfReference({
      workspaceId: A,
      referenceAssetId: playbackA.map.referenceMedia.assetId,
      referenceSha256: playbackA.map.referenceMedia.sha256,
    })
    assert.equal(referenceDependents.length, 2, 'both versions depend on the same reference bytes')
    assert.deepEqual(referenceDependents.map((entry) => entry.isHead).sort(), [false, true])

    // A tick is 64-bit. The reaction runs forty seconds at 90 kHz and the
    // driver hands the boundary back as a bigint, not a rounded double.
    const pieceRow = await client.v2PlaybackPiece.findFirstOrThrow({
      where: { workspaceId: A, mapId: { endsWith: 'pm1' } },
      orderBy: { ordinal: 'desc' },
    })
    assert.equal(typeof pieceRow.reactionEndTicks, 'bigint')
    assert.equal(pieceRow.reactionEndTicks, playbackA.map.reactionMedia.durationTicks)

    // A piece confidence edited in the database keeps every CHECK and still
    // fails its own hash, before the map hash is even reached.
    await client.$executeRawUnsafe(
      'UPDATE "playback_pieces" SET "confidence" = 0.5 WHERE "id" = $1',
      pieceRow.id,
    )
    await refusedOnRead(
      () => maps.readVersion({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK, version: 1 }),
      'a playback piece whose confidence was edited in the database',
    )
    await client.$executeRawUnsafe(
      'UPDATE "playback_pieces" SET "confidence" = $2 WHERE "id" = $1',
      pieceRow.id, pieceRow.confidence,
    )

    console.log(
      `wave20 round trip: direction shots=${worldA.direction.shots.length} uncovered=${worldA.direction.uncovered.length}, ` +
        `measurement dimensions=${Object.keys(matchA.measurements[0].dimensions).length}, ` +
        `plan issues=${matchA.plan.issues.length}, critic dimensions=${reportA.dimensions.length}, ` +
        `playback pieces v1=${playbackA.map.pieces.length} v2=${anchored.pieces.length}`,
    )
  },
)

test(
  'E2E-F4.016 immutable history means refused on read, and it does not mean refused on DELETE',
  { skip: RUN ? false : 'set APOLLO_WAVE20_PERSISTENCE_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    // The contract for this wave says "immutable histories: version chain plus
    // head; hydration re-verifies every hash". The second test above proves the
    // second half of that sentence for four aggregates: an edited row is
    // refused on read. This test measures the FIRST half, because nothing did,
    // and the two halves are not the same protection.
    //
    // What it proves:
    //
    // - The protection is application code, not database. There is no trigger,
    //   no rule and no row-level security on any of these tables, so nothing
    //   below the repositories refuses anything.
    // - A DELETE therefore succeeds. A version row disappears, the head goes on
    //   naming its hash, and the chain that was supposed to be a history has a
    //   hole in it that no read complains about until it asks for that version.
    //
    // Why it is a test rather than a fix. Blocking DELETE in the database
    // breaks three things this repository does on purpose and one of them is a
    // production write path:
    //
    // - `capture-session-repository.ts` deletes the previous clock map inside
    //   `persistClockMap` -- "a map is the current answer for one source".
    // - `multicam-longform-gate.e2e.mjs` falsifies nine of the ten gate
    //   criteria by deleting one evidence row each, and asserts that deleting a
    //   gate record cascades to its criteria, checks and evidence.
    // - The cleanup of every Postgres suite here, including this file's own,
    //   deletes from the same tables.
    //
    // So the record is the honest outcome and this is the tripwire under it:
    // the day somebody does add the protection, this test fails and points at
    // the three places the record lives (PRD FR-150, spec 05 s33.2 and s34.9,
    // REQUIREMENTS-TRACEABILITY).
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )
    const { PrismaMulticamDirectionRepository } = await import(
      '../../src/v2/infrastructure/prisma/multicam-direction-repository.ts'
    )
    const { calculateMulticamDirectionHash } = await import(
      '../../src/v2/domain/multicam-direction.ts'
    )
    const { buildDirectionWorld } = await import('./wave20-fixtures.mjs')

    const client = new PrismaClient()
    const W = 'w20i-workspace'
    const PROJECT = 'w20i-project'
    const VERSION = 'w20i-version'
    const SESSION = 'w20i-session'
    const at = (second) => new Date(Date.parse('2029-05-03T09:00:00.000Z') + second * 1_000)

    const clean = async () => {
      for (const table of [
        client.v2MulticamAngleScoreComponent, client.v2MulticamAngleCandidate,
        client.v2MulticamShotAlternative, client.v2MulticamShotDecision,
        client.v2MulticamDirectionHead, client.v2MulticamDirection,
        client.v2MulticamObservation, client.v2MulticamEvidenceSet,
        client.v2CaptureSessionHead,
      ]) {
        await table.deleteMany({ where: { workspaceId: W } })
      }
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId: W } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId: W } })
      await client.v2Project.deleteMany({ where: { workspaceId: W } })
      await client.v2Workspace.deleteMany({ where: { id: W } })
    }

    t.after(async () => {
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })
    await clean()

    // ---- the catalogue, over the tables the phrase is about ---------------
    // Read from `pg_catalog` rather than from the migration text: a migration
    // that creates a trigger and a database that has one are different claims,
    // and only the second is what protects a row.
    const HISTORY_TABLES = [
      'capture_session_versions', 'capture_session_heads',
      'sync_diagnostics', 'sync_diagnostic_heads',
      'multicam_directions', 'multicam_direction_heads',
      'multicam_match_plans', 'multicam_match_plan_heads',
      'playback_maps', 'playback_map_heads',
      'renderable_plan_snapshots',
      'multicam_longform_gates', 'multicam_longform_gate_criteria',
      'multicam_longform_gate_checks', 'multicam_longform_gate_evidence',
    ]
    const [guards] = await client.$queryRawUnsafe(
      `SELECT
         count(*) FILTER (WHERE NOT t.tgisinternal) AS triggers,
         count(DISTINCT c.oid) FILTER (WHERE c.relrowsecurity) AS rls,
         count(DISTINCT c.oid) AS tables
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_trigger t ON t.tgrelid = c.oid
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      HISTORY_TABLES,
    )
    const [rules] = await client.$queryRawUnsafe(
      "SELECT count(*) AS rules FROM pg_rules WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
      HISTORY_TABLES,
    )
    assert.equal(
      Number(guards.tables),
      HISTORY_TABLES.length,
      'the table list drifted from the schema; a name that does not exist measures nothing',
    )
    assert.equal(Number(guards.triggers), 0, 'a trigger appeared: the record in the PRD and spec 05 s34.7 is now wrong')
    assert.equal(Number(guards.rls), 0, 'row-level security appeared: the same record is now wrong')
    assert.equal(Number(rules.rules), 0, 'a rule appeared: the same record is now wrong')

    // ---- and what that costs, on a real two-version chain -----------------
    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(createWorkspace({
      id: W, slug: W, name: 'W20 immutability', status: 'active', createdAt: at(0).toISOString(),
    }))
    await client.v2Project.create({
      data: {
        id: PROJECT,
        workspaceId: W,
        name: 'W20 immutability',
        status: 'reviewing-proxy',
        objective: 'discovery',
        format: '16:9',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: 'w20i-client',
        createdAt: at(0),
        updatedAt: at(0),
      },
    })
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `${VERSION}-${kind}`,
          workspaceId: W,
          projectId: PROJECT,
          kind,
          schemaVersion: 1,
          contentJson: JSON.stringify({ kind }),
          contentHash: '1'.repeat(64),
          createdAt: at(0),
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: VERSION,
        workspaceId: W,
        projectId: PROJECT,
        sequence: 1,
        briefSnapshotId: `${VERSION}-brief`,
        editPlanSnapshotId: `${VERSION}-edit-plan`,
        policiesSnapshotId: `${VERSION}-policies`,
        baseHash: '2'.repeat(64),
        createdBy: 'w20i-client',
        createdAt: at(0),
      },
    })

    const directions = new PrismaMulticamDirectionRepository(client)
    const world = buildDirectionWorld({ workspaceId: W, projectId: PROJECT, sessionId: SESSION })
    await client.v2CaptureSessionHead.create({
      data: {
        id: `${SESSION}:head`, workspaceId: W, projectId: PROJECT, sessionId: SESSION,
        version: world.session.version, sessionHash: world.session.sessionHash,
        status: world.session.status, createdAt: at(0), updatedAt: at(0),
      },
    })
    await directions.persistEvidenceSet({ set: world.evidence, createdAt: at(1).toISOString() })
    await directions.appendVersion({
      direction: world.direction, base: null, occurredAt: at(2).toISOString(),
    })
    const later = (() => {
      const { directionHash, ...body } = world.direction
      const moved = { ...body, generatedAt: new Date(Date.parse(body.generatedAt) + 1_000).toISOString() }
      return Object.freeze({ ...moved, directionHash: calculateMulticamDirectionHash(moved) })
    })()
    const advanced = await directions.appendVersion({
      direction: later,
      base: { version: 1, directionHash: world.direction.directionHash },
      occurredAt: at(3).toISOString(),
    })
    assert.equal(advanced.stored.version, 2)
    assert.equal(advanced.stored.previousVersionHash, world.direction.directionHash)

    // Version 1 is the ancestor the head's chain names. Deleting it is the
    // thing the phrase "immutable history" reads as forbidden.
    const removed = await client.$executeRawUnsafe(
      'DELETE FROM "multicam_directions" WHERE "workspaceId" = $1 AND "sessionId" = $2 AND "version" = 1',
      W, SESSION,
    )
    assert.equal(removed, 1, 'the database refused the delete, and the record is now wrong')
    assert.equal(
      await directions.readVersion({ workspaceId: W, sessionId: SESSION, version: 1 }),
      null,
      'the deleted version came back',
    )
    // The head still answers, still names the ancestor by hash, and nothing in
    // the read path says the ancestor is gone. That is the whole finding: the
    // chain is verifiable forwards from a row and unverifiable backwards past
    // a row somebody removed.
    const head = await directions.readHead({ workspaceId: W, sessionId: SESSION })
    assert.equal(head.version, 2)
    assert.equal(head.previousVersionHash, world.direction.directionHash)
    const shots = await client.v2MulticamShotDecision.count({
      where: { workspaceId: W, sessionId: SESSION, directionId: { endsWith: ':v1' } },
    })
    console.log(
      `[E2E-F4.016] immutability: ${HISTORY_TABLES.length} history tables, `
      + `${Number(guards.triggers)} triggers, ${Number(rules.rules)} rules, ${Number(guards.rls)} with RLS; `
      + `DELETE of version 1 removed ${removed} row and ${shots === 0 ? 'its' : shots + ' remaining'} shot decisions, `
      + `head still at v${head.version} naming the ancestor hash`,
    )
  },
)
