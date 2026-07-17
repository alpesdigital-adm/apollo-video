import { createHash } from 'node:crypto';

export type Consent = { granted: boolean; expiresAt?: string; allowedLocales: string[]; allowedUses: string[]; evidenceId: string };
export type SyntheticPresenterProfile = { id: string; version: number; actor: string; providerIdentities: Record<string, string>; voiceProfiles: Record<string, string>; languages: string[]; consent: Consent; restrictions: string[]; active: boolean; disclosure: string };
export function assertProfileEligible(profile: SyntheticPresenterProfile, input: { locale: string; use: string; now?: string }) {
  const expired = profile.consent.expiresAt && new Date(profile.consent.expiresAt) <= new Date(input.now ?? Date.now());
  if (!profile.active || !profile.consent.granted || expired || !profile.languages.includes(input.locale) || !profile.consent.allowedUses.includes(input.use)) throw new Error('synthetic-profile-ineligible');
  return true;
}

export type AudioMaster = { id: string; source: 'tts' | 'uploaded'; uri: string; durationMs: number; locale: string; alignment: { word: string; startMs: number; endMs: number }[]; approved: boolean };
export function prepareAudio(input: { text?: string; uploaded?: AudioMaster; locale: string; regenerated?: boolean }): AudioMaster {
  if (input.uploaded && !input.regenerated) return input.uploaded;
  if (!input.text?.trim()) throw new Error('text-or-audio-required');
  const words = input.text.trim().split(/\s+/);
  const alignment = words.map((word, index) => ({ word, startMs: index * 420, endMs: (index + 1) * 420 }));
  return { id: `audio-${createHash('sha256').update(`${input.locale}:${input.text}`).digest('hex').slice(0, 12)}`, source: 'tts', uri: 'pending://tts', durationMs: words.length * 420, locale: input.locale, alignment, approved: false };
}

export type SyntheticBlock = { id: string; text: string; audioId: string; rangeMs: [number, number]; cacheKey: string; status: 'planned' | 'ready' | 'failed'; artifact?: string };
export function splitSyntheticBlocks(text: string, input: { audio: AudioMaster; profile: SyntheticPresenterProfile; providerCapability: string; settings?: object }) {
  const sentences = text.match(/[^.!?]+[.!?]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
  let cursor = 0;
  return sentences.map((sentence, index): SyntheticBlock => {
    const wordCount = sentence.split(/\s+/).length;
    const duration = Math.max(420, wordCount * 420);
    const rangeMs: [number, number] = [cursor, Math.min(input.audio.durationMs, cursor + duration)];
    cursor = rangeMs[1];
    const canonical = JSON.stringify({ sentence: sentence.normalize('NFC').trim(), profile: `${input.profile.id}@${input.profile.version}`, capability: input.providerCapability, locale: input.audio.locale, settings: input.settings ?? {} });
    return { id: `block-${index + 1}`, text: sentence, audioId: input.audio.id, rangeMs, cacheKey: createHash('sha256').update(canonical).digest('hex'), status: 'planned' };
  });
}

export type StoryBlock = { id: string; kind: 'real' | 'synthetic' | 'voiceover' | 'proof' | 'broll'; sourceId: string; rights: boolean; consent: boolean; identity?: string; scene?: string; disclosure?: string };
export function compileSyntheticEditPlan(input: { profile: SyntheticPresenterProfile; audio: AudioMaster; blocks: SyntheticBlock[]; broll: string[]; captions: boolean; overlays: string[]; use: string }) {
  assertProfileEligible(input.profile, { locale: input.audio.locale, use: input.use });
  return { mode: 'synthetic-presenter', durationMs: input.audio.durationMs, hasRealPerson: false, tracks: { audio: input.audio, synthetic: input.blocks, broll: input.broll, captions: input.captions ? input.audio.alignment : [], overlays: input.overlays }, disclosure: input.profile.disclosure };
}

export function validateHybridStory(blocks: StoryBlock[]) {
  const issues: string[] = [];
  for (const block of blocks) {
    if (!block.rights || !block.consent) issues.push(`${block.id}:rights-or-consent`);
    if (block.kind === 'synthetic' && !block.disclosure) issues.push(`${block.id}:missing-disclosure`);
  }
  for (let index = 1; index < blocks.length; index++) {
    const previous = blocks[index - 1], current = blocks[index];
    if (previous.identity && current.identity && previous.identity !== current.identity && current.kind === 'synthetic') issues.push(`${current.id}:identity-discontinuity`);
  }
  return { allowed: issues.length === 0, issues, sequence: blocks.map(block => block.kind).join('>') };
}

export type SyntheticMasterAsset = { id: string; rawVideo: string; finalAudio: AudioMaster; blocks: SyntheticBlock[]; providerConfig: object; lineage: string[]; metadata: { identity: string; outfit: string; scene: string; emotion: string; quality: number; rights: boolean } };
export function catalogSyntheticMaster(asset: SyntheticMasterAsset) {
  return asset.blocks.map(block => ({ id: `${asset.id}:${block.id}`, assetId: asset.id, exactText: block.text, rangeMs: block.rangeMs, identity: asset.metadata.identity, outfit: asset.metadata.outfit, atmosphere: asset.metadata.scene, emotion: asset.metadata.emotion, quality: asset.metadata.quality, rights: asset.metadata.rights, raw: true }));
}

export function reuseSyntheticBlock(asset: SyntheticMasterAsset, cacheKey: string) {
  const block = asset.blocks.find(item => item.cacheKey === cacheKey && item.status === 'ready' && item.artifact);
  return block ? { block, regenerated: false, estimatedSavings: 1 } : undefined;
}

export function evaluateSyntheticBlock(input: { blockId: string; rangeMs: [number, number]; lipSync: number; identity: number; pronunciation: number; artifacts: number; framing: number; continuity: number }) {
  const hardFailure = input.identity < .9 || input.pronunciation < .8 || input.artifacts > .2;
  const score = (input.lipSync + input.identity + input.pronunciation + input.framing + input.continuity + (1 - input.artifacts)) / 6;
  return { passed: !hardFailure && score >= .82, score, issue: hardFailure ? { blockId: input.blockId, rangeMs: input.rangeMs, action: input.identity < .9 ? 'fallback' : 'retry' } : undefined };
}
