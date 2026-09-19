/**
 * Aggregate resource budget for the Apollo fleet.
 *
 * The deploy script used to hand each container its own `--cpus`/`--memory`
 * with permissive defaults; the sum of those quotas exceeded the host several
 * times over, which is exactly what a shared VPS cannot absorb. This module
 * resolves ONE explicit profile into per-container quotas whose sum fits an
 * envelope, and refuses anything that is missing, unlimited, non-numeric,
 * negative or over budget — before the first mutation ever happens.
 *
 * Children (FFmpeg, Remotion, Chromium) live inside the container's cgroup, so
 * a container quota bounds the whole process tree of that worker. Work that
 * the Docker daemon performs on the fleet's behalf (`docker load`, pull,
 * decompression, hashing) is NOT inside any of these cgroups; the budget
 * cannot cover it and says so through `uncoveredHostWork`.
 *
 * Nothing here is product state: no job, version or artifact is described.
 */

export const RESOURCE_BUDGET_SCHEMA_VERSION = 'apollo-resource-budget/v1'
export const RESOURCE_BUDGET_APPROVAL_SCHEMA_VERSION = 'apollo-resource-budget-approval/v1'

/** Daemon-side steps no container cgroup bounds; blocked on the shared profile. */
export const UNCOVERED_HOST_WORK = Object.freeze([
  'docker-load',
  'docker-pull',
  'image-decompression',
  'image-hash',
  'backup',
] as const)

export interface ResourceQuota {
  readonly cpus: number
  readonly memoryBytes: number
  readonly pidsLimit: number
}

export interface ResourceEnvelope {
  readonly cpus: number
  readonly memoryBytes: number
  readonly pids: number
}

export interface HostSize {
  readonly cpus: number
  readonly memoryBytes: number
}

export interface ResolvedContainerQuota extends ResourceQuota {
  readonly role: string
  readonly optional: boolean
  readonly enabled: boolean
}

export interface ResolvedAuxiliaryQuota extends ResourceQuota {
  readonly role: string
  readonly concurrent: boolean
}

export interface ResolvedResourceBudget {
  readonly ok: true
  readonly profile: string
  readonly host: HostSize
  readonly envelope: ResourceEnvelope
  readonly containers: readonly ResolvedContainerQuota[]
  readonly auxiliaries: readonly ResolvedAuxiliaryQuota[]
  /** Enabled containers + concurrent auxiliaries + the largest sequential auxiliary. */
  readonly sum: ResourceEnvelope
  /** Envelope minus sum: what remains inside the approved envelope. */
  readonly headroom: ResourceEnvelope
  /** Host minus envelope: what the envelope leaves for other services. */
  readonly margin: HostSize
  readonly uncoveredHostWork: readonly string[]
  readonly approval: { readonly approvedBy: string; readonly approvedAtIso: string } | null
}

export interface RejectedResourceBudget {
  readonly ok: false
  readonly profile: string
  readonly errors: readonly string[]
}

export type ResourceBudgetResolution = ResolvedResourceBudget | RejectedResourceBudget

export interface ResolveResourceBudgetInput {
  readonly catalog: unknown
  readonly profile: string
  /** Which optional features are enabled; keys are the values of `roles.optional`. */
  readonly enabledFeatures?: Readonly<Record<string, boolean>>
  /** Operator-approved budget document; required by profiles with `requiresApprovedBudget`. */
  readonly approvedBudget?: unknown
}

const MEMORY_PATTERN = /^([1-9][0-9]*)([kmg])$/i
const MEMORY_MULTIPLIERS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }

