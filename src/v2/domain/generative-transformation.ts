import { createHash } from 'node:crypto';
import { createTransformationBrief, type TransformationBrief } from './transformation-brief.ts'

export {
  TRANSFORMATION_BRIEF_SCHEMA_VERSION,
  TRANSFORMATION_FALLBACKS,
  TRANSFORMATION_INTENTS,
  TRANSFORMATION_MODES,
  TRANSFORMATION_PRESERVES,
  assertTransformationBrief,
  createTransformationBrief,
  createTransformationBriefFromStoryPlan,
  projectTransformationProviderInput,
} from './transformation-brief.ts'
export type {
  StoryPlanTransformationCandidate,
  TransformationBrief,
  TransformationFallback,
  TransformationIntent,
  TransformationMode,
  TransformationPreserve,
  TransformationSafeZone,
} from './transformation-brief.ts'
export {
  TRANSFORMATION_MODE_CONTRACTS,
  TRANSFORMATION_MODE_REGISTRY_HASH,
  TRANSFORMATION_MODE_REGISTRY_VERSION,
} from './transformation-mode-registry.ts'
export { TRANSFORMATION_MODE_CONTRACTS as MODE_CONTRACTS } from './transformation-mode-registry.ts'
export {
  createTransformationProviderDefinition,
  createTransformationProviderHealth,
  routeTransformationProvider,
  transitionTransformationProviderHealth,
} from './transformation-provider-registry.ts'
export type {
  TransformationProviderCapability,
  TransformationProviderDefinition,
  TransformationProviderHealth,
  TransformationProviderSelection,
  TransformationRoutingPolicy,
} from './transformation-provider-registry.ts'

// F3.013 / FR-113 — the second `ProviderJob` that lived here is gone.
//
// It was a parallel model of the same idea: a `state` union of five values, an
// `attempts` counter incremented by a `resumeProviderJob` that resumed nothing,
// and `applyProviderCallback` guarding replay with a `Set<string>` of nonces
// held in memory — a set that a process restart emptied, so every replayed
// callback looked new again. None of it was ever reachable from `src/`.
//
// The canonical model is `./provider-job.ts`: fifteen statuses with an explicit
// transition table, leases and fencing, an append-only transition history, and
// ingestion that must happen before a critic can approve anything. Transports,
// schedules and durable callback verification are in `./provider-job-transport.ts`
// and `./provider-job-callback.ts`.

export function calculateNovelty(input: { transformations: { group: string; novelty: number; durationMs: number; atMs: number }[]; windowMs: number; limit: number }) {
  let consumed = 0; const accepted: typeof input.transformations = []; const rejected: typeof input.transformations = [];
  for (const item of input.transformations) {
    const cooldownConflict = accepted.some(other => other.group === item.group && Math.abs(item.atMs - other.atMs) < input.windowMs);
    const cost = item.novelty * Math.max(1, item.durationMs / 1000);
    if (cooldownConflict || consumed + cost > input.limit) rejected.push(item); else { accepted.push(item); consumed += cost; }
  }
  return { accepted, rejected, consumed, treatment: consumed < input.limit * .35 ? 'sober' : consumed < input.limit * .8 ? 'balanced' : 'intense' };
}

export function chooseFallback(brief: TransformationBrief, attempts: { mode: TransformationBrief['fallbackLadder'][number]; valid: boolean; intentScore: number; artifact?: string; cost: number }[]) {
  const candidates = brief.fallbackLadder.flatMap(mode => attempts.filter(item => item.mode === mode && item.valid && item.intentScore >= .7));
  const selected = candidates[0];
  return { selected, applied: selected?.mode ?? 'blocked', preservedArtifact: attempts.filter(item => item.valid && item.artifact).sort((a, b) => b.intentScore - a.intentScore)[0]?.artifact, incurredCost: attempts.reduce((sum, item) => sum + item.cost, 0), requiresReview: selected?.mode !== 'video-to-video' };
}

export function critiqueTransformation(brief: TransformationBrief, result: { intent: number; temporal: number; artifacts: number; risk: number; changed: string[]; regionScores: { rangeMs: [number, number]; score: number }[] }) {
  const protectedChange = result.changed.find(item => brief.preserve.some((preserved) => preserved === item));
  const passed = !protectedChange && result.intent >= .75 && result.temporal >= .75 && result.artifacts <= .2 && result.risk <= .3;
  return { passed, issue: passed ? undefined : { code: protectedChange ? 'protected-content-changed' : 'quality-below-threshold', protectedChange, ranges: result.regionScores.filter(item => item.score < .75), action: protectedChange ? 'fallback' : 'retry' } };
}

