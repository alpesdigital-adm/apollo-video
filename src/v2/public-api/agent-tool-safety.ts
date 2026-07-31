import { assertDomain } from '../domain/errors.ts'
import {
  FOUNDATION_CAPABILITIES,
  type CapabilityConfirmation,
  type PublicCapability,
} from './capability-registry.ts'

export type AgentToolImpact = 'bounded' | 'broad' | 'destructive'

export interface AgentToolSafetyRule {
  impact: AgentToolImpact
  confirmation: CapabilityConfirmation
  reason: string
}

export interface TrustedAgentToolGateEvidence {
  kind: Exclude<CapabilityConfirmation, 'none'>
  capabilityId: string
  inputFingerprint: string
  issuedAt: string
  expiresAt: string
}

type AgentToolSafetyInput = Readonly<Record<string, AgentToolSafetyRule>>

export function defineAgentToolSafetyRegistry(
  capabilities: readonly PublicCapability[],
  input: AgentToolSafetyInput,
) {
  const mutableTools = capabilities.filter(
    (capability) =>
      capability.toolName &&
      (capability.operationKind === 'command' || capability.operationKind === 'job'),
  )
  const mutableIds = new Set(mutableTools.map((capability) => capability.id))
  assertDomain(
    Object.keys(input).every((capabilityId) => mutableIds.has(capabilityId)),
    'INVALID_CAPABILITY',
    'Agent tool safety registry contains an unknown mutable capability',
  )
  assertDomain(
    mutableTools.every((capability) => input[capability.id]),
    'INVALID_CAPABILITY',
    'Every mutable agent tool requires an explicit safety rule',
  )

  return Object.freeze(
    Object.fromEntries(
      mutableTools.map((capability) => {
        const rule = input[capability.id]
        assertDomain(
          ['bounded', 'broad', 'destructive'].includes(rule.impact),
          'INVALID_CAPABILITY',
          'Agent tool impact is invalid',
          { capabilityId: capability.id },
        )
        assertDomain(
          rule.reason.trim().length >= 10 && rule.reason.trim().length <= 500,
          'INVALID_CAPABILITY',
          'Agent tool safety reason must be bounded and explicit',
          { capabilityId: capability.id },
        )
        const requiresGate =
          rule.impact !== 'bounded' ||
          capability.costClass === 'high' ||
          capability.costClass === 'variable'
        assertDomain(
          !requiresGate || rule.confirmation !== 'none',
          'INVALID_CAPABILITY',
          'Broad, destructive, high or variable-cost tools require a gate',
          { capabilityId: capability.id },
        )
        return [
          capability.id,
          Object.freeze({ ...rule, reason: rule.reason.trim() }),
        ]
      }),
    ),
  ) as Readonly<Record<string, Readonly<AgentToolSafetyRule>>>
}

