/**
 * The editor page's reads, made to survive a screen that moves under them.
 *
 * The page used to call `fetch` from each loader and from a 2,5 s interval, with
 * nothing between the request and the state setter. Four defects lived in that
 * gap and all four are transport, not product:
 *
 * - **The late answer wins.** `loadWorkspace` and `loadReview` fire again on
 *   every version change, and a slow first response resolved after the second
 *   one and overwrote the fresh state with the stale one. Nothing aborted, and
 *   an abort alone would not be enough: a transport is free to ignore the
 *   signal and deliver the body anyway. So the drop is decided by the scope the
 *   read was issued under, not by the signal.
 * - **The same read is issued twice.** The polling effect and the version
 *   effect both call `loadReview`, so a tick and a version change in the same
 *   frame opened two identical requests.
 * - **A 429 is answered with more requests.** The interval never looked at
 *   `Retry-After`; a governance anomaly (`REQUEST_RATE_ANOMALY`, whose signal
 *   window is a whole minute) was met with a request every 2,5 s from a page
 *   that had already been told to wait.
 * - **The rounds overlap.** `setInterval` schedules by the clock, not by the
 *   previous round, so a round slower than 2,5 s piled up on itself.
 *
 * This module is only the transport. It decides nothing about the product: it
 * hands back either the envelope's `data` or a classified refusal, and the page
 * keeps every sentence it shows.
 */

import { classifyConflict, REPEATED_REQUEST_MESSAGE, UNKNOWN_CONFLICT_MESSAGE } from './refusal.ts'

/** What a refused read is, told apart by the only thing that distinguishes them. */
export type ReadFailureKind =
  | 'auth'
  | 'forbidden'
  | 'conflict'
  | 'not-found'
  | 'rate-limited'
  | 'error'

export interface ReadFailure {
  kind: ReadFailureKind
  /** The HTTP status, or `0` when there was no answer to read a status from. */
  status: number
  /** `error.code` from the envelope, kept whole — a 409 is read by its code. */
  code?: string
  /** `error.requestId` from the envelope, so the operator can quote it. */
  requestId?: string
  /** Only on `rate-limited`: how long is still left of the wait the server asked for. */
  retryAfterMs?: number
  /**
   * True when the answer arrived after the screen had moved on. The page must
   * not show this one: nothing failed, the answer is simply about a project
   * version that is no longer on screen.
   */
  dropped?: boolean
  message: string
}

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ReadFailure }

export interface ReadDescriptor {
  /** The counter this read is filed under in {@link EditorReads.snapshot}. */
  name: string
  url: string
  /** The project version this read is about, when it is about one. */
  versionId?: string
  /** The query string already built by the caller, without the `?`. */
  query?: string
  /**
   * Declared only so that declaring anything but a GET fails loudly. A read
   * coordinator that deduplicates and replays is safe exactly because nothing
   * it issues changes state.
   */
  method?: string
}

export interface EditorReadsScope {
  projectId: string
  versionId?: string
  /**
   * Bumped by the page whenever the identity behind the reads changes — a new
   * sign-in, a re-mount, a reload of the workspace. Two reads from different
   * epochs are never the same read, even when every other part matches.
   */
  sessionEpoch: string | number
}

export interface ReadCounters {
  issued: number
  deduplicated: number
  dropped: number
}

export interface PollHandle {
  stop(): void
}

export interface PollOptions {
  intervalMs: number
  isTerminal: () => boolean
}

export interface EditorReadsDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  now: () => number
  setTimeout: (handler: () => void, timeoutMs: number) => number
  clearTimeout: (handle: number) => void
  isDocumentHidden: () => boolean
}

export interface EditorReads {
  setScope(scope: EditorReadsScope): void
  read<T>(descriptor: ReadDescriptor): Promise<ReadResult<T>>
  poll(round: () => Promise<void>, options: PollOptions): PollHandle
  abortAll(): void
  snapshot(): Record<string, ReadCounters>
}

