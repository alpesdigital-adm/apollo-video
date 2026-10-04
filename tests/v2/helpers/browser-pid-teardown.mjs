import { spawnSync } from 'node:child_process'

/**
 * Judges the owned browser by the real liveness of its PID. On Windows the
 * Playwright wrapper does not always deliver 'exit' (and BrowserServer.close()
 * can hang), so a still-alive PID is killed by tree with taskkill and polled.
 * A PID that is alive at the end remains a hard failure for the caller.
 */
export async function settleOwnedBrowserProcess(browserProcess, cleanupErrors) {
  const exited = () => !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null
  const alive = () => {
    if (!browserProcess?.pid) return false
    try { process.kill(browserProcess.pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
  }
  if (!exited() && alive() && process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(browserProcess.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 }) }
    catch (error) { cleanupErrors.push(`browser-taskkill:${error?.name ?? 'Error'}`) }
    for (let attempt = 0; attempt < 50 && alive(); attempt += 1) await new Promise((done) => setTimeout(done, 100))
  }
  const aliveAtEnd = alive()
  return { terminal: !browserProcess || exited() || !aliveAtEnd, aliveAtEnd }
}
