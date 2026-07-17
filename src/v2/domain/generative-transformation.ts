import { createHash, timingSafeEqual } from 'node:crypto';

export const TRANSFORMATION_MODES = ['background-replacement', 'stylization', 'cutaway', 'camera-motion', 'relight', 'object-environment-change'] as const;
export type TransformationMode = typeof TRANSFORMATION_MODES[number];
export type TransformationBrief = { id: string; intent: string; sourceRangeMs: [number, number]; mode: TransformationMode; preserve: string[]; allowedChanges: string[]; novelty: number; safety: string[]; fallback: ('v2v' | 'composite' | 'cutaway' | 'unchanged')[]; sourceRefs: string[] };

export function createTransformationBrief(input: Omit<TransformationBrief, 'id'>) {
  if (!input.intent || input.sourceRangeMs[1] <= input.sourceRangeMs[0] || input.preserve.some(item => input.allowedChanges.includes(item))) throw new Error('invalid-transformation-brief');
  const payload = JSON.stringify(input);
  return { ...input, id: `brief-${createHash('sha256').update(payload).digest('hex').slice(0, 12)}` };
}

export const MODE_CONTRACTS: Record<TransformationMode, { input: string; output: string; preserves: string[]; risks: string[]; fallback: string }> = {
  'background-replacement': { input: 'video+subject-mask', output: 'video', preserves: ['person', 'speech'], risks: ['edges'], fallback: 'composite' },
  stylization: { input: 'video+style', output: 'video', preserves: ['timing', 'speech'], risks: ['identity'], fallback: 'cutaway' },
  cutaway: { input: 'intent', output: 'video', preserves: ['audio'], risks: ['semantic-mismatch'], fallback: 'unchanged' },
  'camera-motion': { input: 'video+motion', output: 'video', preserves: ['content'], risks: ['crop'], fallback: 'unchanged' },
  relight: { input: 'video+light', output: 'video', preserves: ['identity'], risks: ['flicker'], fallback: 'unchanged' },
  'object-environment-change': { input: 'video+mask+prompt', output: 'video', preserves: ['person', 'speech'], risks: ['hallucination'], fallback: 'composite' },
};

export type ProviderCapability = { provider: string; capability: TransformationMode; healthy: boolean; circuitOpen: boolean; limits: { maxDurationMs: number }; regions: string[]; pricePerSecond: number; quality: number; credentialsRef: string };
export function routeTransformation(brief: TransformationBrief, providers: ProviderCapability[], input: { region: string; maxCost: number; minQuality: number }) {
  const durationSeconds = (brief.sourceRangeMs[1] - brief.sourceRangeMs[0]) / 1000;
  const candidates = providers.filter(item => item.capability === brief.mode && item.healthy && !item.circuitOpen && item.regions.includes(input.region) && item.limits.maxDurationMs >= brief.sourceRangeMs[1] - brief.sourceRangeMs[0] && item.quality >= input.minQuality && item.pricePerSecond * durationSeconds <= input.maxCost).sort((a, b) => b.quality - a.quality || a.pricePerSecond - b.pricePerSecond);
  return { selected: candidates[0], reason: candidates[0] ? `quality:${candidates[0].quality};cost:${candidates[0].pricePerSecond * durationSeconds}` : 'no-eligible-provider', discarded: providers.filter(item => item !== candidates[0]).map(item => item.provider) };
}

export type ProviderJob = { id: string; briefId: string; transport: 'api' | 'webhook' | 'polling' | 'mcp'; state: 'submitted' | 'waiting' | 'completed' | 'failed' | 'cancelled'; correlationId: string; attempts: number; artifact?: string };
export function createProviderJob(brief: TransformationBrief, transport: ProviderJob['transport']): ProviderJob { return { id: `job-${brief.id}-${transport}`, briefId: brief.id, transport, state: 'submitted', correlationId: crypto.randomUUID(), attempts: 1 }; }
export function resumeProviderJob(job: ProviderJob) { return job.state === 'waiting' || job.state === 'submitted' ? { ...job, state: 'waiting' as const, attempts: job.attempts + 1 } : job; }
export function applyProviderCallback(job: ProviderJob, callback: { correlationId: string; artifact?: string; failed?: boolean; signature: string; nonce: string }, secret: string, consumedNonces: Set<string>) {
  const expected = createHash('sha256').update(`${callback.correlationId}:${callback.nonce}:${secret}`).digest();
  const supplied = Buffer.from(callback.signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid-callback-signature');
  if (consumedNonces.has(callback.nonce)) return { job, duplicate: true };
  if (callback.correlationId !== job.correlationId) throw new Error('callback-correlation-mismatch');
  consumedNonces.add(callback.nonce);
  return { job: { ...job, state: callback.failed ? 'failed' as const : 'completed' as const, artifact: callback.artifact }, duplicate: false };
}

export function calculateNovelty(input: { transformations: { group: string; novelty: number; durationMs: number; atMs: number }[]; windowMs: number; limit: number }) {
  let consumed = 0; const accepted: typeof input.transformations = []; const rejected: typeof input.transformations = [];
  for (const item of input.transformations) {
    const cooldownConflict = accepted.some(other => other.group === item.group && Math.abs(item.atMs - other.atMs) < input.windowMs);
    const cost = item.novelty * Math.max(1, item.durationMs / 1000);
    if (cooldownConflict || consumed + cost > input.limit) rejected.push(item); else { accepted.push(item); consumed += cost; }
  }
  return { accepted, rejected, consumed, treatment: consumed < input.limit * .35 ? 'sober' : consumed < input.limit * .8 ? 'balanced' : 'intense' };
}

export function chooseFallback(brief: TransformationBrief, attempts: { mode: TransformationBrief['fallback'][number]; valid: boolean; intentScore: number; artifact?: string; cost: number }[]) {
  const candidates = brief.fallback.flatMap(mode => attempts.filter(item => item.mode === mode && item.valid && item.intentScore >= .7));
  const selected = candidates[0];
  return { selected, applied: selected?.mode ?? 'blocked', preservedArtifact: attempts.filter(item => item.valid && item.artifact).sort((a, b) => b.intentScore - a.intentScore)[0]?.artifact, incurredCost: attempts.reduce((sum, item) => sum + item.cost, 0), requiresReview: selected?.mode !== 'v2v' };
}

export function critiqueTransformation(brief: TransformationBrief, result: { intent: number; temporal: number; artifacts: number; risk: number; changed: string[]; regionScores: { rangeMs: [number, number]; score: number }[] }) {
  const protectedChange = result.changed.find(item => brief.preserve.includes(item));
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
  simple: createTransformationBrief({ intent: 'iluminar estúdio', sourceRangeMs: [0, 5000], mode: 'relight', preserve: ['identity', 'speech'], allowedChanges: ['light'], novelty: .2, safety: ['no-face-change'], fallback: ['v2v', 'unchanged'], sourceRefs: ['scene-1'] }),
  medieval: createTransformationBrief({ intent: 'colocar especialista em vila medieval britânica para ilustrar gestão de tráfego medieval', sourceRangeMs: [1000, 7000], mode: 'background-replacement', preserve: ['identity', 'speech', 'clothes'], allowedChanges: ['background'], novelty: .8, safety: ['no-weapon', 'no-identity-change'], fallback: ['v2v', 'composite', 'cutaway', 'unchanged'], sourceRefs: ['scene-2'] }),
};
