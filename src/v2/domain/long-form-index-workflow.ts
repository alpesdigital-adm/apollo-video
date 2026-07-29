import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const LONG_FORM_INDEX_WORKFLOW_SCHEMA_VERSION =
  'long-form-index-workflow/v1' as const
export const LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION =
  'long-form-index-workflow-policy/v1' as const

export const LONG_FORM_INDEX_STAGES = [
  'probe',
  'transcript',
  'diarization',
  'chunks',
  'moments',
] as const

export type LongFormIndexStage =
  (typeof LONG_FORM_INDEX_STAGES)[number]

export const LONG_FORM_INDEX_STAGE_DEPENDENCIES:
Readonly<Record<LongFormIndexStage, readonly LongFormIndexStage[]>> =
  Object.freeze({
    probe: Object.freeze([] as LongFormIndexStage[]),
    transcript: Object.freeze(
      ['probe'] as LongFormIndexStage[],
    ),
    diarization: Object.freeze(
      ['transcript'] as LongFormIndexStage[],
    ),
    chunks: Object.freeze(
      ['transcript', 'diarization'] as LongFormIndexStage[],
    ),
    moments: Object.freeze(
      ['chunks'] as LongFormIndexStage[],
    ),
  })

export type LongFormIndexStageStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'budget-blocked'

export interface LongFormIndexStageVersion {
  provider: string
  model: string
  version: string
}

export interface LongFormIndexStageBudget {
  estimatedCostMinorUnits: number
  maximumCostMinorUnits: number
  maximumElapsedMs: number
}

export interface LongFormIndexStageCheckpoint {
  stage: LongFormIndexStage
  sequence: number
  prerequisites: readonly LongFormIndexStage[]
  execution: 'process' | 'reuse'
  status: LongFormIndexStageStatus
  version: Readonly<LongFormIndexStageVersion>
  budget: Readonly<LongFormIndexStageBudget>
  concurrency: number
  inputHash: string
  idempotencyKey: string
  attempt: number
  outputHash?: string
  resultCount: number
  searchable: boolean
  costMinorUnits: number
  elapsedMs: number
  startedAt?: string
  completedAt?: string
  error?: Readonly<{
    code: string
    message: string
    retryable: boolean
  }>
  stageHash: string
}

export interface LongFormIndexWorkflow {
  schemaVersion: typeof LONG_FORM_INDEX_WORKFLOW_SCHEMA_VERSION
  policyVersion: typeof LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId?: string
  sourceTranscriptHash?: string
  durationMs: number
  status: 'queued' | 'running' | 'partial' | 'succeeded' | 'failed'
  stages: readonly Readonly<LongFormIndexStageCheckpoint>[]
  budget: Readonly<{
    currency: 'USD'
    maximumCostMinorUnits: number
    maximumElapsedMs: number
    maximumConcurrency: number
  }>
  summary: Readonly<{
    completedStageCount: number
    searchableStageCount: number
    resultCount: number
    costMinorUnits: number
    elapsedMs: number
    nextStage?: LongFormIndexStage
    duplicateSegments: false
    resumable: true
  }>
  createdByClientId: string
  createdAt: string
  updatedAt: string
  runHash: string
}

type StageVersions = Readonly<
  Record<LongFormIndexStage, Readonly<LongFormIndexStageVersion>>
>
type StageBudgets = Readonly<
  Record<LongFormIndexStage, Readonly<LongFormIndexStageBudget>>
>
type ReusableOutputs = Readonly<
  Partial<Record<LongFormIndexStage, Readonly<{
    outputHash: string
    resultCount: number
  }>>>
