export interface EditorialPipelineContext {
  workspaceId: string
  projectId: string
  baseVersionId: string
  operationId: string
}

export interface PerceptionReference {
  schemaVersion: 'perception-reference/v1'
  snapshotId: string
}

export interface DirectedPlanReference {
  schemaVersion: 'directed-plan-reference/v1'
  directorRunId: string
  editPlanId: string
}

export interface CriticDecisionReference {
  schemaVersion: 'critic-decision-reference/v1'
  qualityReportId: string
  decision: 'approved' | 'blocked'
}

export interface CompiledRenderInputReference {
  schemaVersion: 'compiled-render-input-reference/v1'
  renderInputId: string
  renderInputHash: string
}

export interface RenderedArtifactReference {
  schemaVersion: 'rendered-artifact-reference/v1'
  artifactId: string
  manifestId: string
}

export interface PerceptionProvider {
  readonly identity: Readonly<{
    provider: string
    model: string
    version: string
  }>
  perceive(
    context: Readonly<EditorialPipelineContext>,
    signal?: AbortSignal,
  ): Promise<Readonly<PerceptionReference>>
}

export interface ProviderRegistryPort {
  resolvePerceptionProvider(
    context: Readonly<EditorialPipelineContext>,
  ): Promise<PerceptionProvider>
}

export interface DirectorPort {
  direct(
    input: Readonly<{
      context: Readonly<EditorialPipelineContext>
      perception: Readonly<PerceptionReference>
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<DirectedPlanReference>>
}

export interface CriticPort {
  review(
    input: Readonly<{
      context: Readonly<EditorialPipelineContext>
      plan: Readonly<DirectedPlanReference>
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<CriticDecisionReference>>
}

export interface CompilerPort {
  compile(
    input: Readonly<{
      context: Readonly<EditorialPipelineContext>
      plan: Readonly<DirectedPlanReference>
      approval: Readonly<CriticDecisionReference>
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<CompiledRenderInputReference>>
}

export interface RendererPort {
  render(
    input: Readonly<{
      context: Readonly<EditorialPipelineContext>
      renderInput: Readonly<CompiledRenderInputReference>
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<RenderedArtifactReference>>
}

export interface EditorialPipelinePorts {
  providers: ProviderRegistryPort
  director: DirectorPort
  critic: CriticPort
  compiler: CompilerPort
  renderer: RendererPort
}
