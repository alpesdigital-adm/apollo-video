import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ADMISSION_GATE_NOT_CONFIGURED,
  ADMISSION_GATE_OPEN,
  type AdmissionGate,
  type AdmissionGateReading,
} from '../../application/ports/admission-gate.ts'

/**
 * The worker half of the host ops-state contract (Wave 23).
 *
 * The directory is written by the deploy/monitor run on the host and mounted
 * read-only into every Apollo container. This reader never writes and never
 * removes: absence of `gate.json` is the normal open state, so a reader that
 * "tidied up" would silently grant admission the operator had revoked.
 *
 * Fail-closed is asymmetric on purpose. A gate that cannot be read, parsed or
 * dated is closed, because the only reason to publish one is to stop admission;
 * a gate that was never configured is open, because a laptop and a unit test
 * have no host contract to honour.
 *
 * Clock and mtime are injected so the staleness rule can be tested without
 * sleeping: `issuedAtMonotonicMs` inside the file belongs to the monitor's
 * process and is meaningless here, so freshness is measured from the file's own
 * mtime on this host.
 */
const GATE_SCHEMA_VERSION = 'apollo-ops-gate/v1'
const LATCH_SCHEMA_VERSION = 'apollo-ops-latch/v1'

export interface FileAdmissionGateOptions {
  /** Defaults to `process.env.APOLLO_OPS_STATE_DIR`. */
  readonly directory?: string | undefined
  readonly now?: () => Date
  /** Injected for tests; defaults to `stat`. Returns null when the file is absent. */
  readonly statMtime?: (path: string) => Promise<Date | null>
  readonly readText?: (path: string) => Promise<string | null>
}

async function defaultStatMtime(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime
  } catch {
    return null
  }
}

async function defaultReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    // Only a genuinely absent file has the contract's default meaning. Treating
    // permission/I/O/type failures as absence can erase an engaged incident latch.
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function closed(reason: string): Readonly<AdmissionGateReading> {
  return Object.freeze({ admits: false, reason })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createFileAdmissionGate(
  options: FileAdmissionGateOptions = {},
): AdmissionGate {
  const configured = (options.directory ?? process.env.APOLLO_OPS_STATE_DIR)?.trim()
  const now = options.now ?? (() => new Date())
  const statMtime = options.statMtime ?? defaultStatMtime
  const readText = options.readText ?? defaultReadText

  return Object.freeze({
    async read(): Promise<Readonly<AdmissionGateReading>> {
      if (!configured) return ADMISSION_GATE_NOT_CONFIGURED

      // The directory itself is the contract's existence proof. An env var
      // pointing at nothing is a misconfigured deployment, not a laptop.
      if (!(await statMtime(configured))) return closed('ops-state-unreadable')

      // The latch outranks every metric and every gate file: it survives
      // container restarts and reboots because it lives on the host, and only an
      // operator command releases it.
      let latchText: string | null
      try {
        latchText = await readText(join(configured, 'latch.json'))
      } catch {
        return closed('incident-latch-unreadable')
      }
      if (latchText !== null) {
        const latch = parseJson(latchText)
        if (!isRecord(latch) || latch.schemaVersion !== LATCH_SCHEMA_VERSION) {
          // A latch file that cannot be understood still means somebody latched.
          return closed('incident-latch-unreadable')
        }
        const detail = typeof latch.reason === 'string' && latch.reason.trim()
          ? latch.reason.trim()
          : 'engaged'
        return closed(`incident-latch:${detail}`)
      }

      const gatePath = join(configured, 'gate.json')
      let gateText: string | null
      try {
        gateText = await readText(gatePath)
      } catch {
        return closed('gate-unreadable')
      }
      if (gateText === null) return ADMISSION_GATE_OPEN

      const gate = parseJson(gateText)
      if (!isRecord(gate)) return closed('gate-unparseable')
      if (gate.schemaVersion !== GATE_SCHEMA_VERSION) return closed('gate-schema-unknown')
      if (gate.state !== 'open' && gate.state !== 'closed') return closed('gate-state-unknown')
      const ttlMs = gate.ttlMs
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        return closed('gate-ttl-invalid')
      }
      if (gate.state === 'closed') {
        const reasons = Array.isArray(gate.reasons)
          ? gate.reasons.filter((reason): reason is string => typeof reason === 'string')
          : []
        return closed(reasons.length ? `gate-closed:${reasons.join(',')}` : 'gate-closed')
      }

      // An open gate is only as good as the monitor that keeps rewriting it. A
      // monitor that died leaves the last open sample behind, so age decides.
      const mtime = await statMtime(gatePath)
      if (!mtime) return closed('stale-gate')
      const age = now().getTime() - mtime.getTime()
      if (!Number.isFinite(age) || age < 0 || age > ttlMs) return closed('stale-gate')
      return ADMISSION_GATE_OPEN
    },
  })
}
