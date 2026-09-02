import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { TRANSFORMATION_MODE_CONTRACTS } from './transformation-mode-registry.ts'
import { assertTransformationBrief, type TransformationBrief, type TransformationMode } from './transformation-brief.ts'

export const TRANSFORMATION_PROVIDER_DEFINITION_SCHEMA_VERSION = 'transformation-provider-definition/v1' as const
export const TRANSFORMATION_PROVIDER_SELECTION_SCHEMA_VERSION = 'transformation-provider-selection/v1' as const
export const TRANSFORMATION_PROVIDER_HEALTH_SCHEMA_VERSION = 'transformation-provider-health/v1' as const

export type TransformationProviderTransport = 'api' | 'mcp'
export type TransformationProviderCircuitState = 'closed' | 'open' | 'half-open'
export type TransformationProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable'

export interface TransformationProviderCapability {
  id: string
  operation: string
  capabilityVersion: string
  modes: readonly TransformationMode[]
  regions: readonly string[]
  maximumDurationFrames: number
  maximumWidth: number
  maximumHeight: number
  supportsAudio: boolean
  price: Readonly<{ currency: string; fixedMinorUnits: number; perSecondMinorUnits: number }>
  qualityScoreBps: number
  dataRetention: 'none' | 'transient' | 'provider-policy'
  capabilityHash: string
}

export interface TransformationProviderDefinition {
  schemaVersion: typeof TRANSFORMATION_PROVIDER_DEFINITION_SCHEMA_VERSION
  id: string
  workspaceId: string
  displayName: string
  adapterId: string
  adapterVersion: string
  transport: TransformationProviderTransport
  credentialRef: string
  enabled: boolean
  capabilities: readonly Readonly<TransformationProviderCapability>[]
  createdAt: string
  updatedAt: string
  definitionHash: string
}

export interface TransformationProviderHealth {
  schemaVersion: typeof TRANSFORMATION_PROVIDER_HEALTH_SCHEMA_VERSION
  providerId: string
  workspaceId: string
  status: TransformationProviderHealthStatus
  circuitState: TransformationProviderCircuitState
  consecutiveFailures: number
  observedLatencyMs: number | null
  observedAt: string
  cooldownUntil?: string
  healthHash: string
}

export type TransformationProviderDiscardReason =
  | 'provider-disabled'
  | 'capability-missing'
  | 'region-unsupported'
  | 'duration-exceeded'
  | 'dimensions-exceeded'
  | 'audio-unsupported'
  | 'quality-below-policy'
  | 'cost-above-policy'
  | 'health-unavailable'
  | 'circuit-open'
  | 'half-open-probe-reserved'

export interface TransformationProviderCandidateDecision {
  providerId: string
  capabilityId?: string
  eligible: boolean
  reasons: readonly TransformationProviderDiscardReason[]
  estimatedCostMinorUnits?: number
  qualityScoreBps?: number
}

export interface TransformationProviderSelection {
  schemaVersion: typeof TRANSFORMATION_PROVIDER_SELECTION_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  briefId: string
  briefHash: string
  selectedProviderId?: string
  selectedCapabilityId?: string
  candidates: readonly Readonly<TransformationProviderCandidateDecision>[]
  policy: Readonly<TransformationRoutingPolicy>
  selectedReason: string
  createdAt: string
  selectionHash: string
}