>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const ERROR_CODE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function token(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function normalizeVersion(
  value: Readonly<LongFormIndexStageVersion>,
  field: string,
): Readonly<LongFormIndexStageVersion> {
  return Object.freeze({
    provider: token(value?.provider, `${field}.provider`),
    model: token(value?.model, `${field}.model`),
    version: token(value?.version, `${field}.version`),
  })
}

function normalizeStageBudget(
  value: Readonly<LongFormIndexStageBudget>,
  field: string,
): Readonly<LongFormIndexStageBudget> {
  const estimatedCostMinorUnits = integer(
    value?.estimatedCostMinorUnits,
    `${field}.estimatedCostMinorUnits`,
    0,
    10_000_000,
  )
  const maximumCostMinorUnits = integer(
    value?.maximumCostMinorUnits,
    `${field}.maximumCostMinorUnits`,
    0,
    10_000_000,
  )
  assertDomain(
    estimatedCostMinorUnits <= maximumCostMinorUnits,
    'INVALID_ARGUMENT',
    `${field} estimate exceeds its maximum`,
  )
  return Object.freeze({
    estimatedCostMinorUnits,
    maximumCostMinorUnits,
    maximumElapsedMs: integer(
      value?.maximumElapsedMs,
      `${field}.maximumElapsedMs`,
      1,
      24 * 60 * 60 * 1_000,
    ),
  })
}

function concurrencyFor(
  stage: LongFormIndexStage,
  durationMs: number,
  maximumConcurrency: number,
): number {
  if (stage !== 'chunks' && stage !== 'moments') return 1
  return Math.min(
    maximumConcurrency,
    Math.max(1, Math.ceil(durationMs / 1_800_000)),
  )
}

function freezeStage(
  value:
    | Omit<LongFormIndexStageCheckpoint, 'stageHash'>
    | LongFormIndexStageCheckpoint,
): Readonly<LongFormIndexStageCheckpoint> {
  const { stageHash: _previousHash, ...withoutHash } =
    value as LongFormIndexStageCheckpoint
  const body = Object.freeze({
    ...withoutHash,
    prerequisites: Object.freeze([...withoutHash.prerequisites]),
    version: Object.freeze({ ...withoutHash.version }),
    budget: Object.freeze({ ...withoutHash.budget }),
    ...(withoutHash.error
      ? { error: Object.freeze({ ...withoutHash.error }) }
      : {}),
  })
  return Object.freeze({
    ...body,
    stageHash: calculateCanonicalHash(body),
  })
}

function nextReadyStage(
  stages: readonly Readonly<LongFormIndexStageCheckpoint>[],
): LongFormIndexStage | undefined {
  return stages.find((stage) => stage.status === 'ready')?.stage
}

function workflowStatus(
  stages: readonly Readonly<LongFormIndexStageCheckpoint>[],
): LongFormIndexWorkflow['status'] {
  if (stages.every((stage) => stage.status === 'succeeded')) {
    return 'succeeded'
  }
  if (stages.some((stage) => stage.status === 'running')) {
    return 'running'
  }
  if (stages.some((stage) =>
    stage.status === 'failed' && !stage.error?.retryable)) {
    return 'failed'
  }
  if (stages.some((stage) =>
    stage.status === 'succeeded' && stage.searchable)) {
    return 'partial'
  }
  return 'queued'
}

function summary(
  stages: readonly Readonly<LongFormIndexStageCheckpoint>[],
): LongFormIndexWorkflow['summary'] {
  const completed = stages.filter((stage) =>
    stage.status === 'succeeded')
  const nextStage = nextReadyStage(stages)
  return Object.freeze({
    completedStageCount: completed.length,
    searchableStageCount: completed.filter((stage) =>
      stage.searchable).length,
    resultCount: completed.reduce(
      (total, stage) => total + stage.resultCount,
      0,
    ),
    costMinorUnits: completed.reduce(
      (total, stage) => total + stage.costMinorUnits,
      0,
    ),
    elapsedMs: completed.reduce(
      (total, stage) => total + stage.elapsedMs,
      0,
    ),
    ...(nextStage ? { nextStage } : {}),
    duplicateSegments: false as const,
    resumable: true as const,
  })
}

function freezeRun(
  value:
    | Omit<LongFormIndexWorkflow, 'runHash'>
    | LongFormIndexWorkflow,
): Readonly<LongFormIndexWorkflow> {
  const { runHash: _previousHash, ...withoutHash } =
    value as LongFormIndexWorkflow
  const stages = Object.freeze([...withoutHash.stages])
  const body = Object.freeze({
    ...withoutHash,
    stages,
    budget: Object.freeze({ ...withoutHash.budget }),
    summary: summary(stages),
    status: workflowStatus(stages),
  })
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(body),
  })
}

