import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createMontageCandidateSeed,
  createMontageSelection,
  evaluateMontageCandidate,
  MONTAGE_ALTERNATIVE_POLICY_VERSION,
  MONTAGE_RUBRIC,
  type MontageCandidateSeed,
} from '../domain/montage-candidate.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { MontageAlternativeRepository } from './ports/montage-alternative-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/

function identity(value: string, field: string): string {
  const normalized = value?.trim()
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

export function canonicalMontageScore(seed: Readonly<MontageCandidateSeed>): number {
  return Object.entries(MONTAGE_RUBRIC.weights).reduce((total, [criterion, weight]) => total + seed.rubricSignals[criterion as keyof typeof MONTAGE_RUBRIC.weights] * weight, 0)
}

export function canonicalMontageCost(seed: Readonly<MontageCandidateSeed>): number {
  return seed.assets.length * 0.25 + seed.patternBreaks.length * 0.05 + (seed.mode === 'reorganized' ? 0.15 : seed.mode === 'cold-open' ? 0.08 : 0)
}

export function selectMontageCandidate(input: {
  seeds: readonly (Omit<MontageCandidateSeed, 'schemaVersion' | 'seedHash'> | MontageCandidateSeed)[]
  score?: (seed: Readonly<MontageCandidateSeed>) => number
  estimateCost?: (seed: Readonly<MontageCandidateSeed>) => number
}) {
  assertDomain(Array.isArray(input.seeds) && input.seeds.length >= 1 && input.seeds.length <= 32, 'INVALID_ARGUMENT', 'seeds must contain one to thirty-two candidates')
  const candidates = input.seeds.map((value) => {
    const seed = createMontageCandidateSeed(value)
    return evaluateMontageCandidate({ seed, score: input.score ?? canonicalMontageScore, estimateCost: input.estimateCost ?? canonicalMontageCost })
  })
  return createMontageSelection({ candidates })
}

export function createMontageAlternativeRunService(dependencies: {
  repository: MontageAlternativeRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    policyVersion: string
    storyPlanRef: Readonly<{ id: string; hash: string }>
    seeds: readonly (Omit<MontageCandidateSeed, 'schemaVersion' | 'seedHash'> | MontageCandidateSeed)[]
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    assertDomain(request.policyVersion === MONTAGE_ALTERNATIVE_POLICY_VERSION, 'INVALID_ARGUMENT', `policyVersion must be ${MONTAGE_ALTERNATIVE_POLICY_VERSION}`)
    assertDomain(ID.test(request.storyPlanRef?.id) && HASH.test(request.storyPlanRef?.hash), 'INVALID_ARGUMENT', 'storyPlanRef is invalid')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'montage alternative actor does not belong to the workspace')
    const idempotencyKey = request.idempotencyKey?.trim()
    assertDomain(IDEMPOTENCY_KEY.test(idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key must contain 8 to 128 visible ASCII characters')
    const seeds = Object.freeze(request.seeds.map((value) => createMontageCandidateSeed(value)))
    assertDomain(seeds.every(({ storyPlanRef }) => storyPlanRef.id === request.storyPlanRef.id && storyPlanRef.hash === request.storyPlanRef.hash), 'VERSION_CONFLICT', 'candidate seeds do not match the requested StoryPlan contract')
    const persistedStoryPlan = await dependencies.repository.readStoryPlanReference({ workspaceId, projectId, storyPlanId: request.storyPlanRef.id })
    if (!persistedStoryPlan) throw new DomainError('PROJECT_NOT_FOUND', 'Exact StoryPlan for montage alternatives was not found')
    if (persistedStoryPlan.id !== request.storyPlanRef.id || persistedStoryPlan.hash !== request.storyPlanRef.hash) throw new DomainError('VERSION_CONFLICT', 'Montage alternatives reference a stale StoryPlan hash')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'create-montage-alternative-run-request/v1', workspaceId, projectId, policyVersion: request.policyVersion, storyPlanRef: request.storyPlanRef, seeds, actorClientId: authenticationAudit.clientId, actorContextHash: authenticationAudit.contextHash })
    const replay = await dependencies.repository.findReplay({ workspaceId, projectId, actorClientId: authenticationAudit.clientId, idempotencyKey, actorContextHash: authenticationAudit.contextHash })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different montage alternative request')
      return Object.freeze({ run: replay, replayed: true })
    }
    const selection = selectMontageCandidate({ seeds })
    const createdAt = dependencies.clock().toISOString()
    const runBody = Object.freeze({
      schemaVersion: 'montage-alternative-run/v1' as const,
      id: identity(dependencies.createRunId(), 'created run ID'), workspaceId, projectId,
      policyVersion: MONTAGE_ALTERNATIVE_POLICY_VERSION, storyPlanRef: Object.freeze({ ...request.storyPlanRef }),
      selection, createdByClientId: authenticationAudit.clientId, createdAt,
    })
    const run = Object.freeze({ ...runBody, runHash: calculateCanonicalHash(runBody) })
    return dependencies.repository.create({ run, requestFingerprint, idempotencyKey, authenticationAudit })
  }
}

export function readMontageAlternativeRunService(dependencies: { repository: MontageAlternativeRepository }) {
  return async function execute(request: { workspaceId: string; projectId: string; runId: string }) {
    const run = await dependencies.repository.read({ workspaceId: identity(request.workspaceId, 'workspaceId'), projectId: identity(request.projectId, 'projectId'), runId: identity(request.runId, 'runId') })
    if (!run) throw new DomainError('PROJECT_NOT_FOUND', 'montage alternative run was not found')
    return run
  }
}
