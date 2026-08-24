import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import {
  compileColorPlanTargets,
  createColorPlan,
  type ColorPlan,
  type ColorPlanTarget,
  type CompiledColorPlan,
} from './color-and-export.ts'
import { assertDomain } from './errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function id(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

export interface ProjectColorPlan {
  schemaVersion: 'project-color-plan/v1'
  id: string
  workspaceId: string
  projectId: string
  commandId: string
  baseVersionId: string
  resultVersionId: string
  plan: Readonly<ReturnType<typeof createColorPlan>>
  compiled: Readonly<CompiledColorPlan>
  createdAt: string
  recordHash: string
}

export function createProjectColorPlan(input: {
  id: string
  workspaceId: string
  projectId: string
  commandId: string
  baseVersionId: string
  resultVersionId: string
  plan: Readonly<ColorPlan>
  targets: readonly Readonly<ColorPlanTarget>[]
  createdAt: string
}): Readonly<ProjectColorPlan> {
  const createdAt = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAt.getTime()) &&
      createdAt.toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'createdAt is invalid',
  )
  const plan = createColorPlan(input.plan)
  const compiled = compileColorPlanTargets({ plan, targets: input.targets })
  const content = Object.freeze({
    schemaVersion: 'project-color-plan/v1' as const,
    id: id(input.id, 'id'),
    workspaceId: id(input.workspaceId, 'workspaceId'),
    projectId: id(input.projectId, 'projectId'),
    commandId: id(input.commandId, 'commandId'),
    baseVersionId: id(input.baseVersionId, 'baseVersionId'),
    resultVersionId: id(input.resultVersionId, 'resultVersionId'),
    plan,
    compiled,
    createdAt: input.createdAt,
  })
  return Object.freeze({
    ...content,
    recordHash: calculateCanonicalHash(content),
  })
}

export function parseProjectColorPlan(value: unknown): Readonly<ProjectColorPlan> {
  assertDomain(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'PERSISTENCE_CONFLICT',
    'Stored project ColorPlan is invalid',
  )
  const stored = value as ProjectColorPlan
  const recreated = createProjectColorPlan({
    id: stored.id,
    workspaceId: stored.workspaceId,
    projectId: stored.projectId,
    commandId: stored.commandId,
    baseVersionId: stored.baseVersionId,
    resultVersionId: stored.resultVersionId,
    plan: stored.plan,
    targets: stored.compiled?.targets?.map((target) => ({
      sourceId: target.target.sourceId ?? '',
      ...(target.target.cameraId ? { cameraId: target.target.cameraId } : {}),
      ...(target.target.segmentId ? { segmentId: target.target.segmentId } : {}),
    })) ?? [],
    createdAt: stored.createdAt,
  })
  assertDomain(
    stableSerialize(recreated) === stableSerialize(stored),
    'PERSISTENCE_CONFLICT',
    'Stored project ColorPlan is inconsistent',
  )
  return recreated
}