export type ReviewMask = { id: string; normalized: { x: number; y: number; width: number; height: number }; rangeMs: [number, number]; confidence: number; format: string; preserveRegions: string[] };
export function annotationToMask(input: { pixels: { x: number; y: number; width: number; height: number }; canvas: { width: number; height: number }; rangeMs: [number, number]; confidence: number; format: string }): ReviewMask {
  if (input.canvas.width <= 0 || input.canvas.height <= 0) throw new Error('invalid-canvas');
  return { id: `mask-${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 10)}`, normalized: { x: input.pixels.x / input.canvas.width, y: input.pixels.y / input.canvas.height, width: input.pixels.width / input.canvas.width, height: input.pixels.height / input.canvas.height }, rangeMs: input.rangeMs, confidence: input.confidence, format: input.format, preserveRegions: [] };
}

export function planAdvancedCleanup(input: { mask: ReviewMask; sourceId: string; operation: 'separation' | 'inpaint'; qualityThreshold: number; estimated: { quality: number; cost: number }; alternatives: { method: string; quality: number; cost: number }[] }) {
  if (input.mask.confidence < .75) return { status: 'needs-mask-review', derivative: undefined };
  const chosen = [input.estimated, ...input.alternatives].filter(item => item.quality >= input.qualityThreshold).sort((a, b) => a.cost - b.cost)[0];
  return chosen ? { status: 'planned', derivative: `${input.sourceId}:derivative:${input.mask.id}`, chosen, immutableSource: true } : { status: 'reject', derivative: undefined, immutableSource: true };
}

export const TRANSFORMATION_GOLDENS = {
  simple: createTransformationBrief({
    workspaceId: 'workspace-golden', projectId: 'project-golden', projectVersionId: 'version-golden', storyPlanId: 'story-plan-simple', storyPlanHash: '1'.repeat(64), sourceArtifactId: 'artifact-scene-one', sourceArtifactHash: '2'.repeat(64), sourceRange: { startFrame: 0, endFrame: 150 }, intent: 'dramatic-emphasis', editorialIntent: 'Iluminar o estúdio sem alterar a pessoa.', mode: 'relight', prompt: 'Luz de estúdio suave e natural.', negativeConstraints: ['não alterar o rosto'], preserve: ['identity', 'speech', 'wardrobe'], allowedChanges: ['lighting'], target: { lighting: 'soft' }, outputSpecIds: ['output-vertical'], intensityBps: 2_000, noveltyBps: 2_000, safety: ['no-face-change'], safeZones: [{ x: 0.25, y: 0.05, width: 0.5, height: 0.6, purpose: 'face' }], fallbackLadder: ['source-unchanged'], rightsSnapshotId: 'rights-simple', rightsSnapshotHash: '3'.repeat(64), identitySnapshotId: 'identity-simple', identitySnapshotHash: '4'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
  }),
  medieval: createTransformationBrief({
    workspaceId: 'workspace-golden', projectId: 'project-golden', projectVersionId: 'version-golden', storyPlanId: 'story-plan-medieval', storyPlanHash: '5'.repeat(64), sourceArtifactId: 'artifact-scene-two', sourceArtifactHash: '6'.repeat(64), sourceRange: { startFrame: 30, endFrame: 210 }, intent: 'world-shift', editorialIntent: 'Ilustrar gestão de tráfego medieval mantendo a fala e a identidade.', mode: 'background-replacement', prompt: 'Vila medieval britânica sóbria ao fundo.', negativeConstraints: ['sem armas', 'sem texto inventado'], preserve: ['identity', 'lips', 'expression', 'body-motion', 'wardrobe', 'speech', 'foreground'], allowedChanges: ['background'], target: { environment: 'medieval-british-village' }, outputSpecIds: ['output-vertical'], intensityBps: 8_000, noveltyBps: 8_000, safety: ['no-weapon', 'no-identity-change'], safeZones: [{ x: 0.2, y: 0.05, width: 0.6, height: 0.9, purpose: 'subject' }], fallbackLadder: ['actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged'], rightsSnapshotId: 'rights-medieval', rightsSnapshotHash: '7'.repeat(64), identitySnapshotId: 'identity-medieval', identitySnapshotHash: '8'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
  }),
};