export interface TransformationRoutingPolicy {
  region: string
  maximumCostMinorUnits: number
  minimumQualityScoreBps: number
  output: Readonly<{ width: number; height: number; includeAudio: boolean; fps: number }>
  halfOpenProbeProviderId?: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const CURRENCY = /^[A-Z]{3}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

function id(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function instant(value: string, field: string): string {
  assertDomain(!Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, 'INVALID_ARGUMENT', `${field} must be a canonical ISO instant`)
  return value
}

function capability(input: Omit<TransformationProviderCapability, 'capabilityHash'> & { capabilityHash?: string }): Readonly<TransformationProviderCapability> {
  assertDomain(input.modes.length > 0 && new Set(input.modes).size === input.modes.length, 'INVALID_ARGUMENT', 'Provider capability modes are invalid')
  assertDomain(input.modes.every((mode) => TRANSFORMATION_MODE_CONTRACTS[mode].providerCapability === input.operation), 'INVALID_ARGUMENT', 'Provider operation does not satisfy the declared modes')
  assertDomain(input.regions.length > 0 && input.regions.every((region) => LOCALE.test(region)), 'INVALID_ARGUMENT', 'Provider capability regions are invalid')
  assertDomain(Number.isSafeInteger(input.maximumDurationFrames) && input.maximumDurationFrames > 0, 'INVALID_ARGUMENT', 'Provider duration limit is invalid')
  assertDomain(Number.isSafeInteger(input.maximumWidth) && input.maximumWidth > 0 && Number.isSafeInteger(input.maximumHeight) && input.maximumHeight > 0, 'INVALID_ARGUMENT', 'Provider dimension limit is invalid')
  assertDomain(CURRENCY.test(input.price.currency) && Number.isSafeInteger(input.price.fixedMinorUnits) && input.price.fixedMinorUnits >= 0 && Number.isSafeInteger(input.price.perSecondMinorUnits) && input.price.perSecondMinorUnits >= 0, 'INVALID_ARGUMENT', 'Provider pricing is invalid')
  assertDomain(Number.isSafeInteger(input.qualityScoreBps) && input.qualityScoreBps >= 0 && input.qualityScoreBps <= 10_000, 'INVALID_ARGUMENT', 'Provider quality score is invalid')
  const body = Object.freeze({
    id: id(input.id, 'capability.id'),
    operation: id(input.operation, 'capability.operation'),
    capabilityVersion: id(input.capabilityVersion, 'capability.capabilityVersion'),
    modes: Object.freeze([...input.modes].toSorted()),
    regions: Object.freeze([...input.regions].toSorted()),
    maximumDurationFrames: input.maximumDurationFrames,
    maximumWidth: input.maximumWidth,
    maximumHeight: input.maximumHeight,
    supportsAudio: input.supportsAudio,
    price: Object.freeze({ ...input.price }),
    qualityScoreBps: input.qualityScoreBps,
    dataRetention: input.dataRetention,
  })
  const capabilityHash = calculateCanonicalHash(body)
  assertDomain(input.capabilityHash === undefined || input.capabilityHash === capabilityHash, 'PERSISTENCE_CONFLICT', 'Provider capability hash is invalid')
  return Object.freeze({ ...body, capabilityHash })
}

export function createTransformationProviderDefinition(input: Omit<TransformationProviderDefinition, 'schemaVersion' | 'definitionHash' | 'capabilities'> & { capabilities: readonly (Omit<TransformationProviderCapability, 'capabilityHash'> & { capabilityHash?: string })[]; definitionHash?: string }): Readonly<TransformationProviderDefinition> {
  assertDomain(input.displayName.trim().length >= 2 && input.displayName.trim().length <= 120, 'INVALID_ARGUMENT', 'Provider display name is invalid')
  assertDomain(input.capabilities.length > 0, 'INVALID_ARGUMENT', 'Provider must expose at least one capability')
  const capabilities = Object.freeze(input.capabilities.map(capability).toSorted((left, right) => left.id.localeCompare(right.id)))
  assertDomain(new Set(capabilities.map((item) => item.id)).size === capabilities.length, 'INVALID_ARGUMENT', 'Provider capability ids must be unique')
  const body = Object.freeze({
    schemaVersion: TRANSFORMATION_PROVIDER_DEFINITION_SCHEMA_VERSION,
    id: id(input.id, 'provider.id'),
    workspaceId: id(input.workspaceId, 'provider.workspaceId'),
    displayName: input.displayName.trim(),
    adapterId: id(input.adapterId, 'provider.adapterId'),
    adapterVersion: id(input.adapterVersion, 'provider.adapterVersion'),
    transport: input.transport,
    credentialRef: id(input.credentialRef, 'provider.credentialRef'),
    enabled: input.enabled,
    capabilities,
    createdAt: instant(input.createdAt, 'provider.createdAt'),
    updatedAt: instant(input.updatedAt, 'provider.updatedAt'),
  })
  const definitionHash = calculateCanonicalHash(body)
  assertDomain(input.definitionHash === undefined || input.definitionHash === definitionHash, 'PERSISTENCE_CONFLICT', 'Provider definition hash is invalid')
  return Object.freeze({ ...body, definitionHash })
}

export function createTransformationProviderHealth(input: Omit<TransformationProviderHealth, 'schemaVersion' | 'healthHash'> & { healthHash?: string }): Readonly<TransformationProviderHealth> {
  assertDomain(Number.isSafeInteger(input.consecutiveFailures) && input.consecutiveFailures >= 0, 'INVALID_ARGUMENT', 'consecutiveFailures is invalid')
  assertDomain(input.observedLatencyMs === null || (Number.isSafeInteger(input.observedLatencyMs) && input.observedLatencyMs >= 0), 'INVALID_ARGUMENT', 'observedLatencyMs is invalid')
  assertDomain(input.circuitState !== 'open' || Boolean(input.cooldownUntil), 'INVALID_ARGUMENT', 'Open circuits require a cooldown')
  const body = Object.freeze({
    schemaVersion: TRANSFORMATION_PROVIDER_HEALTH_SCHEMA_VERSION,
    providerId: id(input.providerId, 'health.providerId'),
    workspaceId: id(input.workspaceId, 'health.workspaceId'),
    status: input.status,
    circuitState: input.circuitState,
    consecutiveFailures: input.consecutiveFailures,
    observedLatencyMs: input.observedLatencyMs,
    observedAt: instant(input.observedAt, 'health.observedAt'),
    ...(input.cooldownUntil ? { cooldownUntil: instant(input.cooldownUntil, 'health.cooldownUntil') } : {}),
  })
  const healthHash = calculateCanonicalHash(body)
  assertDomain(input.healthHash === undefined || input.healthHash === healthHash, 'PERSISTENCE_CONFLICT', 'Provider health hash is invalid')
  return Object.freeze({ ...body, healthHash })
}

export function transitionTransformationProviderHealth(input: {
  current: Readonly<TransformationProviderHealth>
  outcome: 'success' | 'failure'
  observedAt: string
  observedLatencyMs?: number
  failureThreshold: number
  cooldownMs: number
}): Readonly<TransformationProviderHealth> {
  assertDomain(Number.isSafeInteger(input.failureThreshold) && input.failureThreshold >= 1 && Number.isSafeInteger(input.cooldownMs) && input.cooldownMs >= 1_000, 'INVALID_ARGUMENT', 'Circuit policy is invalid')
  const failures = input.outcome === 'success' ? 0 : input.current.consecutiveFailures + 1
  const open = failures >= input.failureThreshold
  return createTransformationProviderHealth({
    providerId: input.current.providerId,
    workspaceId: input.current.workspaceId,
    status: input.outcome === 'success' ? 'healthy' : open ? 'unavailable' : 'degraded',
    circuitState: open ? 'open' : 'closed',
    consecutiveFailures: failures,
    observedLatencyMs: input.observedLatencyMs ?? null,
    observedAt: input.observedAt,
    ...(open ? { cooldownUntil: new Date(Date.parse(input.observedAt) + input.cooldownMs).toISOString() } : {}),
  })
}

function estimateCost(capability: Readonly<TransformationProviderCapability>, durationFrames: number, fps: number): number {
  const seconds = Math.ceil(durationFrames / fps)
  return capability.price.fixedMinorUnits + capability.price.perSecondMinorUnits * seconds
}

export function routeTransformationProvider(input: {
  brief: Readonly<TransformationBrief>
  providers: readonly Readonly<TransformationProviderDefinition>[]
  health: readonly Readonly<TransformationProviderHealth>[]
  policy: Readonly<TransformationRoutingPolicy>
  createdAt: string
}): Readonly<TransformationProviderSelection> {
  const brief = assertTransformationBrief(input.brief)
  assertDomain(Number.isSafeInteger(input.policy.maximumCostMinorUnits) && input.policy.maximumCostMinorUnits >= 0, 'INVALID_ARGUMENT', 'maximumCostMinorUnits is invalid')
  assertDomain(Number.isSafeInteger(input.policy.minimumQualityScoreBps) && input.policy.minimumQualityScoreBps >= 0 && input.policy.minimumQualityScoreBps <= 10_000, 'INVALID_ARGUMENT', 'minimumQualityScoreBps is invalid')
  assertDomain(Number.isSafeInteger(input.policy.output.fps) && input.policy.output.fps > 0, 'INVALID_ARGUMENT', 'output fps is invalid')
  const healthByProvider = new Map(input.health.map((item) => [item.providerId, item]))

  const decisions = input.providers.map((provider): TransformationProviderCandidateDecision => {
    const reasons: TransformationProviderDiscardReason[] = []
    if (provider.workspaceId !== brief.workspaceId || !provider.enabled) reasons.push('provider-disabled')
    const matching = provider.capabilities.filter((item) => item.modes.includes(brief.mode))
    if (matching.length === 0) {
      const missingReasons: TransformationProviderDiscardReason[] = [...reasons, 'capability-missing']
      return Object.freeze({ providerId: provider.id, eligible: false, reasons: Object.freeze(missingReasons) })
    }
    const candidate = matching.toSorted((left, right) => right.qualityScoreBps - left.qualityScoreBps || left.id.localeCompare(right.id))[0]!
    if (!candidate.regions.includes(input.policy.region)) reasons.push('region-unsupported')
    if (candidate.maximumDurationFrames < brief.durationFrames) reasons.push('duration-exceeded')
    if (candidate.maximumWidth < input.policy.output.width || candidate.maximumHeight < input.policy.output.height) reasons.push('dimensions-exceeded')
    if (input.policy.output.includeAudio && !candidate.supportsAudio) reasons.push('audio-unsupported')
    if (candidate.qualityScoreBps < input.policy.minimumQualityScoreBps) reasons.push('quality-below-policy')
    const estimatedCostMinorUnits = estimateCost(candidate, brief.durationFrames, input.policy.output.fps)
    if (estimatedCostMinorUnits > input.policy.maximumCostMinorUnits) reasons.push('cost-above-policy')
    const observed = healthByProvider.get(provider.id)
    if (!observed || observed.status === 'unavailable') reasons.push('health-unavailable')
    if (observed?.circuitState === 'open' && (!observed.cooldownUntil || Date.parse(observed.cooldownUntil) > Date.parse(input.createdAt))) reasons.push('circuit-open')
    if (observed?.circuitState === 'half-open' && input.policy.halfOpenProbeProviderId !== provider.id) reasons.push('half-open-probe-reserved')
    return Object.freeze({ providerId: provider.id, capabilityId: candidate.id, eligible: reasons.length === 0, reasons: Object.freeze(reasons), estimatedCostMinorUnits, qualityScoreBps: candidate.qualityScoreBps })
  })
  const ordered = Object.freeze(decisions.toSorted((left, right) => Number(right.eligible) - Number(left.eligible) || (right.qualityScoreBps ?? -1) - (left.qualityScoreBps ?? -1) || (left.estimatedCostMinorUnits ?? Number.MAX_SAFE_INTEGER) - (right.estimatedCostMinorUnits ?? Number.MAX_SAFE_INTEGER) || left.providerId.localeCompare(right.providerId)))
  const selected = ordered.find((item) => item.eligible)
  const body = Object.freeze({
    schemaVersion: TRANSFORMATION_PROVIDER_SELECTION_SCHEMA_VERSION,
    workspaceId: brief.workspaceId,
    projectId: brief.projectId,
    projectVersionId: brief.projectVersionId,
    briefId: brief.id,
    briefHash: brief.briefHash,
    ...(selected ? { selectedProviderId: selected.providerId, selectedCapabilityId: selected.capabilityId } : {}),
    candidates: ordered,
    policy: Object.freeze({ ...input.policy, output: Object.freeze({ ...input.policy.output }) }),
    selectedReason: selected ? `eligible:${selected.providerId}:${selected.capabilityId}` : 'no-eligible-provider',
    createdAt: instant(input.createdAt, 'selection.createdAt'),
  })
  const selectionHash = calculateCanonicalHash(body)
  return Object.freeze({ ...body, id: `transformation-provider-selection-${selectionHash.slice(0, 32)}`, selectionHash })
}
