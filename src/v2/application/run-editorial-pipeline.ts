import { assertDomain } from '../domain/errors.ts'
import type {
  CompiledRenderInputReference,
  CriticDecisionReference,
  DirectedPlanReference,
  EditorialPipelineContext,
  EditorialPipelinePorts,
  PerceptionReference,
  RenderedArtifactReference,
} from './ports/editorial-pipeline.ts'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} is invalid`)
  const normalized = value.trim()
  assertDomain(
    value === normalized && IDENTIFIER.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function assertActive(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function perception(value: Readonly<PerceptionReference>): Readonly<PerceptionReference> {
  assertDomain(value.schemaVersion === 'perception-reference/v1', 'INVALID_ARGUMENT', 'Perception reference schema is invalid')
  identifier(value.snapshotId, 'perception.snapshotId')
  return value
}

function plan(value: Readonly<DirectedPlanReference>): Readonly<DirectedPlanReference> {
  assertDomain(value.schemaVersion === 'directed-plan-reference/v1', 'INVALID_ARGUMENT', 'Directed plan reference schema is invalid')
  identifier(value.directorRunId, 'plan.directorRunId')
  identifier(value.editPlanId, 'plan.editPlanId')
  return value
}

function decision(value: Readonly<CriticDecisionReference>): Readonly<CriticDecisionReference> {
  assertDomain(value.schemaVersion === 'critic-decision-reference/v1', 'INVALID_ARGUMENT', 'Critic decision reference schema is invalid')
  identifier(value.qualityReportId, 'critic.qualityReportId')
  assertDomain(value.decision === 'approved' || value.decision === 'blocked', 'INVALID_ARGUMENT', 'Critic decision is invalid')
  return value
}

function renderInput(value: Readonly<CompiledRenderInputReference>): Readonly<CompiledRenderInputReference> {
  assertDomain(value.schemaVersion === 'compiled-render-input-reference/v1', 'INVALID_ARGUMENT', 'Compiled RenderInput reference schema is invalid')
  identifier(value.renderInputId, 'compiler.renderInputId')
  assertDomain(SHA256.test(value.renderInputHash), 'INVALID_ARGUMENT', 'Compiled RenderInput hash is invalid')
  return value
}

function artifact(value: Readonly<RenderedArtifactReference>): Readonly<RenderedArtifactReference> {
  assertDomain(value.schemaVersion === 'rendered-artifact-reference/v1', 'INVALID_ARGUMENT', 'Rendered artifact reference schema is invalid')
  identifier(value.artifactId, 'renderer.artifactId')
  identifier(value.manifestId, 'renderer.manifestId')
  return value
}

export async function runEditorialPipelineService(
  dependencies: Readonly<EditorialPipelinePorts>,
  input: Readonly<EditorialPipelineContext>,
  signal?: AbortSignal,
): Promise<Readonly<{
  perception: Readonly<PerceptionReference>
  plan: Readonly<DirectedPlanReference>
  approval: Readonly<CriticDecisionReference>
  renderInput: Readonly<CompiledRenderInputReference>
  artifact: Readonly<RenderedArtifactReference>
}>> {
  const context = Object.freeze({
    workspaceId: identifier(input.workspaceId, 'workspaceId'),
    projectId: identifier(input.projectId, 'projectId'),
    baseVersionId: identifier(input.baseVersionId, 'baseVersionId'),
    operationId: identifier(input.operationId, 'operationId'),
  })

  assertActive(signal)
  const provider = await dependencies.providers.resolvePerceptionProvider(context)
  identifier(provider.identity.provider, 'provider.identity.provider')
  identifier(provider.identity.model, 'provider.identity.model')
  identifier(provider.identity.version, 'provider.identity.version')

  const perceived = perception(await provider.perceive(context, signal))
  assertActive(signal)
  const directed = plan(await dependencies.director.direct({ context, perception: perceived }, signal))
  assertActive(signal)
  const reviewed = decision(await dependencies.critic.review({ context, plan: directed }, signal))
  assertDomain(
    reviewed.decision === 'approved',
    'EDITORIAL_ACCEPTANCE_FAILED',
    'Critic blocked the directed plan',
    { qualityReportId: reviewed.qualityReportId },
  )
  assertActive(signal)
  const compiled = renderInput(await dependencies.compiler.compile({ context, plan: directed, approval: reviewed }, signal))
  assertActive(signal)
  const rendered = artifact(await dependencies.renderer.render({ context, renderInput: compiled }, signal))
  assertActive(signal)

  return Object.freeze({
    perception: perceived,
    plan: directed,
    approval: reviewed,
    renderInput: compiled,
    artifact: rendered,
  })
}