function stageInputHash(input: {
  sourceArtifactSha256: string
  sourceManifestHash: string
  sourceTranscriptHash?: string
  durationMs: number
  stage: LongFormIndexStage
  prerequisites: readonly Readonly<LongFormIndexStageCheckpoint>[]
  version: Readonly<LongFormIndexStageVersion>
}): string {
  return calculateCanonicalHash({
    policyVersion: LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION,
    sourceArtifactSha256: input.sourceArtifactSha256,
    sourceManifestHash: input.sourceManifestHash,
    sourceTranscriptHash: input.sourceTranscriptHash,
    durationMs: input.durationMs,
    stage: input.stage,
    prerequisiteOutputs: input.prerequisites.map((stage) => ({
      stage: stage.stage,
      outputHash: stage.outputHash,
    })),
    version: input.version,
  })
}

function refreshPendingStages(
  run: Readonly<LongFormIndexWorkflow>,
  stagesInput: readonly Readonly<LongFormIndexStageCheckpoint>[],
): readonly Readonly<LongFormIndexStageCheckpoint>[] {
  const stages = [...stagesInput]
  let remainingBudget = run.budget.maximumCostMinorUnits -
    stages.filter((stage) => stage.status === 'succeeded')
      .reduce((total, stage) => total + stage.costMinorUnits, 0)
  for (const [index, current] of stages.entries()) {
    if (!['pending', 'budget-blocked'].includes(current.status)) {
      continue
    }
    const prerequisites = current.prerequisites.map((stage) =>
      stages.find((candidate) => candidate.stage === stage)!)
    if (!prerequisites.every((stage) =>
      stage.status === 'succeeded')) continue
    const estimated = current.execution === 'reuse'
      ? 0
      : current.budget.estimatedCostMinorUnits
    const status = estimated <= remainingBudget
      ? 'ready' as const
      : 'budget-blocked' as const
    if (status === 'ready') remainingBudget -= estimated
    const inputHash = stageInputHash({
      sourceArtifactSha256: run.sourceArtifactSha256,
      sourceManifestHash: run.sourceManifestHash,
      sourceTranscriptHash: run.sourceTranscriptHash,
      durationMs: run.durationMs,
      stage: current.stage,
      prerequisites,
      version: current.version,
    })
    stages[index] = freezeStage({
      ...current,
      status,
      inputHash,
      idempotencyKey:
        `${run.id}:${current.stage}:${inputHash.slice(0, 32)}`,
    })
  }
  return Object.freeze(stages)
}

