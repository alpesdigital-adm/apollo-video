import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { oidcIdentitySubjectHash } from '../../src/v2/infrastructure/security/oidc-provider.ts'
import { uiSessionNonceHash } from '../../src/v2/infrastructure/security/ui-session.ts'

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next exited before readiness (${child.exitCode})`)
    try {
      const response = await fetch(`${baseUrl}/v1/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Next did not become ready')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function cookie(response, name) {
  return response.headers.get('set-cookie')?.match(new RegExp(`${name}=([^;]+)`))?.[1]
}

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

test('OIDC HTTP journey verifies provider evidence and creates only authorized opaque sessions', {
  timeout: 90_000,
  skip: !process.env.V2_DATABASE_URL ? 'V2_DATABASE_URL is required' : false,
}, async () => {
  const client = new PrismaClient()
  const workspaceId = 'oidc-http-workspace'
  const apiClientId = 'oidc-http-ui-client'
  const identityId = '00000000-0000-4000-8000-000000000971'
  const memberId = '00000000-0000-4000-8000-000000000972'
  const subject = 'authorized-human-subject'
  const identityHashSecret = 'oidc-http-identity-hash-secret-at-least-32-bytes'
  const oidcPort = await freePort()
  const appPort = await freePort()
  const issuer = `http://127.0.0.1:${oidcPort}`
  const baseUrl = `http://127.0.0.1:${appPort}`
  const redirectUri = `${baseUrl}/login/oidc/callback`
  const authorizations = new Map()
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'oidc-http-key', alg: 'RS256', use: 'sig' }
  let app
  let diagnostics = ''

  const idp = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/.well-known/openid-configuration') {
      response.end(JSON.stringify({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }))
      return
    }
    if (request.url === '/jwks') { response.end(JSON.stringify({ keys: [jwk] })); return }
    if (request.url === '/token' && request.method === 'POST') {
      const basic = `Basic ${Buffer.from('apollo-oidc-http:oidc-http-client-secret').toString('base64')}`
      if (request.headers.authorization !== basic) { response.writeHead(401); response.end(JSON.stringify({ error: 'invalid_client' })); return }
      const form = new URLSearchParams(await requestBody(request))
      const code = form.get('code')
      const transaction = authorizations.get(code)
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (!transaction || challenge !== transaction.codeChallenge || form.get('redirect_uri') !== redirectUri) {
        response.writeHead(400); response.end(JSON.stringify({ error: 'invalid_grant' })); return
      }
      const now = Math.floor(Date.now() / 1000)
      const idToken = await new SignJWT({ nonce: transaction.wrongNonce ? 'w'.repeat(43) : transaction.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'oidc-http-key' })
        .setIssuer(issuer).setAudience('apollo-oidc-http').setSubject(transaction.subject)
        .setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey)
      response.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }))
      return
    }
    response.writeHead(404)
    response.end(JSON.stringify({ error: 'not_found' }))
  })

  const cleanup = async () => {
    await client.v2UiSession.deleteMany({ where: { workspaceId } })
    await client.v2OidcAuthorization.deleteMany({ where: { issuer } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2WorkspaceMember.deleteMany({ where: { workspaceId } })
    await client.v2ApiAdministrationCommand.deleteMany({ where: { workspaceId } })
    await client.v2ApiCredential.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2HumanIdentity.deleteMany({ where: { id: identityId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await client.v2Workspace.create({ data: { id: workspaceId, slug: 'oidc-http', name: 'OIDC HTTP' } })
    await client.v2ApiClient.create({ data: {
      id: apiClientId, workspaceId, name: 'OIDC HTTP UI', type: 'service-account',
      allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '[]', createdBy: 'system:test',
    } })
    await client.v2WorkspaceUiPrincipal.create({ data: { workspaceId, clientId: apiClientId, createdAt: new Date(), updatedAt: new Date() } })
    await client.v2HumanIdentity.create({ data: {
      id: identityId, issuer, subjectHash: oidcIdentitySubjectHash(issuer, subject, { APOLLO_IDENTITY_HASH_SECRET: identityHashSecret }),
      status: 'active', createdAt: new Date(), updatedAt: new Date(),
    } })
    await client.v2WorkspaceMember.create({ data: {
      id: memberId, workspaceId, identityId, role: 'administrator', status: 'active', createdAt: new Date(), updatedAt: new Date(),
    } })
    await new Promise((resolve, reject) => { idp.once('error', reject); idp.listen(oidcPort, '127.0.0.1', resolve) })
    app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(appPort)], {
      cwd: process.cwd(),
      env: {
        ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_AUTH_MODE: 'oidc', APOLLO_OIDC_ALLOW_INSECURE_LOOPBACK: 'true', APOLLO_OIDC_ISSUER: issuer,
        APOLLO_OIDC_CLIENT_ID: 'apollo-oidc-http', APOLLO_OIDC_CLIENT_SECRET: 'oidc-http-client-secret',
        APOLLO_OIDC_REDIRECT_URI: redirectUri, APOLLO_OIDC_RECOVERY_URL: `${issuer}/recovery`,
        APOLLO_OIDC_TRANSACTION_SECRET: 'oidc-http-transaction-secret-at-least-32-bytes',
        APOLLO_IDENTITY_HASH_SECRET: identityHashSecret,
        APOLLO_UI_SESSION_SECRET: 'oidc-http-session-rotation-secret-at-least-32-bytes',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const retain = (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-64 * 1024) }
    app.stdout.on('data', retain); app.stderr.on('data', retain)
    await waitForServer(baseUrl, app)

    const sameOriginHeaders = { origin: baseUrl, host: `127.0.0.1:${appPort}`, 'sec-fetch-site': 'same-origin' }
    assert.equal((await fetch(`${baseUrl}/v1/session`, {
      method: 'POST', headers: { ...sameOriginHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: 'never-used-password' }),
    })).status, 403)

    async function start(next = '/projects') {
      const response = await fetch(`${baseUrl}/v1/session/oidc`, {
        method: 'POST', headers: { ...sameOriginHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ next }),
      })
      const payload = await response.json()
      assert.equal(response.status, 200, JSON.stringify(payload))
      assert.equal(payload.data.recoveryUrl, `${issuer}/recovery`)
      const url = new URL(payload.data.authorizationUrl)
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      return { binding: cookie(response, 'apollo_oidc_binding'), url }
    }

    async function callback(started, code, binding = started.binding) {
      authorizations.set(code, {
        nonce: started.url.searchParams.get('nonce'), codeChallenge: started.url.searchParams.get('code_challenge'),
        subject: code.includes('unknown') ? 'unknown-subject' : subject,
        wrongNonce: code.includes('wrong-nonce'),
      })
      return fetch(`${baseUrl}/v1/session/oidc/callback`, {
        method: 'POST',
        headers: { ...sameOriginHeaders, 'content-type': 'application/json', cookie: `apollo_oidc_binding=${binding}` },
        body: JSON.stringify({ code, state: started.url.searchParams.get('state') }),
      })
    }

    const browserBound = await start()
    assert.equal((await callback(browserBound, 'authorization-code-binding', 'x'.repeat(43))).status, 401)
    const validResponse = await callback(browserBound, 'authorization-code-valid')
    const validPayload = await validResponse.json()
    assert.equal(validResponse.status, 200, JSON.stringify(validPayload))
    assert.equal(validPayload.data.workspaceId, workspaceId)
    const session = cookie(validResponse, 'apollo_session')
    assert.match(session, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(session.includes(identityId), false)
    const statusResponse = await fetch(`${baseUrl}/v1/session`, { headers: { cookie: `apollo_session=${session}` } })
    const statusPayload = await statusResponse.json()
    assert.equal(statusResponse.status, 200, JSON.stringify(statusPayload))
    assert.equal(statusPayload.data.subject, identityId)

    const rotationNow = new Date()
    await client.v2UiSession.update({
      where: { nonceHash: uiSessionNonceHash(session) },
      data: {
        issuedAt: new Date(rotationNow.getTime() - 601_000),
        lastSeenAt: rotationNow,
        idleExpiresAt: new Date(rotationNow.getTime() + 1_800_000),
      },
    })
    const concurrentRotation = await Promise.all([
      fetch(`${baseUrl}/v1/session`, { headers: { cookie: `apollo_session=${session}` } }),
      fetch(`${baseUrl}/v1/session`, { headers: { cookie: `apollo_session=${session}` } }),
    ])
    assert.deepEqual(concurrentRotation.map((response) => response.status), [200, 200])
    const rotatedSessions = concurrentRotation.map((response) => cookie(response, 'apollo_session'))
    assert.match(rotatedSessions[0], /^[A-Za-z0-9_-]{43}$/)
    assert.equal(rotatedSessions[0], rotatedSessions[1], 'concurrent refreshes must converge on one successor')
    assert.notEqual(rotatedSessions[0], session)
    assert.equal((await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { cookie: `apollo_session=${session}` },
    })).status, 401, 'the rotated identifier cannot authenticate ordinary API requests')
    assert.equal((await fetch(`${baseUrl}/v1/session`, {
      headers: { cookie: `apollo_session=${rotatedSessions[0]}` },
    })).status, 200)
    const storedSessions = await client.v2UiSession.findMany({ where: { workspaceId } })
    assert.equal(JSON.stringify(storedSessions).includes(session), false)
    assert.equal(JSON.stringify(storedSessions).includes(rotatedSessions[0]), false)
    const expiredRotation = new Date(Date.now() - 61_000)
    await client.v2UiSession.update({
      where: { nonceHash: uiSessionNonceHash(session) },
      data: {
        rotatedAt: expiredRotation,
        revokedAt: expiredRotation,
      },
    })
    assert.equal((await fetch(`${baseUrl}/v1/session`, {
      headers: { cookie: `apollo_session=${session}` },
    })).status, 401, 'the predecessor cannot recover after the bounded grace window')
    assert.equal((await callback(browserBound, 'authorization-code-replay')).status, 401)

    assert.equal((await callback(await start(), 'authorization-code-wrong-nonce')).status, 401)
    assert.equal((await callback(await start(), 'authorization-code-unknown-subject')).status, 401)
    assert.equal((await client.v2UiSession.count({ where: { workspaceId, revokedAt: null } })), 1)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\nNext diagnostics:\n${diagnostics}`)
  } finally {
    await stopChild(app)
    if (idp.listening) await new Promise((resolve) => idp.close(resolve))
    await cleanup()
    await client.$disconnect()
  }
})
