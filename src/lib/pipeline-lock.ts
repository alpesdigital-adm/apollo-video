/**
 * In-process locks para etapas do pipeline.
 * Evita execuções duplicadas da mesma etapa para o mesmo projeto
 * (auto-trigger do frontend re-dispara em remount/reload/StrictMode).
 */

// In dev, each Next route compiles its own bundle, so module-level state is NOT
// shared across route bundles. Anchor the lock set on globalThis so every bundle
// in the same process shares one Set.
const g = globalThis as any
const activeSteps: Set<string> = (g.__apolloStepLocks ??= new Set())

export function acquireStepLock(step: string, projectId: string): boolean {
  const key = `${step}:${projectId}`
  if (activeSteps.has(key)) {
    return false
  }
  activeSteps.add(key)
  return true
}

export function releaseStepLock(step: string, projectId: string): void {
  activeSteps.delete(`${step}:${projectId}`)
}