/** Parses the Docker memory syntax the deploy accepts (`768m`, `2g`) or a byte count. */
export function parseMemory(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/^[1-9][0-9]*$/.test(trimmed)) return Number(trimmed)
  const match = MEMORY_PATTERN.exec(trimmed)
  if (!match) return null
  return Number(match[1]) * MEMORY_MULTIPLIERS[match[2].toLowerCase()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function quotaAt(source: unknown, path: string, errors: string[]): ResourceQuota | null {
  if (!isRecord(source)) {
    errors.push(`${path}: quota is missing`)
    return null
  }
  const { cpus, memory, pidsLimit } = source
  let valid = true
  if (!positiveFinite(cpus)) {
    errors.push(`${path}.cpus: must be a positive finite number, found ${JSON.stringify(cpus)}`)
    valid = false
  }
  const memoryBytes = parseMemory(memory)
  if (memoryBytes === null) {
    errors.push(`${path}.memory: must be a positive Docker memory limit (e.g. 512m, 2g), found ${JSON.stringify(memory)}`)
    valid = false
  }
  if (!positiveInteger(pidsLimit)) {
    errors.push(`${path}.pidsLimit: must be a positive integer, found ${JSON.stringify(pidsLimit)}`)
    valid = false
  }
  if (!valid) return null
  return { cpus: cpus as number, memoryBytes: memoryBytes as number, pidsLimit: pidsLimit as number }
}

function envelopeAt(source: unknown, path: string, errors: string[]): ResourceEnvelope | null {
  if (!isRecord(source)) {
    errors.push(`${path}: envelope is missing`)
    return null
  }
  const { cpus, memory, pids } = source
  let valid = true
  if (!positiveFinite(cpus)) {
    errors.push(`${path}.cpus: must be a positive finite number, found ${JSON.stringify(cpus)}`)
    valid = false
  }
  const memoryBytes = parseMemory(memory)
  if (memoryBytes === null) {
    errors.push(`${path}.memory: must be a positive memory limit, found ${JSON.stringify(memory)}`)
    valid = false
  }
  if (!positiveInteger(pids)) {
    errors.push(`${path}.pids: must be a positive integer, found ${JSON.stringify(pids)}`)
    valid = false
  }
  if (!valid) return null
  return { cpus: cpus as number, memoryBytes: memoryBytes as number, pids: pids as number }
}

function hostAt(source: unknown, path: string, errors: string[]): HostSize | null {
  if (!isRecord(source)) {
    errors.push(`${path}: host size is missing`)
    return null
  }
  const { cpus, memory } = source
  let valid = true
  if (!positiveInteger(cpus)) {
    errors.push(`${path}.cpus: must be a positive integer count of host CPUs, found ${JSON.stringify(cpus)}`)
    valid = false
  }
  const memoryBytes = parseMemory(memory)
  if (memoryBytes === null) {
    errors.push(`${path}.memory: must be a positive memory size, found ${JSON.stringify(memory)}`)
    valid = false
  }
  if (!valid) return null
  return { cpus: cpus as number, memoryBytes: memoryBytes as number }
}

interface RoleCatalog {
  readonly containers: readonly string[]
  readonly optional: Readonly<Record<string, string>>
  readonly auxiliaries: Readonly<Record<string, { readonly concurrent: boolean }>>
}

function rolesAt(catalog: Record<string, unknown>, errors: string[]): RoleCatalog | null {
  const roles = catalog.roles
  if (!isRecord(roles)) {
    errors.push('roles: missing')
    return null
  }
  const containers = roles.containers
  if (!Array.isArray(containers) || containers.length === 0 || !containers.every((role) => typeof role === 'string' && role.length > 0)) {
    errors.push('roles.containers: must be a non-empty list of role names')
    return null
  }
  if (new Set(containers).size !== containers.length) {
    errors.push('roles.containers: role names must be unique')
    return null
  }
  const optional: Record<string, string> = {}
  if (roles.optional !== undefined) {
    if (!isRecord(roles.optional)) {
      errors.push('roles.optional: must map role → feature')
      return null
    }
    for (const [role, feature] of Object.entries(roles.optional)) {
      if (!containers.includes(role) || typeof feature !== 'string' || feature.length === 0) {
        errors.push(`roles.optional.${role}: must name a known container role and a feature`)
        return null
      }
      optional[role] = feature
    }
  }
  const auxiliaries: Record<string, { concurrent: boolean }> = {}
  if (roles.auxiliaries !== undefined) {
    if (!isRecord(roles.auxiliaries)) {
      errors.push('roles.auxiliaries: must map role → { concurrent }')
      return null
    }
    for (const [role, definition] of Object.entries(roles.auxiliaries)) {
      if (!isRecord(definition) || typeof definition.concurrent !== 'boolean') {
        errors.push(`roles.auxiliaries.${role}: must declare concurrent: true|false`)
        return null
      }
      auxiliaries[role] = { concurrent: definition.concurrent }
    }
  }
  return { containers, optional, auxiliaries }
}

interface QuotaSource {
  readonly host: HostSize
  readonly envelope: ResourceEnvelope
  readonly containers: Readonly<Record<string, ResourceQuota>>
  readonly auxiliaries: Readonly<Record<string, ResourceQuota>>
}

function quotaSourceAt(source: Record<string, unknown>, path: string, roles: RoleCatalog, errors: string[]): QuotaSource | null {
  const host = hostAt(source.host, `${path}.host`, errors)
  const envelope = envelopeAt(source.envelope, `${path}.envelope`, errors)
  const containers: Record<string, ResourceQuota> = {}
  const containerSource = isRecord(source.containers) ? source.containers : null
  if (!containerSource) errors.push(`${path}.containers: missing`)
  for (const role of roles.containers) {
    const quota = quotaAt(containerSource?.[role], `${path}.containers.${role}`, errors)
    if (quota) containers[role] = quota
  }
  if (containerSource) {
    for (const role of Object.keys(containerSource)) {
      if (!roles.containers.includes(role)) errors.push(`${path}.containers.${role}: unknown role`)
    }
  }
  const auxiliaries: Record<string, ResourceQuota> = {}
  const auxiliarySource = isRecord(source.auxiliaries) ? source.auxiliaries : null
  if (!auxiliarySource && Object.keys(roles.auxiliaries).length > 0) errors.push(`${path}.auxiliaries: missing`)
  for (const role of Object.keys(roles.auxiliaries)) {
    const quota = quotaAt(auxiliarySource?.[role], `${path}.auxiliaries.${role}`, errors)
    if (quota) auxiliaries[role] = quota
  }
  if (auxiliarySource) {
    for (const role of Object.keys(auxiliarySource)) {
      if (!(role in roles.auxiliaries)) errors.push(`${path}.auxiliaries.${role}: unknown auxiliary`)
    }
  }
  if (!host || !envelope || errors.length > 0) return null
  return { host, envelope, containers, auxiliaries }
}

function sumQuotas(quotas: readonly ResourceQuota[]): ResourceEnvelope {
  return quotas.reduce<ResourceEnvelope>(
    (total, quota) => ({
      cpus: roundCpus(total.cpus + quota.cpus),
      memoryBytes: total.memoryBytes + quota.memoryBytes,
      pids: total.pids + quota.pidsLimit,
    }),
    { cpus: 0, memoryBytes: 0, pids: 0 },
  )
}

function roundCpus(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Resolves a profile into enforceable quotas or a list of reasons to refuse.
 * Never throws on bad input: a rejection is the fail-closed answer.
 */
export function resolveResourceBudget(input: ResolveResourceBudgetInput): ResourceBudgetResolution {
  const errors: string[] = []
  const reject = (): RejectedResourceBudget => ({ ok: false, profile: input.profile, errors: Object.freeze([...errors]) })
  if (!isRecord(input.catalog)) {
    errors.push('catalog: must be an object')
    return reject()
  }
  if (input.catalog.schemaVersion !== RESOURCE_BUDGET_SCHEMA_VERSION) {
    errors.push(`catalog.schemaVersion: expected ${RESOURCE_BUDGET_SCHEMA_VERSION}, found ${JSON.stringify(input.catalog.schemaVersion)}`)
    return reject()
  }
  const roles = rolesAt(input.catalog, errors)
  if (!roles) return reject()
  const profiles = isRecord(input.catalog.profiles) ? input.catalog.profiles : null
  const profile = profiles && isRecord(profiles[input.profile]) ? (profiles[input.profile] as Record<string, unknown>) : null
  if (!profile) {
    errors.push(`profiles.${input.profile}: unknown profile`)
    return reject()
  }

  const enabledFeatures = input.enabledFeatures ?? {}
  for (const feature of new Set(Object.values(roles.optional))) {
    if (typeof enabledFeatures[feature] !== 'boolean') {
      errors.push(`enabledFeatures.${feature}: must be declared true or false (optional role gate)`)
    }
  }
  if (errors.length > 0) return reject()

  let source: QuotaSource | null = null
  let approval: ResolvedResourceBudget['approval'] = null
  if (profile.requiresApprovedBudget === true) {
    const marginRatio = profile.minimumCpuMarginRatio
    const reserve = parseMemory(profile.minimumMemoryReserve)
    if (!positiveFinite(marginRatio) || (marginRatio as number) >= 1) {
      errors.push(`profiles.${input.profile}.minimumCpuMarginRatio: must be in (0, 1)`)
    }
    if (reserve === null) errors.push(`profiles.${input.profile}.minimumMemoryReserve: must be a positive memory size`)
    if (!isRecord(input.approvedBudget)) {
      errors.push(`profiles.${input.profile}: requires an operator-approved budget document; none was provided`)
      return reject()
    }
    const approved = input.approvedBudget
    if (approved.schemaVersion !== RESOURCE_BUDGET_APPROVAL_SCHEMA_VERSION) {
      errors.push(`approvedBudget.schemaVersion: expected ${RESOURCE_BUDGET_APPROVAL_SCHEMA_VERSION}, found ${JSON.stringify(approved.schemaVersion)}`)
    }
    if (typeof approved.approvedBy !== 'string' || approved.approvedBy.trim().length === 0) {
      errors.push('approvedBudget.approvedBy: must name the approving operator')
    }
    if (typeof approved.approvedAtIso !== 'string' || Number.isNaN(Date.parse(approved.approvedAtIso))) {
      errors.push('approvedBudget.approvedAtIso: must be an ISO-8601 timestamp')
    }
    if (approved.profile !== input.profile) {
      errors.push(`approvedBudget.profile: must be ${JSON.stringify(input.profile)}, found ${JSON.stringify(approved.profile)}`)
    }
    if (errors.length > 0) return reject()
    source = quotaSourceAt(approved, 'approvedBudget', roles, errors)
    if (!source) return reject()
    const maximumEnvelopeCpus = roundCpus(source.host.cpus * (1 - (marginRatio as number)))
    if (source.envelope.cpus > maximumEnvelopeCpus) {
      errors.push(
        `approvedBudget.envelope.cpus: ${source.envelope.cpus} exceeds ${maximumEnvelopeCpus} ` +
          `(host ${source.host.cpus} CPUs minus the ${(marginRatio as number) * 100}% margin reserved for other services)`,
      )
    }
    if (source.envelope.memoryBytes > source.host.memoryBytes - (reserve as number)) {
      errors.push(
        `approvedBudget.envelope.memory: ${source.envelope.memoryBytes} bytes leaves less than the ${reserve} byte reserve on a ${source.host.memoryBytes} byte host`,
      )
    }
    approval = { approvedBy: (approved.approvedBy as string).trim(), approvedAtIso: approved.approvedAtIso as string }
  } else {
    source = quotaSourceAt(profile, `profiles.${input.profile}`, roles, errors)
    if (!source) return reject()
    if (source.envelope.cpus > source.host.cpus) {
      errors.push(`profiles.${input.profile}.envelope.cpus: ${source.envelope.cpus} exceeds the ${source.host.cpus} host CPUs`)
    }
    if (source.envelope.memoryBytes > source.host.memoryBytes) {
      errors.push(`profiles.${input.profile}.envelope.memory: exceeds the host memory`)
    }
  }
  if (errors.length > 0) return reject()

  const containers: ResolvedContainerQuota[] = roles.containers.map((role) => {
    const feature = roles.optional[role]
    const optional = feature !== undefined
    const enabled = optional ? enabledFeatures[feature] === true : true
    return { role, optional, enabled, ...source!.containers[role] }
  })
  const auxiliaries: ResolvedAuxiliaryQuota[] = Object.keys(roles.auxiliaries).map((role) => ({
    role,
    concurrent: roles.auxiliaries[role].concurrent,
    ...source!.auxiliaries[role],
  }))

  const concurrent = auxiliaries.filter((auxiliary) => auxiliary.concurrent)
  const sequential = auxiliaries.filter((auxiliary) => !auxiliary.concurrent)
  // Sequential auxiliaries (config check, migrations) run one at a time, but
  // they run while the whole fleet is still up — so the largest of them is
  // charged against the envelope, on top of everything concurrent.
  const largestSequential = sequential.reduce<ResourceQuota | null>((largest, candidate) => {
    if (!largest) return candidate
    return candidate.cpus > largest.cpus || (candidate.cpus === largest.cpus && candidate.memoryBytes > largest.memoryBytes)
      ? candidate
      : largest
  }, null)
  const charged: ResourceQuota[] = [
    ...containers.filter((container) => container.enabled),
    ...concurrent,
    ...(largestSequential ? [largestSequential] : []),
  ]
  const sum = sumQuotas(charged)
  if (sum.cpus > source.envelope.cpus) {
    errors.push(`sum.cpus: ${sum.cpus} exceeds the envelope of ${source.envelope.cpus} CPUs`)
  }
  if (sum.memoryBytes > source.envelope.memoryBytes) {
    errors.push(`sum.memory: ${sum.memoryBytes} bytes exceeds the envelope of ${source.envelope.memoryBytes} bytes`)
  }
  if (sum.pids > source.envelope.pids) {
    errors.push(`sum.pids: ${sum.pids} exceeds the envelope of ${source.envelope.pids} pids`)
  }
  if (errors.length > 0) return reject()

  return Object.freeze({
    ok: true,
    profile: input.profile,
    host: source.host,
    envelope: source.envelope,
    containers: Object.freeze(containers),
    auxiliaries: Object.freeze(auxiliaries),
    sum,
    headroom: {
      cpus: roundCpus(source.envelope.cpus - sum.cpus),
      memoryBytes: source.envelope.memoryBytes - sum.memoryBytes,
      pids: source.envelope.pids - sum.pids,
    },
    margin: {
      cpus: roundCpus(source.host.cpus - source.envelope.cpus),
      memoryBytes: source.host.memoryBytes - source.envelope.memoryBytes,
    },
    uncoveredHostWork: UNCOVERED_HOST_WORK,
    approval,
  })
}

/** `docker run` arguments that enforce one quota; bytes are passed exactly, never re-rounded. */
export function dockerRunLimitArguments(quota: ResourceQuota): readonly string[] {
  return Object.freeze([
    '--cpus',
    String(quota.cpus),
    '--memory',
    `${quota.memoryBytes}b`,
    '--memory-swap',
    `${quota.memoryBytes}b`,
    '--pids-limit',
    String(quota.pidsLimit),
  ])
}

export interface ObservedContainerLimits {
  /** `HostConfig.NanoCpus` from `docker inspect`. */
  readonly nanoCpus: number
  /** `HostConfig.Memory` from `docker inspect`. */
  readonly memoryBytes: number
  /** `HostConfig.MemorySwap` from `docker inspect`. */
  readonly memorySwapBytes: number
  /** `HostConfig.PidsLimit` from `docker inspect`. */
  readonly pidsLimit: number
}

/**
 * Compares a started container's inspected limits with the quota it was given.
 * An empty list means the daemon really applied the quota.
 */
export function readbackMismatches(quota: ResourceQuota, observed: ObservedContainerLimits): readonly string[] {
  const mismatches: string[] = []
  const expectedNanoCpus = Math.round(quota.cpus * 1e9)
  if (observed.nanoCpus !== expectedNanoCpus) mismatches.push(`NanoCpus: expected ${expectedNanoCpus}, observed ${observed.nanoCpus}`)
  if (observed.memoryBytes !== quota.memoryBytes) mismatches.push(`Memory: expected ${quota.memoryBytes}, observed ${observed.memoryBytes}`)
  if (observed.memorySwapBytes !== quota.memoryBytes) {
    mismatches.push(`MemorySwap: expected ${quota.memoryBytes} (no swap beyond the limit), observed ${observed.memorySwapBytes}`)
  }
  if (observed.pidsLimit !== quota.pidsLimit) mismatches.push(`PidsLimit: expected ${quota.pidsLimit}, observed ${observed.pidsLimit}`)
  return Object.freeze(mismatches)
}

export interface CgroupCapability {
  readonly cgroupVersion: string
  readonly cgroupDriver: string
  readonly warnings: readonly string[]
}

/**
 * Whether the daemon can enforce CPU, memory and pids quotas: cgroup v2 with
 * no daemon warning about missing limit support. Anything else fails closed.
 */
export function cgroupEnforcementIssues(capability: CgroupCapability): readonly string[] {
  const issues: string[] = []
  if (capability.cgroupVersion.trim() !== '2') {
    issues.push(`cgroup version ${JSON.stringify(capability.cgroupVersion)} is not supported; the budget requires cgroup v2`)
  }
  if (!['systemd', 'cgroupfs'].includes(capability.cgroupDriver.trim())) {
    issues.push(`cgroup driver ${JSON.stringify(capability.cgroupDriver)} is not recognised`)
  }
  for (const warning of capability.warnings) {
    if (/no (memory|swap|cpu|pids|cfs) .*support/i.test(warning) || /limit support/i.test(warning)) {
      issues.push(`daemon warning: ${warning.trim()}`)
    }
  }
  return Object.freeze(issues)
}
