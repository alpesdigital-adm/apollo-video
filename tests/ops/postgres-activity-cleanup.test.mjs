import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { closeOwnedClients, probeClosedPort } from '../../scripts/ops/postgres-activity-cleanup.mjs'

function ownedChild() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.signalCode = 'SIGKILL'
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
    return true
  }
  return { child, closed: new Promise((resolve) => child.once('close', resolve)), backendPid: 123 }
}

test('failed first termination still kills and reaps every owned child, preserving original error and evidence', async () => {
  const clients = [ownedChild(), ownedChild()]
  const killed = []
  for (const { child } of clients) {
    const kill = child.kill
    child.kill = () => { killed.push(child); return kill() }
  }
  const original = new Error('termination probe failed')
  await assert.rejects(closeOwnedClients(clients, {
    terminateBackend() { throw original },
    countBackends() { throw new Error('secondary probe failed') },
    closeWaitMs: 100,
  }), (error) => error === original)
  assert.deepEqual(killed, clients.map(({ child }) => child))
  assert.equal(clients.length, 2, 'inconclusive postflight must retain evidence')
})

test('unreaped child fails closed within bounded time and retains evidence', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => true
  const clients = [{ child, closed: new Promise((resolve) => child.once('close', resolve)) }]
  await assert.rejects(closeOwnedClients(clients, { closeWaitMs: 10 }), /close not confirmed/)
  assert.equal(clients.length, 1)
})

test('confirmed close and drained backend clear client evidence', async () => {
  const clients = [ownedChild()]
  await closeOwnedClients(clients, { terminateBackend() {}, countBackends: () => 0, closeWaitMs: 100 })
  assert.equal(clients.length, 0)
})

function socketCase(event, code) {
  const socket = new EventEmitter()
  socket.destroyed = false
  socket.setTimeout = () => {}
  socket.destroy = () => { socket.destroyed = true; queueMicrotask(() => socket.emit('close')) }
  queueMicrotask(() => socket.emit(event, code ? Object.assign(new Error(code), { code }) : undefined))
  return socket
}

test('only ECONNREFUSED confirms the listener is closed', async () => {
  for (const [event, code, expected] of [
    ['error', 'ECONNREFUSED', true], ['connect', null, false], ['timeout', null, false],
    ['error', 'EACCES', false], ['error', 'ETIMEDOUT', false], ['error', 'ENETUNREACH', false],
  ]) {
    const socket = socketCase(event, code)
    assert.equal(await probeClosedPort(55555, () => socket), expected, `${event}/${code}`)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(socket.destroyed, true)
    assert.equal(socket.listenerCount('connect') + socket.listenerCount('timeout') + socket.listenerCount('error') + socket.listenerCount('close'), 0)
  }
})