export function createFoundationAgentToolSafety(
  capabilities: readonly PublicCapability[],
) {
  return defineAgentToolSafetyRegistry(capabilities, {
    'apollo.artifacts.rights.set': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Can revoke or replace the declared rights state used by later renders.',
    },
    'apollo.artifacts.materialization.authorize': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Evaluates one exact artifact manifest without starting provider work.',
    },
    'apollo.artifacts.render.enqueue': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Queues one previously authorized and fingerprint-bound render operation.',
    },
    'apollo.operations.cancel': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Terminates one operation and may prevent remaining output from being produced.',
    },
    'apollo.operations.retry': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Reopens one terminal operation and may repeat bounded provider work.',
    },
    'apollo.webhooks.endpoints.create': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'Introduces a new external callback destination for workspace events.',
    },
    'apollo.webhooks.endpoints.status.set': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Can suspend or permanently revoke an external callback endpoint.',
    },
    'apollo.webhooks.endpoints.challenge': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Performs one outbound verification exchange with an external endpoint.',
    },
    'apollo.webhooks.endpoints.signing-secrets.provision': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'Creates signing authority used for all deliveries to one endpoint.',
    },
    'apollo.webhooks.endpoints.signing-secrets.rotations.stage': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Stages one replacement signing secret without activating it.',
    },
    'apollo.webhooks.endpoints.signing-secrets.rotations.activate': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Replaces the active signing secret and retires previous authority.',
    },
    'apollo.webhooks.endpoints.signing-secrets.rotations.cancel': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Permanently destroys one staged signing-secret rotation candidate.',
    },
    'apollo.webhooks.signing-secrets.hygiene.run': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'May destroy expired secret envelopes across multiple workspace endpoints.',
    },
    'apollo.webhooks.subscriptions.create': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'Expands which workspace events can leave through an external endpoint.',
    },
    'apollo.webhooks.subscriptions.status.set': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Can pause or permanently revoke one external event subscription.',
    },
    'apollo.webhooks.deliveries.replay': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Reopens one terminal delivery and causes another outbound attempt.',
    },
    'apollo.webhooks.events.replay': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'Can reopen up to one hundred deliveries and repeat external effects.',
    },
    'apollo.projects.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one empty draft project with no provider or external side effect.',
    },
    'apollo.projects.duplicates.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one reversible copy-on-write project while sharing immutable snapshots and artifact bytes.',
    },
    'apollo.projects.mvp-core-gates.run': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Persists one immutable fail-closed audit report derived only from existing server-side evidence.',
    },
    'apollo.projects.speech-segments.catalog': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual catalog bound to an exact transcript hash without materializing media or starting provider work.',
    },
    'apollo.projects.evidence-segments.catalog': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual proof record bound to an exact SpeechSegment hash and current rights snapshot without materializing media.',
    },
    'apollo.projects.long-form-moments.catalog': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable hierarchy of virtual chapters and moments bound to an exact video artifact, manifest and rights snapshot without materializing media.',
    },
    'apollo.projects.long-form-index-workflows.create': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'May start transcription, diarization and hierarchical analysis provider work for a video up to twelve hours within explicit cost and elapsed-time budgets.',
    },
    'apollo.projects.validated-segments.catalog': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable historical validation record bound to exact source hashes and current rights while preserving an explicit non-causal protected envelope.',
    },
    'apollo.projects.semantic-search.documents.catalog': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual search document bound to an exact source hash and current rights without materializing media.',
    },
    'apollo.projects.semantic-search.evaluations.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Runs at most fifty bounded retrieval queries and persists one immutable metrics report without changing sources or project versions.',
    },
    'apollo.projects.semantic-search.reuse-runs.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Re-executes one bounded query and persists an immutable audit only after exact query and result-set hashes plus a complete reuse/rejection partition are verified.',
    },
    'apollo.projects.semantic-search.scale-evaluations.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Runs three to fifty bounded retrieval queries against one stable library snapshot and persists only immutable quality and latency evidence.',
    },
    'apollo.projects.hierarchical-processing.runs.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Processes one exact existing artifact and transcript within explicit cost, memory and elapsed-time budgets; it persists only virtual chunks, evidence mappings and measurements.',
    },
    'apollo.projects.source-deconstructions.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable analysis from exact existing artifact and cataloged-speech hashes; it preserves source media and starts no provider or render work.',
    },
    'apollo.projects.contamination-reports.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable multimodal diagnosis from an exact source-deconstruction hash; it preserves source media, blocks destructive cleanup and starts no provider or render work.',
    },
    'apollo.projects.source-cleanups.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates only a reversible derived artifact from one exact diagnosed finding; the source remains immutable, unsafe strategies are rejected and publication is gated by visual and rights review.',
    },
    'apollo.projects.validation-envelope-reuses.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable source-reference composition, blocks optional protected changes and starts no provider, render or media materialization work.',
    },
    'apollo.projects.validation-envelope-reuses.approve': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Approval explicitly records the loss of historical validation for exact protected aspects; rejection preserves the validation envelope.',
    },
    'apollo.projects.proof-needs.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Declares proof against one exact StoryPlan, selects only currently authorized cataloged EvidenceSegments and persists no provider, render or media materialization work.',
    },
    'apollo.projects.contiguous-extractions.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Selects one immutable virtual range from trusted persisted evaluations, preserves the source artifact, forbids synthesized ranges and automatic zoom, and starts no provider, render or media materialization work.',
    },
    'apollo.projects.color-pipeline-compilations.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Compiles one immutable metadata-only pipeline from a trusted project source probe; it changes no media bytes and starts no provider or render work.',
    },
    'apollo.workspace-luts.import': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Imports one size-bounded .cube into an immutable workspace-scoped version, generates one deterministic local preview and performs no provider or project mutation.',
    },
    'apollo.workspace-luts.versions.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one size-bounded immutable successor only from the declared current LUT version and generates one deterministic local preview.',
    },
    'apollo.workspace-luts.lifecycle.set': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Applies one revision-guarded active/inactive lifecycle command without deleting LUT versions, previews, projects or media.',
    },
    'apollo.projects.proof-integrity-runs.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Evaluates existing ProofNeed, recipe, evidence and current authorization hashes, persists an immutable fail-closed decision and starts no provider, render or media materialization work.',
    },
    'apollo.projects.proof-mode-runs.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Plans a bounded matrix from approved existing evidence, keeps manual overrides hash-scoped and starts no provider, render or media materialization work.',
    },
    'apollo.batches.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one explicit bounded item matrix from existing approved workspace artifacts without starting provider work.',
    },
    'apollo.batches.script-alignments.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual alignment from an exact labeled script and approved transcript hashes without materializing media.',
    },
    'apollo.batches.script-alignments.reviews.apply': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Records explicit reversible alignment review choices against one exact optimistic revision without modifying source media.',
    },
    'apollo.batches.take-libraries.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual take library from an exact alignment hash without changing, deleting or materializing source media.',
    },
    'apollo.batches.take-libraries.selections.apply': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Records one reversible take selection and protection decision against an exact optimistic revision while preserving every source take.',
    },
    'apollo.batches.compatibility-graphs.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual compatibility graph from an exact take-library hash without materializing recipes, jobs or media.',
    },
    'apollo.batches.variant-recipes.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable virtual recipe from an exact compatibility graph without duplicating masters, materializing media or starting render jobs.',
    },
    'apollo.batches.variant-portfolio-preflights.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Persists only bounded planning evidence from an exact compatibility graph; it never materializes the Cartesian product, creates a job or incurs provider cost.',
    },
    'apollo.batches.edit-preflights.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Persists only an immutable impact preview for explicitly selected recipes, formats and items without changing any item directive.',
    },
    'apollo.batches.edit-preflights.commit': {
      impact: 'bounded', confirmation: 'preflight-token',
      reason: 'Changes only the exact fingerprint-bound targets shown in the signed preview and records every applied, skipped or unchanged result.',
    },
    'apollo.batches.partial-retries.create': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Requeues only explicitly selected failed steps, but their durable jobs may repeat bounded provider, render or validation work.',
    },
    'apollo.batches.actions.apply': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Can cancel all unfinished work in one production batch or reopen previously cancelled and failed items.',
    },
    'apollo.batches.items.actions.apply': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Changes one exact item step and may record provider cost, failure, cancellation, retry or a newly produced artifact.',
    },
    'apollo.projects.commands.apply': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one reversible immutable project version against an exact base version and edit-plan hash.',
    },
    'apollo.projects.manual-edits.apply': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one reversible immutable project version from an exact revision and queues its exact proxy render.',
    },
    'apollo.projects.version-comparisons.act': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Records one reversible version comparison decision or restores a prior snapshot as a new immutable child version.',
    },
    'apollo.projects.annotations.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one version-bound review note without mutating the project or starting a provider job.',
    },
    'apollo.projects.review-patches.propose': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Persists one impact proposal and four deterministic gates without mutating the project version.',
    },
    'apollo.projects.review-patches.apply': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Creates one reversible immutable version and queues its exact proxy render only after explicit impact confirmation.',
    },
    'apollo.projects.review-patch-batches.propose': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Compiles two to one hundred ready proposals and records conflicts without changing the active project version.',
    },
    'apollo.projects.review-patch-batches.apply': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Creates one reversible immutable version from the explicitly reviewed batch and queues its exact proxy render.',
    },
    'apollo.projects.proxy-renders.enqueue': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Queues one idempotent proxy render for the current immutable project version and EditPlan.',
    },
    'apollo.projects.proxy-reviews.acknowledge-warnings': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Consciously accepts only non-hard warnings on one exact post-render proxy review; hard issues remain unacknowledgeable.',
    },
    'apollo.projects.asset-selections.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable selection audit without mutating the project version or starting provider work.',
    },
    'apollo.projects.quality-iterations.create': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Creates one immutable quality report from exact server evidence without approving final export or mutating the project version.',
    },
    'apollo.projects.final-exports.enqueue': {
      impact: 'bounded', confirmation: 'human-approval',
      reason: 'Publishes one approved high-resolution final artifact bound to an exact immutable project version.',
    },
    'apollo.media.uploads.begin': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Registers one checksum-bound upload intent without transferring bytes or starting ingest.',
    },
    'apollo.media.uploads.session.issue': {
      impact: 'bounded', confirmation: 'none',
      reason: 'Issues a short-lived upload authorization for one existing checksum-bound intent.',
    },
    'apollo.media.uploads.parts.record': {
      impact: 'bounded', confirmation: 'none', reason: 'Records one numbered receipt for one authorized multipart upload.',
    },
    'apollo.media.uploads.complete': {
      impact: 'bounded', confirmation: 'none', reason: 'Verifies one checksum-bound upload and queues its project-scoped ingest operation.',
    },
    'apollo.media.uploads.abort': {
      impact: 'destructive', confirmation: 'human-approval', reason: 'Permanently closes one staged upload and discards its unverified bytes.',
    },
    'apollo.artifacts.download-grants.issue': {
      impact: 'bounded', confirmation: 'none', reason: 'Issues one short-lived artifact-scoped download authorization.',
    },
    'apollo.artifacts.download-grants.revoke': {
      impact: 'bounded', confirmation: 'none', reason: 'Revokes one short-lived authorization owned by the authenticated client.',
    },
    'apollo.clients.create': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'Creates a new machine identity with workspace-scoped API permissions.',
    },
    'apollo.clients.credentials.rotate': {
      impact: 'broad', confirmation: 'human-approval',
      reason: 'Creates new authentication material and starts a credential overlap window.',
    },
    'apollo.clients.credentials.revoke': {
      impact: 'destructive', confirmation: 'human-approval',
      reason: 'Immediately and permanently revokes one API credential.',
    },
  })
}

