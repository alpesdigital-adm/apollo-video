import { assertDomain } from '../domain/errors.ts'
import {
  SYNTHETIC_CRITIC_DIMENSIONS,
  createSyntheticCriticReport,
  type SyntheticCriticDimension,
  type SyntheticCriticEvaluator,
  type SyntheticCriticMeasurement,
  type SyntheticCriticReport,
} from '../domain/synthetic-critic-report.ts'
import {
  evaluateSyntheticCriticThresholds,
  resolveSyntheticCriticThresholds,
  syntheticCriticDimensionPolicy,
  type SyntheticCriticFinding,
} from '../domain/synthetic-critic-thresholds.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { requireScope } from './authenticate-api-client.ts'
import type {
  SyntheticCriticDimensionEvaluator,
  SyntheticCriticEvaluationContext,
  SyntheticCriticMediaEvaluator,
  SyntheticCriticSubject,
} from './ports/synthetic-critic-evaluator.ts'
import type { SyntheticCriticReportRepository } from './ports/synthetic-critic-report-repository.ts'

/**
 * Why a dimension carries no number today. These notes are the honest half of
 * the aggregate's rule that every dimension must answer: nothing here is a
 * score, and none of it may be read as "fine".
 */
const UNDEPLOYED_MODEL_NOTES: Readonly<Record<string, string>> = Object.freeze({
  'visual-artifacts': 'no visual artifact detector is deployed, so the take was not inspected for warping, ghosting or banding',
  framing: 'no framing model is deployed, so the take was not inspected for headroom, crop or camera position',
  eyes: 'no eye model is deployed, so the take was not inspected for gaze, blinking or pupil rendering',
  teeth: 'no teeth model is deployed, so the take was not inspected for dental rendering',
  hands: 'no hand model is deployed, so the take was not inspected for finger count or hand geometry',
})

const NOT_APPLICABLE_NOTE =
  'the capability under evaluation does not produce this signal, so the dimension does not apply to this take'

export interface EvaluateSyntheticCriticRequest {
  subject: Readonly<SyntheticCriticSubject>
  /** The presenter snapshot the take was generated from. */
  profileSnapshotId: string
  /** The hash of the approved script text the take was measured against. */
  scriptHash: string
  actor: AuthenticatedExternalActor
}

export interface SyntheticCriticEvaluationResult {
  report: Readonly<SyntheticCriticReport>
  replayed: boolean
}

/**
 * Orchestrates the critic: adapters measure, the versioned thresholds decide,
 * and the verdict is sealed as an immutable report.
 *
 * Idempotency is by take, not by clock. A second evaluation of the same block
 * and the same artifact under the same thresholds version returns the stored
 * report instead of running the adapters again and minting a second opinion
 * with a fresher timestamp. A new thresholds version is a genuinely new
 * question and does produce a new report.
 */
