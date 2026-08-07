import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const PROJECT_OVERRIDE_ELEMENTS = ['logo', 'instagramHandle', 'youtubeHandle', 'professionalName', 'companyName', 'intro', 'colors', 'guardrails', 'subtitleStyle', 'gradePreset'] as const
export type ProjectOverrideElement = (typeof PROJECT_OVERRIDE_ELEMENTS)[number]
export const PROJECT_SUBTITLE_STYLES = ['kinetic', 'karaoke-box', 'karaoke-pill', 'caps-stroke', 'clean-color'] as const
export const PROJECT_GRADE_PRESETS = ['natural', 'cinema', 'quente', 'frio', 'off'] as const
export type ProjectAssetOverrideValue = Readonly<{ assetId: string; checksum: string; rightsId: string }>
export type ProjectOverrideValue = string | readonly string[] | ProjectAssetOverrideValue
export type ProjectOverride = Readonly<{ mode: 'inherit' }> | Readonly<{ mode: 'none' }> | Readonly<{ mode: 'custom'; value: ProjectOverrideValue }>
export type ProjectOverrides = Readonly<Record<ProjectOverrideElement, ProjectOverride>>
export type WorkspaceProjectPolicyValues = Readonly<Partial<Record<ProjectOverrideElement, ProjectOverrideValue>>>
export type ResolvedProjectOverrides = Readonly<Record<ProjectOverrideElement, Readonly<{
  value: ProjectOverrideValue | null
  origin: 'workspace' | 'project-none' | 'project-custom'
}>>>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HANDLE = /^@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const COLOR = /^#[0-9a-fA-F]{6}$/

function record(input: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof input === 'object' && input !== null && !Array.isArray(input), 'INVALID_ARGUMENT', `${field} must be an object`)
  return input as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(input).toSorted()
  const expected = [...keys].toSorted()
  assertDomain(actual.length === expected.length && actual.every((key, index) => key === expected[index]), 'INVALID_ARGUMENT', `${field} fields are invalid`)
}