export function createLongFormIndexWorkflow(input: {
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId?: string
  sourceTranscriptHash?: string
  durationMs: number
  versions: StageVersions
  stageBudgets: StageBudgets
  reusableOutputs?: ReusableOutputs
  budget: Readonly<{
    currency: 'USD'
    maximumCostMinorUnits: number
    maximumElapsedMs: number
    maximumConcurrency: number
  }>
  createdByClientId: string
  createdAt: string
}): Readonly<LongFormIndexWorkflow> {
  const id = identity(input.id, 'id')
  const sourceArtifactSha256 = hash(
    input.sourceArtifactSha256,
    'sourceArtifactSha256',
  )
  const sourceManifestHash = hash(
    input.sourceManifestHash,
    'sourceManifestHash',
  )
  assertDomain(
    (input.sourceTranscriptId === undefined) ===
      (input.sourceTranscriptHash === undefined),
    'INVALID_ARGUMENT',
    'source transcript ID and hash must be provided together',
  )
  const sourceTranscriptId = input.sourceTranscriptId
    ? identity(input.sourceTranscriptId, 'sourceTranscriptId')
    : undefined
  const sourceTranscriptHash = input.sourceTranscriptHash
    ? hash(input.sourceTranscriptHash, 'sourceTranscriptHash')
    : undefined
  const durationMs = integer(
    input.durationMs,
    'durationMs',
    1_000,
    43_200_000,
  )
  assertDomain(
    input.budget?.currency === 'USD',
    'INVALID_ARGUMENT',
    'budget.currency must be USD',
  )
  const budget = Object.freeze({
    currency: 'USD' as const,
    maximumCostMinorUnits: integer(
      input.budget?.maximumCostMinorUnits,
      'budget.maximumCostMinorUnits',
      0,
      10_000_000,
    ),
    maximumElapsedMs: integer(
      input.budget?.maximumElapsedMs,
      'budget.maximumElapsedMs',
      1,
      24 * 60 * 60 * 1_000,
    ),
    maximumConcurrency: integer(
      input.budget?.maximumConcurrency,
      'budget.maximumConcurrency',
      1,
      32,
    ),
  })
  const createdAt = instant(input.createdAt, 'createdAt')
  const reusable = input.reusableOutputs ?? {}
  const stages: LongFormIndexStageCheckpoint[] = []
  for (const [index, stage] of LONG_FORM_INDEX_STAGES.entries()) {
    const version = normalizeVersion(
      input.versions?.[stage],
      `versions.${stage}`,
    )
    const stageBudget = normalizeStageBudget(
      input.stageBudgets?.[stage],
      `stageBudgets.${stage}`,
    )
    const prerequisites =
      LONG_FORM_INDEX_STAGE_DEPENDENCIES[stage]
    const reusableOutput = reusable[stage]
    if (reusableOutput) {
      const prerequisiteStages = prerequisites.map((required) =>
        stages.find((candidate) => candidate.stage === required)!)
      assertDomain(
        prerequisiteStages.every((candidate) =>
          candidate?.status === 'succeeded'),
        'INVALID_ARGUMENT',
        `Reusable ${stage} has an incomplete prerequisite`,
      )
      const inputHash = stageInputHash({
        sourceArtifactSha256,
        sourceManifestHash,
        sourceTranscriptHash,
        durationMs,
        stage,
        prerequisites: prerequisiteStages,
        version,
      })
      stages.push(freezeStage({
        stage,
        sequence: index + 1,
        prerequisites,
        execution: 'reuse',
        status: 'succeeded',
        version,
        budget: stageBudget,
        concurrency: concurrencyFor(
          stage,
          durationMs,
          budget.maximumConcurrency,
        ),
        inputHash,
        idempotencyKey: `${id}:${stage}:${inputHash.slice(0, 32)}`,
        attempt: 0,
        outputHash: hash(
          reusableOutput.outputHash,
          `reusableOutputs.${stage}.outputHash`,
        ),
        resultCount: integer(
          reusableOutput.resultCount,
          `reusableOutputs.${stage}.resultCount`,
          1,
          10_000_000,
        ),
        searchable:
          ['transcript', 'chunks', 'moments'].includes(stage),
        costMinorUnits: 0,
        elapsedMs: 0,
        completedAt: createdAt,
      }))
      continue
    }
    const placeholderInputHash = calculateCanonicalHash({
      workflowId: id,
      stage,
      waitingFor: prerequisites,
    })
    stages.push(freezeStage({
      stage,
      sequence: index + 1,
      prerequisites,
      execution: 'process',
      status: 'pending',
      version,
      budget: stageBudget,
      concurrency: concurrencyFor(
        stage,
        durationMs,
        budget.maximumConcurrency,
      ),
      inputHash: placeholderInputHash,
      idempotencyKey:
        `${id}:${stage}:${placeholderInputHash.slice(0, 32)}`,
      attempt: 0,
      resultCount: 0,
      searchable: false,
      costMinorUnits: 0,
      elapsedMs: 0,
    }))
  }
  const base = freezeRun({
    schemaVersion: LONG_FORM_INDEX_WORKFLOW_SCHEMA_VERSION,
    policyVersion: LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION,
    id,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    sourceArtifactId: identity(
      input.sourceArtifactId,
      'sourceArtifactId',
    ),
    sourceArtifactSha256,
    sourceManifestId: identity(
      input.sourceManifestId,
      'sourceManifestId',
    ),
    sourceManifestHash,
    ...(sourceTranscriptId ? { sourceTranscriptId } : {}),
    ...(sourceTranscriptHash ? { sourceTranscriptHash } : {}),
    durationMs,
    status: 'queued',
    stages: Object.freeze(stages),
    budget,
    summary: summary(stages),
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt,
    updatedAt: createdAt,
  })
  return freezeRun({
    ...base,
    stages: refreshPendingStages(base, base.stages),
  })
}

