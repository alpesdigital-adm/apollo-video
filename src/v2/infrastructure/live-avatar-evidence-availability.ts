/**
 * Server-owned preflight for paid live audio-avatar work.
 *
 * Transport provenance cannot prove output speech or presenter identity. Until
 * a measured production evaluator is configured, the only honest answer is
 * unavailable and callers must stop before any provider submission.
 */
export function createLiveAvatarEvidenceAvailability(_environment: NodeJS.ProcessEnv = process.env) {
  return Object.freeze({
    async isAvailable(_input: { adapterId: string; adapterVersion: string; operation: 'audio-avatar' }): Promise<boolean> {
      return false
    },
  })
}
