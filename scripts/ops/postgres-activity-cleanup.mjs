import { createConnection } from 'node:net'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Evidence is cleared only after every owned process closes and backend drainage is confirmed.
export async function closeOwnedClients(clients, {
  terminateBackend,
  countBackends,
  closeWaitMs = 5_000,
} = {}) {
  let failure
  try {
    for (const { backendPid } of clients) {
      if (backendPid && terminateBackend) await terminateBackend(backendPid)
    }
  } catch (error) {
    failure = error
  } finally {
    // The experiment deadline and the first failed SQL probe cannot prevent OS containment.
    for (const { child } of clients) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      } catch (error) {
        failure ??= error
      }
    }
    let timer
    try {
      const reaped = await Promise.race([
        Promise.all(clients.map(({ closed }) => closed)).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), closeWaitMs) }),
      ])
      if (!reaped) failure ??= new Error('owned client close not confirmed')
    } catch (error) {
      failure ??= error
    } finally {
      clearTimeout(timer)
    }
  }
  if (failure) throw failure

  const pids = clients.map(({ backendPid }) => backendPid).filter(Boolean)
  if (pids.length) {
    if (!countBackends) throw new Error('client backend drainage not confirmed')
    const until = Date.now() + 5_000
    while (Date.now() < until) {
      if (Number(await countBackends(pids)) === 0) break
      await sleep(100)
    }
    if (Number(await countBackends(pids)) !== 0) throw new Error('client backend not drained')
  }
  clients.length = 0
}

// A timeout or transport error is inconclusive, never evidence of a closed listener.
export function probeClosedPort(port, connect = createConnection) {
  return new Promise((resolve) => {
    let socket
    let settled = false
    const finish = (closed) => {
      if (settled) return
      settled = true
      resolve(closed)
      socket?.destroy()
    }
    try {
      socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => finish(false))
      socket.once('timeout', () => finish(false))
      socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'))
      socket.once('close', () => {
        finish(false)
        socket.removeAllListeners('connect')
        socket.removeAllListeners('timeout')
        socket.removeAllListeners('error')
        socket.removeAllListeners('close')
      })
      socket.setTimeout(750)
    } catch {
      finish(false)
    }
  })
}