function text(value: unknown, field: string, pattern?: RegExp): string {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  assertDomain(normalized.length > 0 && normalized.length <= 240 && (!pattern || pattern.test(normalized)), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function asset(value: unknown, field: string): ProjectAssetOverrideValue {
  const candidate = record(value, field)
  exactKeys(candidate, ['assetId', 'checksum', 'rightsId'], field)
  const assetId = text(candidate.assetId, `${field}.assetId`, ID)
  const rightsId = text(candidate.rightsId, `${field}.rightsId`, ID)
  assertDomain(typeof candidate.checksum === 'string' && /^[a-f0-9]{64}$/.test(candidate.checksum), 'INVALID_ARGUMENT', `${field}.checksum is invalid`)
  return Object.freeze({ assetId, checksum: candidate.checksum, rightsId })
}

function stringList(value: unknown, field: string, options: { colors?: boolean; allowEmpty?: boolean } = {}): readonly string[] {
  assertDomain(Array.isArray(value) && value.length <= 32 && (options.allowEmpty || value.length > 0), 'INVALID_ARGUMENT', `${field} is invalid`)
  const normalized = value.map((item, index) => text(item, `${field}[${index}]`, options.colors ? COLOR : undefined))
    .map((item) => options.colors ? item.toLowerCase() : item)
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} cannot contain duplicates`)
  return Object.freeze(normalized)
}

export function normalizeProjectOverrideValue(element: ProjectOverrideElement, value: unknown): ProjectOverrideValue {
  switch (element) {
    case 'logo':
    case 'intro': return asset(value, element)
    case 'instagramHandle':
    case 'youtubeHandle': return text(value, element, HANDLE)
    case 'professionalName':
    case 'companyName': return text(value, element)
    case 'colors': return stringList(value, element, { colors: true })
    case 'guardrails': return stringList(value, element, { allowEmpty: true })
    case 'subtitleStyle': {
      const normalized = text(value, element)
      assertDomain(PROJECT_SUBTITLE_STYLES.includes(normalized as (typeof PROJECT_SUBTITLE_STYLES)[number]), 'INVALID_ARGUMENT', `${element} is invalid`)
      return normalized
    }
    case 'gradePreset': {
      const normalized = text(value, element)
      assertDomain(PROJECT_GRADE_PRESETS.includes(normalized as (typeof PROJECT_GRADE_PRESETS)[number]), 'INVALID_ARGUMENT', `${element} is invalid`)
      return normalized
    }
  }
}

export function normalizeWorkspaceProjectPolicyValues(input: unknown): WorkspaceProjectPolicyValues {
  const candidate = input === undefined ? {} : record(input, 'workspace policy values')
  const output: Partial<Record<ProjectOverrideElement, ProjectOverrideValue>> = {}
  for (const [key, value] of Object.entries(candidate)) {
    assertDomain(PROJECT_OVERRIDE_ELEMENTS.includes(key as ProjectOverrideElement), 'INVALID_ARGUMENT', `Unsupported workspace policy element ${key}`)
    output[key as ProjectOverrideElement] = normalizeProjectOverrideValue(key as ProjectOverrideElement, value)
  }
  return Object.freeze(output)
}

export function normalizeProjectOverrides(input: unknown): Readonly<ProjectOverrides> {
  const candidate = record(input, 'overrides')
  const output = {} as Record<ProjectOverrideElement, ProjectOverride>
  for (const element of PROJECT_OVERRIDE_ELEMENTS) output[element] = Object.freeze({ mode: 'inherit' })
  for (const [key, raw] of Object.entries(candidate)) {
    assertDomain(PROJECT_OVERRIDE_ELEMENTS.includes(key as ProjectOverrideElement), 'INVALID_ARGUMENT', `Unsupported override element ${key}`)
    const override = record(raw, `Override ${key}`)
    assertDomain(['inherit', 'none', 'custom'].includes(String(override.mode)), 'INVALID_ARGUMENT', `Override ${key} mode is invalid`)
    exactKeys(override, override.mode === 'custom' ? ['mode', 'value'] : ['mode'], `Override ${key}`)
    output[key as ProjectOverrideElement] = override.mode === 'custom'
      ? Object.freeze({ mode: 'custom', value: normalizeProjectOverrideValue(key as ProjectOverrideElement, override.value) })
      : Object.freeze({ mode: override.mode as 'inherit' | 'none' })
  }
  return Object.freeze(output)
}

export function resolveProjectOverrides(workspace: WorkspaceProjectPolicyValues, overridesInput: unknown): ResolvedProjectOverrides {
  const normalizedWorkspace = normalizeWorkspaceProjectPolicyValues(workspace)
  const overrides = normalizeProjectOverrides(overridesInput)
  return Object.freeze(Object.fromEntries(PROJECT_OVERRIDE_ELEMENTS.map((element) => {
    const override = overrides[element]
    if (override.mode === 'none') return [element, Object.freeze({ value: null, origin: 'project-none' as const })]
    if (override.mode === 'custom') return [element, Object.freeze({ value: override.value, origin: 'project-custom' as const })]
    return [element, Object.freeze({ value: normalizedWorkspace[element] ?? null, origin: 'workspace' as const })]
  })) as ResolvedProjectOverrides)
}

export function projectOverridePolicySnapshot(input: { workspaceId: string; projectId: string; projectVersionId: string; workspaceDefaults?: unknown; overrides: unknown; createdAt?: string; commandId?: string }) {
  const workspaceDefaults = normalizeWorkspaceProjectPolicyValues(input.workspaceDefaults)
  const overrides = normalizeProjectOverrides(input.overrides)
  const resolved = resolveProjectOverrides(workspaceDefaults, overrides)
  const content = Object.freeze({
    schemaVersion: 2 as const,
    workspaceId: text(input.workspaceId, 'workspaceId', ID),
    projectId: text(input.projectId, 'projectId', ID),
    projectVersionId: text(input.projectVersionId, 'projectVersionId', ID),
    ...(input.commandId ? { commandId: text(input.commandId, 'commandId', ID) } : {}),
    workspaceDefaults,
    overrides,
    resolved,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })
  if (input.createdAt) assertDomain(!Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt is invalid')
  const contentJson = stableSerialize(content)
  return Object.freeze({ kind: 'policies' as const, schemaVersion: 2 as const, content, contentJson, contentHash: calculateCanonicalHash(content) })
}
