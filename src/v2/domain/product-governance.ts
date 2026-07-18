export const PRODUCT_PRINCIPLES = Object.freeze({
  decisions: { ai: ['narrative-candidates', 'treatment-candidates', 'asset-ranking'], deterministic: ['rights', 'consent', 'budget', 'time-ranges', 'schema', 'policy'] },
  assetPreference: ['reuse', 'adapt', 'generate', 'omit'] as const,
  validOmissions: ['no_insert', 'no_effect', 'no_music'] as const,
  promotionRequiresCritic: true,
  immutableMasters: true,
  stateModel: 'command-patch-version',
  capabilityRelease: ['F0', 'F1', 'F2', 'F3', 'F4', 'F5'] as const,
});

export type WorkspaceRole = 'operator' | 'director' | 'administrator' | 'reviewer';
export type WorkspaceAction = 'project:read' | 'project:edit' | 'strategy:edit' | 'workspace:edit' | 'protected:unlock' | 'rights:edit' | 'consent:edit' | 'guardrails:edit' | 'final:approve' | 'paid-job:cancel' | 'master:export' | 'final:export' | 'billing:manage';
const ROLE_ACTIONS: Record<WorkspaceRole, readonly WorkspaceAction[]> = {
  operator: ['project:read', 'project:edit', 'paid-job:cancel', 'final:export'],
  director: ['project:read', 'project:edit', 'strategy:edit', 'final:approve', 'paid-job:cancel', 'final:export'],
  administrator: ['project:read', 'project:edit', 'strategy:edit', 'workspace:edit', 'protected:unlock', 'rights:edit', 'consent:edit', 'guardrails:edit', 'final:approve', 'paid-job:cancel', 'master:export', 'final:export', 'billing:manage'],
  reviewer: ['project:read', 'final:approve'],
};
export function authorizeRole(role: WorkspaceRole, action: WorkspaceAction) { return { allowed: ROLE_ACTIONS[role].includes(action), role, action, enforcement: 'server' as const }; }

export const DESIGN_TOKENS = Object.freeze({
  color: { canvas: '#09090b', surface: '#18181b', border: '#3f3f46', text: '#f4f4f5', muted: '#a1a1aa', accent: '#fde047', info: '#7dd3fc', success: '#6ee7b7', danger: '#fda4af' },
  typography: { display: 'var(--font-sans)', body: 'var(--font-sans)', mono: 'var(--font-mono)' },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },
  radius: { control: 8, card: 16, pill: 999 },
  elevation: { raised: '0 20px 50px rgb(0 0 0 / .35)', focus: '0 0 0 3px rgb(125 211 252 / .45)' },
});
export const STATUS_PRESENTATION = Object.freeze({
  queued: { label: 'Na fila', tone: 'muted' }, running: { label: 'Produzindo', tone: 'info' }, review: { label: 'Revisar', tone: 'accent' }, failed: { label: 'Precisa de atenção', tone: 'danger' }, stale: { label: 'Desatualizado', tone: 'accent' }, completed: { label: 'Concluído', tone: 'success' }, archived: { label: 'Arquivado', tone: 'muted' },
});
export const INTERACTION_STATES = Object.freeze({ empty: 'explain-next-action', loading: 'skeleton-or-indeterminate', error: 'recoverable-with-retry', conflict: 'show-diff-before-choice', minimumTargetPx: 44, keyboard: true, reducedMotion: true });

export function directorDecisionRecord(input: { decision: string; evidence: string[]; confidence: number; cost: number; alternative: string; criticPassed: boolean }) {
  if (!input.criticPassed) throw new Error('critic-required-before-promotion');
  if (!input.evidence.length || input.confidence < 0 || input.confidence > 1 || input.cost < 0 || !input.alternative) throw new Error('invalid-director-decision');
  return { ...input, ownerInstructionChannel: true, ingestedContentIsInstruction: false };
}
