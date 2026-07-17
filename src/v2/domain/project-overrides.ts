import { createHash } from 'node:crypto'
import { assertDomain } from './errors.ts'

export const PROJECT_OVERRIDE_ELEMENTS = ['logo', 'instagramHandle', 'youtubeHandle', 'professionalName', 'companyName', 'intro', 'colors', 'guardrails', 'subtitleStyle', 'gradePreset'] as const
export type ProjectOverrideElement = (typeof PROJECT_OVERRIDE_ELEMENTS)[number]
export type ProjectOverride = { mode: 'inherit' } | { mode: 'none' } | { mode: 'custom'; value: unknown }
export type ProjectOverrides = Partial<Record<ProjectOverrideElement, ProjectOverride>>

export function normalizeProjectOverrides(input: unknown): Readonly<ProjectOverrides> {
  assertDomain(typeof input === 'object' && input !== null && !Array.isArray(input), 'INVALID_ARGUMENT', 'overrides must be an object')
  const output: ProjectOverrides = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    assertDomain(PROJECT_OVERRIDE_ELEMENTS.includes(key as ProjectOverrideElement), 'INVALID_ARGUMENT', `Unsupported override element ${key}`)
    assertDomain(typeof raw === 'object' && raw !== null && 'mode' in raw, 'INVALID_ARGUMENT', `Override ${key} is invalid`)
    const candidate = raw as { mode?: unknown; value?: unknown }
    assertDomain(['inherit', 'none', 'custom'].includes(String(candidate.mode)), 'INVALID_ARGUMENT', `Override ${key} mode is invalid`)
    assertDomain(candidate.mode !== 'custom' || candidate.value !== undefined, 'INVALID_ARGUMENT', `Custom override ${key} requires value`)
    output[key as ProjectOverrideElement] = candidate.mode === 'custom' ? Object.freeze({ mode: 'custom', value: candidate.value }) : Object.freeze({ mode: candidate.mode as 'inherit' | 'none' })
  }
  return Object.freeze(output)
}

export function resolveProjectOverrides(workspace: Readonly<Partial<Record<ProjectOverrideElement, unknown>>>, overrides: ProjectOverrides) {
  return Object.freeze(Object.fromEntries(PROJECT_OVERRIDE_ELEMENTS.map((element) => {
    const override = overrides[element] ?? { mode: 'inherit' as const }
    if (override.mode === 'none') return [element, Object.freeze({ value: null, origin: 'project-none' as const })]
    if (override.mode === 'custom') return [element, Object.freeze({ value: override.value, origin: 'project-custom' as const })]
    return [element, Object.freeze({ value: workspace[element] ?? null, origin: 'workspace' as const })]
  })) as Record<ProjectOverrideElement, Readonly<{ value: unknown; origin: 'workspace' | 'project-none' | 'project-custom' }>>)
}

export function projectOverridePolicySnapshot(input: { workspaceId: string; projectId: string; projectVersionId: string; overrides: ProjectOverrides }) {
  const content = { schemaVersion: 1, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, overrides: normalizeProjectOverrides(input.overrides) }
  const contentJson = JSON.stringify(content)
  return Object.freeze({ kind: 'policies', schemaVersion: 1, contentJson, contentHash: createHash('sha256').update(contentJson).digest('hex') })
}