export const FOUNDATION_AGENT_TOOL_SAFETY = createFoundationAgentToolSafety(
  FOUNDATION_CAPABILITIES,
)

export function agentToolSafetyFor(
  capability: Readonly<PublicCapability>,
  registry: Readonly<Record<string, Readonly<AgentToolSafetyRule>>>,
): Readonly<AgentToolSafetyRule> {
  if (capability.operationKind === 'query' || capability.operationKind === 'preflight') {
    return Object.freeze({
      impact: 'bounded', confirmation: 'none', reason: 'Read-only or preflight operation.',
    })
  }
  const rule = registry[capability.id]
  assertDomain(Boolean(rule), 'INVALID_CAPABILITY', 'Agent tool safety rule is missing', {
    capabilityId: capability.id,
  })
  return rule
}

export function requireAgentToolExecutionGate(
  capability: Readonly<Pick<PublicCapability, 'id'>>,
  rule: Readonly<AgentToolSafetyRule>,
  inputFingerprint: string,
  evidence: Readonly<TrustedAgentToolGateEvidence> | undefined,
  now: Date,
) {
  if (rule.confirmation === 'none') return Object.freeze({ confirmation: 'none' as const })

  assertDomain(
    Boolean(evidence),
    'TOOL_CONFIRMATION_REQUIRED',
    rule.confirmation === 'human-approval'
      ? 'Trusted human approval is required before tool execution'
      : 'A valid preflight token is required before tool execution',
    { capabilityId: capability.id, confirmation: rule.confirmation },
  )
  assertDomain(
    /^[a-f0-9]{64}$/.test(inputFingerprint) &&
      evidence?.kind === rule.confirmation &&
      evidence.capabilityId === capability.id &&
      evidence.inputFingerprint === inputFingerprint &&
      !Number.isNaN(Date.parse(evidence.issuedAt)) &&
      !Number.isNaN(Date.parse(evidence.expiresAt)) &&
      Date.parse(evidence.issuedAt) <= now.getTime() &&
      Date.parse(evidence.expiresAt) > now.getTime(),
    'TOOL_CONFIRMATION_INVALID',
    'Tool confirmation does not match the capability, input or validity window',
    { capabilityId: capability.id, confirmation: rule.confirmation },
  )
  return Object.freeze({
    confirmation: rule.confirmation,
    issuedAt: evidence.issuedAt,
    expiresAt: evidence.expiresAt,
  })
}
