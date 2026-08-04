import {
  createApiAccessAuditContext,
} from '../../../src/v2/domain/api-access-control.ts'
import {
  createExternalAuditContext,
} from '../../../src/v2/application/authenticate-api-client.ts'

export function authenticationAudit(overrides = {}) {
  return createApiAccessAuditContext({
    clientId: 'client-audit-test',
    credentialId: 'credential-audit-test',
    workspaceId: 'workspace-audit-test',
    environment: 'sandbox',
    authenticationKind: 'bearer',
    ...overrides,
  })
}

export function authenticatedActor(overrides = {}) {
  const {
    scopes = ['projects:write'],
    authenticationKind = 'bearer',
    ...identity
  } = overrides
  const auditContext = createExternalAuditContext({
    clientId: 'client-audit-test',
    credentialId: 'credential-audit-test',
    workspaceId: 'workspace-audit-test',
    environment: 'sandbox',
    ...identity,
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind,
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}