/**
 * How long the page waits when the server refuses for rate and says nothing
 * about when to come back.
 *
 * Five seconds is not a claim that the anomaly has cleared — the governance
 * signal window is a full minute. It is only how long this page stays quiet
 * before asking once more, and it is used *only* when `Retry-After` is absent
 * or unreadable. Whenever the server names a wait, that value is used and is
 * never shortened.
 */
export const RATE_LIMIT_FALLBACK_WAIT_MS = 5_000

/**
 * `Retry-After`, in milliseconds from `nowMs`, in either form the RFC allows.
 *
 * Both forms are read because both are sent: a proxy in front of the API
 * answers with an HTTP-date and the application answers with delta-seconds.
 * Reading only the digits turned every dated refusal into "no wait at all",
 * which is the one answer a rate limit cannot take.
 *
 * A date already in the past yields `0` — a wait the server itself says has
 * elapsed — which is not the same as the absent header that yields `undefined`.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isSafeInteger(seconds)) return undefined
    return seconds * 1_000
  }
  // Every HTTP-date carries a day name, a month name and a zone; a numeric
  // string that is not delta-seconds is malformed, and `Date.parse` is too
  // willing to invent a date out of one.
  if (!/[a-zA-Z]/.test(trimmed)) return undefined
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return Math.max(0, parsed - nowMs)
}

interface PublicErrorEnvelope {
  error?: { code?: unknown; message?: unknown; requestId?: unknown }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Anything that could carry a credential, and any answer that is not the
 * envelope at all.
 *
 * The page shows this string. A gateway that answers HTML, or an API that
 * echoes the request URL with its signed query, would put a secret on screen
 * and into whatever the operator pastes next.
 */
const UNSAFE_MESSAGE = /bearer\s|eyJ[A-Za-z0-9_-]{10,}|[?&](token|key|sig|signature|access_token)=|[<>]/i

function safeServerMessage(envelope: unknown): string | undefined {
  const message = stringField((envelope as PublicErrorEnvelope | undefined)?.error?.message)
  if (message === undefined) return undefined
  const collapsed = message.replace(/\s+/g, ' ').trim()
  if (collapsed === '' || UNSAFE_MESSAGE.test(collapsed)) return undefined
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed
}

function baseMessage(kind: ReadFailureKind, status: number, code: string | undefined): string {
  switch (kind) {
    case 'auth':
      return 'A sessão terminou. Entre novamente para continuar de onde parou.'
    case 'forbidden':
      return 'Esta conta não tem permissão para ler esta parte do projeto.'
    case 'conflict':
      // The one place a 409 is read by its code and not by its number.
      switch (classifyConflict(status, code)) {
        case 'repeated-request':
          return REPEATED_REQUEST_MESSAGE
        case 'stale-fence':
          return 'O projeto avançou no servidor durante a leitura: recarregue para ver o que está valendo.'
        default:
          return UNKNOWN_CONFLICT_MESSAGE
      }
    case 'not-found':
      return 'O servidor não tem esse registro para este projeto.'
    case 'rate-limited':
      return 'O servidor pediu para esperar antes de consultar de novo.'
    default:
      return `A leitura falhou no servidor (HTTP ${status}).`
  }
}

function kindFor(status: number): ReadFailureKind {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 409) return 'conflict'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limited'
  return 'error'
}

/**
 * A refused read, named by what the operator can do about it.
 *
 * The status alone is not the answer: `public-error-catalog.ts` puts five codes
 * on 409 and only two of them mean "reload", so the code travels with the
 * failure and the 409 message is chosen by {@link classifyConflict}.
 */
export function classifyReadFailure(
  status: number,
  envelope: unknown,
  headers: Headers,
  nowMs: number,
): ReadFailure {
  const error = (envelope as PublicErrorEnvelope | undefined)?.error
  const code = stringField(error?.code)
  const requestId = stringField(error?.requestId)
  const kind = kindFor(status)
  const failure: ReadFailure = {
    kind,
    status,
    message: safeServerMessage(envelope) ?? baseMessage(kind, status, code),
  }
  if (code !== undefined) failure.code = code
  if (requestId !== undefined) failure.requestId = requestId
  if (kind === 'rate-limited') {
    failure.retryAfterMs = parseRetryAfter(headers.get('retry-after'), nowMs) ?? RATE_LIMIT_FALLBACK_WAIT_MS
  }
  return failure
}