export function startLongFormIndexStage(input: {
  workflow: Readonly<LongFormIndexWorkflow>
  stage: LongFormIndexStage
  expectedRunHash: string
  startedAt: string
}): Readonly<LongFormIndexWorkflow> {
  const workflow = hydrateLongFormIndexWorkflow(input.workflow)
  assertDomain(
    hash(input.expectedRunHash, 'expectedRunHash') ===
      workflow.runHash,
    'VERSION_CONFLICT',
    'Long-form workflow changed before the stage started',
  )
  const startedAt = instant(input.startedAt, 'startedAt')
  assertDomain(
    Date.parse(startedAt) >= Date.parse(workflow.updatedAt),
    'INVALID_ARGUMENT',
    'Stage cannot start before the latest workflow transition',
  )
  const index = workflow.stages.findIndex((candidate) =>
    candidate.stage === input.stage)
  const current = workflow.stages[index]
  assertDomain(
    current?.status === 'ready' &&
      workflow.summary.nextStage === input.stage,
    'PRECONDITION_REQUIRED',
    'Only the next ready long-form stage can start',
  )
  const stages = [...workflow.stages]
  stages[index] = freezeStage({
    ...current,
    status: 'running',
    attempt: current.attempt + 1,
    startedAt,
    completedAt: undefined,
    error: undefined,
  })
  return freezeRun({
    ...workflow,
    stages: Object.freeze(stages),
    updatedAt: startedAt,
  })
}

export function completeLongFormIndexStage(input: {
  workflow: Readonly<LongFormIndexWorkflow>
  stage: LongFormIndexStage
  expectedRunHash: string
  expectedInputHash: string
  outputHash: string
  resultCount: number
  costMinorUnits: number
  elapsedMs: number
  completedAt: string
}): Readonly<LongFormIndexWorkflow> {
  const workflow = hydrateLongFormIndexWorkflow(input.workflow)
  assertDomain(
    hash(input.expectedRunHash, 'expectedRunHash') ===
      workflow.runHash,
    'VERSION_CONFLICT',
    'Long-form workflow changed before stage completion',
  )
  const index = workflow.stages.findIndex((candidate) =>
    candidate.stage === input.stage)
  const current = workflow.stages[index]
  assertDomain(
    current?.status === 'running' &&
      hash(input.expectedInputHash, 'expectedInputHash') ===
        current.inputHash,
    'VERSION_CONFLICT',
    'Long-form stage input changed before completion',
  )
  const completedAt = instant(input.completedAt, 'completedAt')
  assertDomain(
    Date.parse(completedAt) >=
      Date.parse(current.startedAt as string),
    'INVALID_ARGUMENT',
    'Stage completion precedes its start',
  )
  const costMinorUnits = integer(
    input.costMinorUnits,
    'costMinorUnits',
    0,
    current.budget.maximumCostMinorUnits,
  )
  const elapsedMs = integer(
    input.elapsedMs,
    'elapsedMs',
    0,
    current.budget.maximumElapsedMs,
  )
  const resultCount = integer(
    input.resultCount,
    'resultCount',
    1,
    10_000_000,
  )
  assertDomain(
    workflow.summary.costMinorUnits + costMinorUnits <=
      workflow.budget.maximumCostMinorUnits &&
      workflow.summary.elapsedMs + elapsedMs <=
        workflow.budget.maximumElapsedMs,
    'PRECONDITION_REQUIRED',
    'Long-form stage exceeded the workflow budget',
  )
  const stages = [...workflow.stages]
  stages[index] = freezeStage({
    ...current,
    status: 'succeeded',
    outputHash: hash(input.outputHash, 'outputHash'),
    resultCount,
    searchable:
      ['transcript', 'chunks', 'moments'].includes(input.stage),
    costMinorUnits,
    elapsedMs,
    completedAt,
    error: undefined,
  })
  const intermediate = freezeRun({
    ...workflow,
    stages: Object.freeze(stages),
    updatedAt: completedAt,
  })
  return freezeRun({
    ...intermediate,
    stages: refreshPendingStages(
      intermediate,
      intermediate.stages,
    ),
  })
}

