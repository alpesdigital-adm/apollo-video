/**
 * In-process locks para etapas do pipeline.
 * Evita execuções duplicadas da mesma etapa para o mesmo projeto
 * (auto-trigger do frontend re-dispara em remount/reload/StrictMode).
 */

const activeSteps = new Set<string>()

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