export function evaluateSyntheticCriticService(dependencies: {
  reports: SyntheticCriticReportRepository
  media: SyntheticCriticMediaEvaluator
  pronunciation: SyntheticCriticDimensionEvaluator
  controlled: SyntheticCriticDimensionEvaluator
  clock: () => Date
  createId: (input: { workspaceId: string; blockId: string; artifactId: string }) => string
}) {
  return async function evaluate(
    request: EvaluateSyntheticCriticRequest,
  ): Promise<Readonly<SyntheticCriticEvaluationResult>> {
    const subject = request.subject
    requireScope(request.actor, 'projects:write')
    assertDomain(
      request.actor.workspaceId === subject.workspaceId,
      'INVALID_WORKSPACE',
      'Actor cannot evaluate a synthetic take in another workspace',
    )
    const target = subject.video ?? subject.audio
    assertDomain(
      Boolean(target),
      'INVALID_ARGUMENT',
      'A critic subject must carry the bytes it is judged on',
    )

    const thresholds = resolveSyntheticCriticThresholds({
      capability: subject.capability,
      adapterId: subject.adapterId,
      modelRef: subject.modelRef,
    })

    const stored = await dependencies.reports.readByBlock({
      workspaceId: subject.workspaceId,
      blockId: subject.blockId,
      artifactId: target!.artifactId,
      thresholdsVersion: thresholds.version,
      limit: 1,
    })
    if (stored.length > 0) return Object.freeze({ report: stored[0]!, replayed: true })

    const mediaOutcome = await dependencies.media.evaluate(
      Object.freeze({ subject, media: null }) as Readonly<SyntheticCriticEvaluationContext>,
    )
    const context: Readonly<SyntheticCriticEvaluationContext> = Object.freeze({
      subject,
      media: mediaOutcome.media,
    })
    const [pronunciationOutcome, controlledOutcome] = await Promise.all([
      dependencies.pronunciation.evaluate(context),
      dependencies.controlled.evaluate(context),
    ])

    const outcomes = [mediaOutcome, pronunciationOutcome, controlledOutcome]
    const answered = new Map<SyntheticCriticDimension, Readonly<SyntheticCriticMeasurement>>()
    const findings: Readonly<SyntheticCriticFinding>[] = []
    const evaluators: Readonly<SyntheticCriticEvaluator>[] = []
    for (const outcome of outcomes) {
      evaluators.push(outcome.evaluator)
      findings.push(...outcome.findings)
      for (const measurement of outcome.measurements) {
        assertDomain(
          !answered.has(measurement.dimension),
          'INVALID_ARGUMENT',
          `two evaluators answered for ${measurement.dimension}; a dimension has one instrument`,
        )
        answered.set(measurement.dimension, measurement)
      }
    }

    const measurements = SYNTHETIC_CRITIC_DIMENSIONS.map((dimension) => {
      const policy = syntheticCriticDimensionPolicy(thresholds, dimension)
      // A capability that produces no such signal says so, even when an
      // evaluator ran and reported it could not compare: "does not apply" and
      // "could not be measured" are different answers and must not be blurred.
      if (policy.requirement === 'not-applicable') {
        return Object.freeze({
          dimension,
          status: 'not-applicable' as const,
          evaluatorId: null,
          value: null,
          unit: null,
          threshold: null,
          confidence: null,
          evidenceRefs: Object.freeze([] as readonly string[]),
          range: null,
          note: NOT_APPLICABLE_NOTE,
        } as SyntheticCriticMeasurement)
      }
      const measured = answered.get(dimension)
      if (measured) {
        // The instrument reports the number; the published policy supplies the
        // line it was compared against, so a reader never has to guess it.
        return Object.freeze({ ...measured, threshold: measured.status === 'measured' ? policy.limit : null })
      }
      return Object.freeze({
        dimension,
        status: 'unavailable' as const,
        evaluatorId: null,
        value: null,
        unit: null,
        threshold: null,
        confidence: null,
        evidenceRefs: Object.freeze([] as readonly string[]),
        range: null,
        note: UNDEPLOYED_MODEL_NOTES[dimension] ?? `no evaluator is deployed for ${dimension}`,
      } as SyntheticCriticMeasurement)
    })

    const verdict = evaluateSyntheticCriticThresholds({
      thresholds,
      blockId: subject.blockId,
      measurements,
      findings,
    })

    const report = createSyntheticCriticReport({
      id: dependencies.createId({
        workspaceId: subject.workspaceId,
        blockId: subject.blockId,
        artifactId: target!.artifactId,
      }),
      workspaceId: subject.workspaceId,
      projectId: subject.projectId,
      blockId: subject.blockId,
      capability: subject.capability,
      adapterId: subject.adapterId,
      adapterVersion: subject.adapterVersion,
      artifactId: target!.artifactId,
      artifactSha256: target!.sha256,
      audioArtifactId: subject.audio?.artifactId ?? null,
      alignmentArtifactId: subject.alignmentArtifactId,
      scriptHash: request.scriptHash,
      profileSnapshotId: request.profileSnapshotId,
      expectedIdentityRef: subject.expected.identityRef,
      evaluators,
      measurements,
      issues: verdict.issues,
      decision: verdict.decision,
      recommendedAction: verdict.recommendedAction,
      thresholdsVersion: thresholds.version,
      decidedAt: dependencies.clock().toISOString(),
    })

    const recorded = await dependencies.reports.record({ report })
    return Object.freeze({ report: recorded.value, replayed: recorded.replayed })
  }
}

export function readSyntheticCriticReportsService(dependencies: {
  reports: SyntheticCriticReportRepository
}) {
  return async function read(request: {
    workspaceId: string
    actor: AuthenticatedExternalActor
    blockId?: string
    artifactId?: string
    projectId?: string
    limit?: number
  }): Promise<readonly Readonly<SyntheticCriticReport>[]> {
    requireScope(request.actor, 'projects:read')
    assertDomain(
      request.actor.workspaceId === request.workspaceId,
      'INVALID_WORKSPACE',
      'Actor cannot read critic reports from another workspace',
    )
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    if (request.blockId) {
      return await dependencies.reports.readByBlock({
        workspaceId: request.workspaceId,
        blockId: request.blockId,
        ...(request.artifactId ? { artifactId: request.artifactId } : {}),
        limit,
      })
    }
    if (request.artifactId) {
      return await dependencies.reports.readByArtifact({
        workspaceId: request.workspaceId,
        artifactId: request.artifactId,
        limit,
      })
    }
    assertDomain(
      Boolean(request.projectId),
      'INVALID_ARGUMENT',
      'critic reports are read by block, by artifact or by project',
    )
    return await dependencies.reports.listByProject({
      workspaceId: request.workspaceId,
      projectId: request.projectId!,
      limit,
    })
  }
}