export function failLongFormIndexStage(input: {
  workflow: Readonly<LongFormIndexWorkflow>
  stage: LongFormIndexStage
  expectedRunHash: string
  code: string
  message: string
  retryable: boolean
  failedAt: string
}): Readonly<LongFormIndexWorkflow> {
  const workflow = hydrateLongFormIndexWorkflow(input.workflow)
  assertDomain(
    hash(input.expectedRunHash, 'expectedRunHash') ===
      workflow.runHash,
    'VERSION_CONFLICT',
    'Long-form workflow changed before stage failure',
  )
  const index = workflow.stages.findIndex((candidate) =>
    candidate.stage === input.stage)
  const current = workflow.stages[index]
  assertDomain(
    current?.status === 'running',
    'PRECONDITION_REQUIRED',
    'Only a running long-form stage can fail',
  )
  const failedAt = instant(input.failedAt, 'failedAt')
  const message = input.message.trim()
  assertDomain(
    ERROR_CODE.test(input.code) &&
      message.length >= 1 &&
      message.length <= 500,
    'INVALID_ARGUMENT',
    'Long-form stage failure is invalid',
  )
  const stages = [...workflow.stages]
  stages[index] = freezeStage({
    ...current,
    status: 'failed',
    completedAt: failedAt,
    error: Object.freeze({
      code: input.code,
      message,
      retryable: input.retryable,
    }),
  })
  return freezeRun({
    ...workflow,
    stages: Object.freeze(stages),
    updatedAt: failedAt,
  })
}

export function resumeLongFormIndexWorkflow(input: {
  workflow: Readonly<LongFormIndexWorkflow>
  expectedRunHash: string
  resumedAt: string
}): Readonly<LongFormIndexWorkflow> {
  const workflow = hydrateLongFormIndexWorkflow(input.workflow)
  assertDomain(
    hash(input.expectedRunHash, 'expectedRunHash') ===
      workflow.runHash,
    'VERSION_CONFLICT',
    'Long-form workflow changed before resume',
  )
  const failedIndex = workflow.stages.findIndex((stage) =>
    stage.status === 'running' ||
    stage.status === 'failed' && stage.error?.retryable)
  assertDomain(
    failedIndex >= 0,
    'PRECONDITION_REQUIRED',
    'Long-form workflow has no interrupted or retryable failed stage',
  )
  const resumedAt = instant(input.resumedAt, 'resumedAt')
  assertDomain(
    Date.parse(resumedAt) >= Date.parse(workflow.updatedAt),
    'INVALID_ARGUMENT',
    'Workflow resume cannot move time backwards',
  )
  const stages = [...workflow.stages]
  const failed = stages[failedIndex]!
  stages[failedIndex] = freezeStage({
    ...failed,
    status: 'ready',
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
  })
  return freezeRun({
    ...workflow,
    stages: Object.freeze(stages),
    updatedAt: resumedAt,
  })
}

function assertStage(
  stage: Readonly<LongFormIndexStageCheckpoint>,
  index: number,
) {
  assertDomain(
    stage.stage === LONG_FORM_INDEX_STAGES[index] &&
      stage.sequence === index + 1 &&
      stableSerialize(stage.prerequisites) === stableSerialize(
        LONG_FORM_INDEX_STAGE_DEPENDENCIES[stage.stage],
      ) &&
      ['process', 'reuse'].includes(stage.execution) &&
      [
        'pending',
        'ready',
        'running',
        'succeeded',
        'failed',
        'budget-blocked',
      ].includes(stage.status) &&
      Number.isSafeInteger(stage.concurrency) &&
      stage.concurrency >= 1 &&
      stage.concurrency <= 32 &&
      HASH.test(stage.inputHash) &&
      stage.idempotencyKey.length >= 8 &&
      stage.idempotencyKey.length <= 256 &&
      Number.isSafeInteger(stage.attempt) &&
      stage.attempt >= 0 &&
      Number.isSafeInteger(stage.resultCount) &&
      stage.resultCount >= 0 &&
      Number.isSafeInteger(stage.costMinorUnits) &&
      stage.costMinorUnits >= 0 &&
      Number.isSafeInteger(stage.elapsedMs) &&
      stage.elapsedMs >= 0,
    'PERSISTENCE_CONFLICT',
    `Stored long-form stage ${index + 1} is invalid`,
  )
  normalizeVersion(stage.version, `stages[${index}].version`)
  normalizeStageBudget(stage.budget, `stages[${index}].budget`)
  if (stage.status === 'succeeded') {
    hash(stage.outputHash, `stages[${index}].outputHash`)
    assertDomain(
      stage.resultCount >= 1 &&
        Boolean(stage.completedAt) &&
        !stage.error,
      'PERSISTENCE_CONFLICT',
      `Stored completed long-form stage ${index + 1} is invalid`,
    )
  }
  if (stage.status === 'running') {
    assertDomain(
      stage.attempt >= 1 &&
        Boolean(stage.startedAt) &&
        !stage.completedAt &&
        !stage.error,
      'PERSISTENCE_CONFLICT',
      `Stored running long-form stage ${index + 1} is invalid`,
    )
  }
  if (stage.status === 'failed') {
    assertDomain(
      Boolean(stage.error) && Boolean(stage.completedAt),
      'PERSISTENCE_CONFLICT',
      `Stored failed long-form stage ${index + 1} is invalid`,
    )
  }
  const { stageHash, ...body } = stage
  assertDomain(
    HASH.test(stageHash) &&
      stageHash === calculateCanonicalHash(body),
    'PERSISTENCE_CONFLICT',
    `Stored long-form stage ${index + 1} hash is invalid`,
  )
}

