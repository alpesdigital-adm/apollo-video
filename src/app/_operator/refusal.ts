/**
 * Telling one 409 from another, for the Wave 20 operator surfaces.
 *
 * The three pages used to diagnose a conflict by status alone, so every 409
 * became "the project moved, reload". `public-error-catalog.ts` puts at least
 * five different codes in that group, and one of them —
 * `IDEMPOTENCY_PAYLOAD_MISMATCH` — is reachable from these very pages: the
 * protected-selection key is `protect-<shot>-<projectVersion>`, so two attempts
 * with different notes against the same project version collide on purpose.
 * Telling that operator to reload sends them round a loop, because a reload is
 * not what went wrong.
 *
 * The envelope already carries the discriminator (`error.code` is on every
 * public error), so the pages read it rather than guessing from the number.
 */

/** The 409s that mean the aggregate advanced. A reload is the fix for these. */
export const STALE_FENCE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'PERSISTENCE_CONFLICT',
  'VERSION_CONFLICT',
])

export type ConflictKind = 'stale-fence' | 'repeated-request' | 'other-conflict'

/**
 * What kind of conflict this is, or `null` when the refusal is not one.
 *
 * `other-conflict` is deliberately not folded into `stale-fence`: a code this
 * page has never seen is a code whose remedy this page does not know, and
 * inventing one is how "reload" ended up on a refusal a reload cannot fix.
 */
export function classifyConflict(status: number, code: string | undefined): ConflictKind | null {
  if (status !== 409) return null
  if (code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') return 'repeated-request'
  return STALE_FENCE_CONFLICT_CODES.has(code ?? '') ? 'stale-fence' : 'other-conflict'
}

/** The version the server is actually holding, as it named it. */
export function conflictingVersionFrom(details: Record<string, unknown> | undefined): string {
  const current = details?.currentVersionId ?? details?.currentVersion
  return typeof current === 'string' || typeof current === 'number' ? String(current) : 'outra'
}

/**
 * Said once, in one place, because it is the sentence that used to be wrong.
 *
 * No reload affordance goes with it: the stored answer is the first one, the
 * work was not done twice, and the operator's next move is to look at what
 * stands before changing it again.
 */
export const REPEATED_REQUEST_MESSAGE =
  'O mesmo pedido já foi enviado com outro conteúdo. Vale a resposta da primeira vez '
  + 'e nada foi feito duas vezes: recarregue a tela para ver o que ficou valendo antes de mudar de novo.'

/** A 409 whose code this page does not know how to advise on. */
export const UNKNOWN_CONFLICT_MESSAGE =
  'O servidor recusou por conflito e esta tela não sabe qual: leia a mensagem do servidor antes de repetir.'
