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