export function hydrateLongFormIndexWorkflow(
  value: unknown,
): Readonly<LongFormIndexWorkflow> {
  assertDomain(
    typeof value === 'object' && value !== null,
    'INVALID_ARGUMENT',
    'Long-form workflow must be an object',
  )
  const workflow = value as LongFormIndexWorkflow
  assertDomain(
    workflow.schemaVersion ===
      LONG_FORM_INDEX_WORKFLOW_SCHEMA_VERSION &&
      workflow.policyVersion ===
        LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION &&
      Array.isArray(workflow.stages) &&
      workflow.stages.length === LONG_FORM_INDEX_STAGES.length,
    'PERSISTENCE_CONFLICT',
    'Stored long-form workflow version or stages are invalid',
  )
  identity(workflow.id, 'workflow.id')
  identity(workflow.workspaceId, 'workflow.workspaceId')
  identity(workflow.projectId, 'workflow.projectId')
  identity(workflow.sourceArtifactId, 'workflow.sourceArtifactId')
  hash(
    workflow.sourceArtifactSha256,
    'workflow.sourceArtifactSha256',
  )
  identity(workflow.sourceManifestId, 'workflow.sourceManifestId')
  hash(workflow.sourceManifestHash, 'workflow.sourceManifestHash')
  assertDomain(
    (workflow.sourceTranscriptId === undefined) ===
      (workflow.sourceTranscriptHash === undefined),
    'PERSISTENCE_CONFLICT',
    'Stored long-form workflow transcript binding is invalid',
  )
  if (workflow.sourceTranscriptId) {
    identity(
      workflow.sourceTranscriptId,
      'workflow.sourceTranscriptId',
    )
    hash(
      workflow.sourceTranscriptHash,
      'workflow.sourceTranscriptHash',
    )
  }
  integer(workflow.durationMs, 'workflow.durationMs', 1_000, 43_200_000)
  identity(workflow.createdByClientId, 'workflow.createdByClientId')
  instant(workflow.createdAt, 'workflow.createdAt')
  instant(workflow.updatedAt, 'workflow.updatedAt')
  assertDomain(
    Date.parse(workflow.updatedAt) >= Date.parse(workflow.createdAt) &&
      workflow.budget.currency === 'USD',
    'PERSISTENCE_CONFLICT',
    'Stored long-form workflow dates or budget are invalid',
  )
  integer(
    workflow.budget.maximumCostMinorUnits,
    'workflow.budget.maximumCostMinorUnits',
    0,
    10_000_000,
  )
  integer(
    workflow.budget.maximumElapsedMs,
    'workflow.budget.maximumElapsedMs',
    1,
    24 * 60 * 60 * 1_000,
  )
  integer(
    workflow.budget.maximumConcurrency,
    'workflow.budget.maximumConcurrency',
    1,
    32,
  )
  workflow.stages.forEach(assertStage)
  const expectedSummary = summary(workflow.stages)
  const expectedStatus = workflowStatus(workflow.stages)
  const { runHash, ...body } = workflow
  assertDomain(
    stableSerialize(workflow.summary) ===
      stableSerialize(expectedSummary) &&
      workflow.status === expectedStatus &&
      HASH.test(runHash) &&
      runHash === calculateCanonicalHash(body),
    'PERSISTENCE_CONFLICT',
    'Stored long-form workflow summary or hash is invalid',
  )
  return Object.freeze(workflow)
}
