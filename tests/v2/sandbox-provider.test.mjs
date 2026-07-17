import assert from 'node:assert/strict'
import test from 'node:test'
import { SimulatedSandboxProvider } from '../../src/v2/infrastructure/sandbox/simulated-provider.ts'

test('sandbox fake is isolated, deterministic and reports simulated cost without external calls', () => {
  const provider = new SimulatedSandboxProvider()
  const input = { environment: 'sandbox', workspaceId: 'workspace-1', clientId: 'client-1', operation: 'render', units: 12 }
  const first = provider.execute(input); const replay = provider.execute(input)
  assert.deepEqual(first, replay)
  assert.deepEqual(first.cost, { currency: 'USD', minorUnits: 24 })
  assert.equal(first.externalCalls, 0)
  assert.throws(() => provider.execute({ ...input, environment: 'production' }), /sandbox-only/)
})