function droppedFailure(): ReadFailure {
  return {
    kind: 'error',
    status: 0,
    dropped: true,
    message: 'A resposta chegou depois que a tela mudou e foi descartada.',
  }
}

interface InFlight {
  name: string
  scopeToken: string
  controller: AbortController
  promise: Promise<ReadResult<unknown>>
  aborted: boolean
}

/**
 * One part of a key, made unambiguous without a control character.
 *
 * The separator is a printable `|` and every `|` inside a part is escaped,
 * because a project id ending in `|` must not be able to impersonate another
 * key. A raw NUL would separate just as well and is what a previous wave
 * reached for — it also makes git call the source file binary, so no diff of
 * it can ever be read again.
 */
function keyPart(value: string): string {
  return value.replace(/[\\|]/g, (match) => `\\${match}`)
}

function scopeTokenOf(scope: EditorReadsScope): string {
  return [scope.projectId, scope.versionId ?? '', String(scope.sessionEpoch)].map(keyPart).join('|')
}

/**
 * One coordinator per mounted editor page.
 *
 * Every moving part is injected, because every one of them is what the test
 * has to hold still: the clock decides the rate-limit gate, the timer decides
 * the poll, and the transport decides nothing at all.
 */
export function createEditorReads(deps: EditorReadsDeps): EditorReads {
  let scope: EditorReadsScope = { projectId: '', versionId: undefined, sessionEpoch: 0 }
  let scopeToken = scopeTokenOf(scope)
  let closedFailure: ReadFailure | null = null

  const inFlight = new Map<string, InFlight>()
  const waitUntil = new Map<string, number>()
  const counters = new Map<string, ReadCounters>()
  const polls = new Set<PollHandle>()

  function count(name: string, field: keyof ReadCounters) {
    const current = counters.get(name) ?? { issued: 0, deduplicated: 0, dropped: 0 }
    current[field] += 1
    counters.set(name, current)
  }

  function abortInFlight() {
    for (const entry of inFlight.values()) {
      entry.aborted = true
      entry.controller.abort()
    }
    inFlight.clear()
  }

  function keyOf(descriptor: ReadDescriptor): string {
    return [
      descriptor.name,
      scope.projectId,
      descriptor.versionId ?? scope.versionId ?? '',
      descriptor.query ?? '',
      String(scope.sessionEpoch),
    ].map(keyPart).join('|')
  }

  async function issue(
    key: string,
    descriptor: ReadDescriptor,
    entry: InFlight,
  ): Promise<ReadResult<unknown>> {
    const issuedUnder = entry.scopeToken
    try {
      const response = await deps.fetch(descriptor.url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: entry.controller.signal,
      })
      // Decided by the scope, not by the signal: a transport that ignored the
      // abort still delivered an answer about a screen that is gone.
      if (entry.aborted || issuedUnder !== scopeToken) {
        count(descriptor.name, 'dropped')
        return { ok: false, failure: droppedFailure() }
      }
      let envelope: unknown
      try {
        envelope = await response.json()
      } catch {
        envelope = undefined
      }
      if (entry.aborted || issuedUnder !== scopeToken) {
        count(descriptor.name, 'dropped')
        return { ok: false, failure: droppedFailure() }
      }
      if (response.status >= 200 && response.status < 300) {
        const data = (envelope as { data?: unknown } | undefined)?.data
        if (data === undefined) {
          return {
            ok: false,
            failure: {
              kind: 'error',
              status: response.status,
              message: 'O servidor respondeu sem os dados pedidos.',
            },
          }
        }
        return { ok: true, data }
      }
      const failure = classifyReadFailure(response.status, envelope, response.headers, deps.now())
      if (failure.kind === 'auth') closedFailure = failure
      if (failure.kind === 'rate-limited') {
        waitUntil.set(key, deps.now() + (failure.retryAfterMs ?? RATE_LIMIT_FALLBACK_WAIT_MS))
      }
      return { ok: false, failure }
    } catch (error) {
      if (entry.aborted || issuedUnder !== scopeToken) {
        count(descriptor.name, 'dropped')
        return { ok: false, failure: droppedFailure() }
      }
      return {
        ok: false,
        failure: {
          kind: 'error',
          status: 0,
          message: error instanceof Error && error.name === 'AbortError'
            ? 'A leitura foi interrompida.'
            : 'Não foi possível falar com o servidor.',
        },
      }
    } finally {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    }
  }

  function read<T>(descriptor: ReadDescriptor): Promise<ReadResult<T>> {
    const method = (descriptor.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      throw new Error(`editor-reads só emite GET; ${method} foi pedido para "${descriptor.name}".`)
    }
    const closed = closedFailure
    if (closed !== null) {
      return Promise.resolve({ ok: false, failure: closed })
    }
    const key = keyOf(descriptor)
    const existing = inFlight.get(key)
    if (existing !== undefined) {
      count(descriptor.name, 'deduplicated')
      return existing.promise as Promise<ReadResult<T>>
    }
    const until = waitUntil.get(key)
    if (until !== undefined) {
      const remaining = until - deps.now()
      if (remaining > 0) {
        return Promise.resolve({
          ok: false,
          failure: {
            kind: 'rate-limited',
            status: 429,
            retryAfterMs: remaining,
            message: baseMessage('rate-limited', 429, undefined),
          },
        })
      }
      waitUntil.delete(key)
    }
    const entry: InFlight = {
      name: descriptor.name,
      scopeToken,
      controller: new AbortController(),
      promise: Promise.resolve({ ok: false, failure: droppedFailure() }),
      aborted: false,
    }
    inFlight.set(key, entry)
    count(descriptor.name, 'issued')
    entry.promise = issue(key, descriptor, entry)
    return entry.promise as Promise<ReadResult<T>>
  }

  function setScope(next: EditorReadsScope): void {
    const nextToken = scopeTokenOf(next)
    scope = next
    if (nextToken === scopeToken) return
    scopeToken = nextToken
    abortInFlight()
  }

  function poll(round: () => Promise<void>, options: PollOptions): PollHandle {
    let stopped = false
    let running = false
    let timer: number | undefined

    const handle: PollHandle = {
      stop() {
        stopped = true
        if (timer !== undefined) {
          deps.clearTimeout(timer)
          timer = undefined
        }
        polls.delete(handle)
      },
    }

    const schedule = () => {
      if (stopped) return
      if (closedFailure !== null || options.isTerminal()) {
        handle.stop()
        return
      }
      timer = deps.setTimeout(() => void tick(), options.intervalMs)
    }

    const tick = async () => {
      timer = undefined
      if (stopped) return
      if (closedFailure !== null || options.isTerminal()) {
        handle.stop()
        return
      }
      // A hidden tab is not a reason to stop, only a reason not to ask: the
      // round resumes on the first tick after the operator comes back.
      if (deps.isDocumentHidden() || running) {
        schedule()
        return
      }
      running = true
      try {
        await round()
      } catch {
        // A round that throws must not take the loop with it; the page has
        // already been told what failed, through the read's own result.
      } finally {
        running = false
      }
      // Scheduled only now, after the round finished: the interval is a gap
      // between rounds, never a second round on top of a slow one.
      schedule()
    }

    polls.add(handle)
    schedule()
    return handle
  }

  function abortAll(): void {
    abortInFlight()
    for (const handle of [...polls]) handle.stop()
  }

  function snapshot(): Record<string, ReadCounters> {
    const result: Record<string, ReadCounters> = {}
    for (const [name, value] of counters) result[name] = { ...value }
    return result
  }

  return { setScope, read, poll, abortAll, snapshot }
}
