export type ProviderJob = { id: string; state: 'submitted' | 'processing' | 'completed' | 'failed'; cost: number; artifacts: string[]; error?: { code: string; retryable: boolean } };
export interface TtsProvider { synthesize(input: { text: string; locale: string; voiceId: string }): Promise<ProviderJob> }
export interface AvatarProvider { generate(input: { audioUri: string; profileId: string; durationMs: number }): Promise<ProviderJob> }

export class FakeTtsAdapter implements TtsProvider {
  async synthesize(input: { text: string; locale: string; voiceId: string }) { return { id: `tts:${input.locale}:${input.voiceId}`, state: 'completed' as const, cost: input.text.length / 1000, artifacts: ['memory://audio.wav', 'memory://alignment.json'] }; }
}
export class ElevenLabsAdapter implements TtsProvider {
  private readonly submit: (payload: object) => Promise<{ id: string; audio: string; alignment: string; cost: number }>;
  constructor(submit: (payload: object) => Promise<{ id: string; audio: string; alignment: string; cost: number }>) { this.submit = submit; }
  async synthesize(input: { text: string; locale: string; voiceId: string }) { try { const result = await this.submit(input); return { id: result.id, state: 'completed' as const, cost: result.cost, artifacts: [result.audio, result.alignment] }; } catch { return { id: 'elevenlabs:failed', state: 'failed' as const, cost: 0, artifacts: [], error: { code: 'provider-failure', retryable: true } }; } }
}
export class FakeAvatarAdapter implements AvatarProvider {
  async generate(input: { audioUri: string; profileId: string; durationMs: number }) { return { id: `avatar:${input.profileId}`, state: 'completed' as const, cost: input.durationMs / 60000, artifacts: ['memory://avatar.mp4'] }; }
}
export class HeyGenAdapter implements AvatarProvider {
  private readonly submit: (payload: object) => Promise<{ id: string; video: string; cost: number }>;
  constructor(submit: (payload: object) => Promise<{ id: string; video: string; cost: number }>) { this.submit = submit; }
  async generate(input: { audioUri: string; profileId: string; durationMs: number }) { try { const result = await this.submit(input); return { id: result.id, state: 'completed' as const, cost: result.cost, artifacts: [result.video] }; } catch { return { id: 'heygen:failed', state: 'failed' as const, cost: 0, artifacts: [], error: { code: 'provider-failure', retryable: true } }; } }
}

export function assertProviderContract(job: ProviderJob) {
  if (!job.id || job.cost < 0 || (job.state === 'completed' && job.artifacts.length === 0) || (job.state === 'failed' && !job.error)) throw new Error('provider-contract-violation');
  return true;
}
