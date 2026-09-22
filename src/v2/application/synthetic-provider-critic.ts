import { assertDomain } from '../domain/errors.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { isSyntheticCriticApproval } from '../domain/synthetic-critic-report.ts'
import type { ProviderJob, ProviderJobResultArtifact } from '../domain/provider-job.ts'
import type { EvaluateSyntheticCriticInternalRequest, SyntheticCriticEvaluationResult } from './synthetic-critic.ts'
import type { ProviderResultCritic } from './ports/provider-job-runtime.ts'

export interface SyntheticCriticRuntimeContextResolver {
  resolve(input: {
    job: Readonly<ProviderJob>
    artifact: Readonly<ProviderJobResultArtifact>
    signal?: AbortSignal
  }): Promise<Readonly<EvaluateSyntheticCriticInternalRequest>>
}

/**
 * The transport critic still checks the ingested envelope, but it is no longer
 * allowed to approve synthetic media by itself. Approval is the immutable hash
 * of the specialized report produced from authoritative persisted context.
 */
export class SpecializedSyntheticProviderResultCritic implements ProviderResultCritic {
  private readonly dependencies: {
    transport: ProviderResultCritic
    context: SyntheticCriticRuntimeContextResolver
    evaluate: (request: Readonly<EvaluateSyntheticCriticInternalRequest>) => Promise<Readonly<SyntheticCriticEvaluationResult>>
  }

  constructor(dependencies: SpecializedSyntheticProviderResultCritic['dependencies']) {
    this.dependencies = dependencies
  }

  async evaluate(input: {
    job: Readonly<ProviderJob>
    artifact: Readonly<ProviderJobResultArtifact>
    signal?: AbortSignal
  }) {
    const transport = await this.dependencies.transport.evaluate(input)
    const context = await this.dependencies.context.resolve(input)
    assertDomain(
      context.subject.expected.rights.withinGrantedScope,
      'ASSET_RIGHTS_BLOCKED',
      context.subject.expected.rights.reason ?? 'Synthetic provider result is outside current consent or rights',
    )
    assertDomain(
      context.subject.workspaceId === input.job.workspaceId &&
        context.subject.projectId === input.job.projectId &&
        (context.subject.video ?? context.subject.audio)?.artifactId === input.artifact.artifactId &&
        (context.subject.video ?? context.subject.audio)?.sha256 === input.artifact.artifactSha256,
      'PERSISTENCE_CONFLICT',
      'Synthetic critic context does not describe the provider result under evaluation',
    )
    const evaluated = await this.dependencies.evaluate(Object.freeze({ ...context, signal: input.signal }))
    // Media evaluation may take longer than a consent update. Re-read the
    // server-owned context after the subprocesses finish so a revocation or
    // scope reduction during criticism cannot be promoted by the earlier
    // snapshot. The repository repeats this authority gate transactionally at
    // the terminal write to close the remaining commit window.
    const current = await this.dependencies.context.resolve(input)
    assertDomain(
      current.subject.expected.rights.withinGrantedScope,
      'ASSET_RIGHTS_BLOCKED',
      current.subject.expected.rights.reason ?? 'Synthetic provider authority changed during criticism',
    )
    assertDomain(
      calculateCanonicalHash({ subject: current.subject, profileSnapshotId: current.profileSnapshotId, scriptHash: current.scriptHash }) ===
        calculateCanonicalHash({ subject: context.subject, profileSnapshotId: context.profileSnapshotId, scriptHash: context.scriptHash }),
      'VERSION_CONFLICT',
      'Synthetic critic context changed during evaluation',
    )
    return Object.freeze({
      approved: transport.approved && isSyntheticCriticApproval(evaluated.report.decision),
      resultHash: evaluated.report.reportHash,
    })
  }
}
