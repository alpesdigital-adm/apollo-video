import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { authenticateUiSessionService } from '@/v2/application/authenticate-ui-session'
import { DomainError } from '@/v2/domain/errors'
import {
  createApiClientRepository,
  createUiSessionSecurityRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  APOLLO_SESSION_COOKIE,
  safeUiRedirect,
  uiSessionNonceHash,
  uiSessionSubjectHash,
  verifyUiSession,
} from '@/v2/infrastructure/security/ui-session'
import { resolveApiEnvironment } from '@/v2/public-api/authentication'

export async function readActiveUiPageSession() {
  const cookieStore = await cookies()
  const session = verifyUiSession(cookieStore.get(APOLLO_SESSION_COOKIE)?.value)
  if (!session) return null

  try {
    const actor = await authenticateUiSessionService({
      repository: createApiClientRepository(),
      sessions: createUiSessionSecurityRepository(),
      environment: resolveApiEnvironment(),
    })(session, uiSessionNonceHash(session.nonce), uiSessionSubjectHash(session.subject))
    return { actor, session }
  } catch (error) {
    if (error instanceof DomainError && error.code === 'AUTH_INVALID') return null
    throw error
  }
}

export async function requireActiveUiPageSession(returnTo: string) {
  const authenticated = await readActiveUiPageSession()
  if (!authenticated) {
    redirect(`/login?next=${encodeURIComponent(safeUiRedirect(returnTo))}`)
  }
  return authenticated
}
