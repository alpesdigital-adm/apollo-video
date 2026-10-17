// A project over HTTP, the way the 6.0.0 contract makes one.
//
// POST /v1/projects takes `name`, `objective` and optionally `locale`, `briefing` and `desiredAction`; it answers with the
// creation Version (contract 2: no output at all). A project has no format of its own any more: the output a journey edits
// is an explicit variant, created on top of that Version through POST /v1/projects/{projectId}/output-variants with the
// Version's id and hash as the base. This is the one place a journey does both, so a journey that used to send
// `format: '9:16'` states the aspect ratio it means as data and gets back the Version it must edit against.
//
// `call(path, body, idempotencyKey)` is the journey's own authenticated POST: it returns the `data` of a 2xx envelope and
// throws on anything else. Nothing here knows the transport, the credential or the server.
import { variantBody } from './output-world.mjs'

/** Output canvas per aspect ratio: the final render and its half-size proxy, one profile each. */
const CANVAS = Object.freeze({
  '16:9': { width: 640, height: 360, proxyWidth: 320, proxyHeight: 180 },
  '9:16': { width: 360, height: 640, proxyWidth: 180, proxyHeight: 320 },
  '1:1': { width: 480, height: 480, proxyWidth: 240, proxyHeight: 240 },
  '4:5': { width: 384, height: 480, proxyWidth: 192, proxyHeight: 240 },
})

/**
 * The create-output-variant request body for `aspectRatio`, from the published example (so it always satisfies the contract).
 * Pass `ids` to name the profile when a journey creates several variants on one project.
 */
export function variantBodyFor({ aspectRatio = '16:9', locale = 'pt-BR', profileId } = {}) {
  const canvas = CANVAS[aspectRatio]
  if (!canvas) throw new Error(`no canvas is defined for aspect ratio ${aspectRatio}`)
  const body = variantBody()
  const id = profileId ?? `profile-${aspectRatio.replace(':', 'x')}`
  body.output = { ...body.output, locale, aspectRatio, width: canvas.width, height: canvas.height, deliveryProfileId: id }
  body.profile = { ...body.profile, id,
    final: { ...body.profile.final, width: canvas.width, height: canvas.height },
    proxy: { ...body.profile.proxy, width: canvas.proxyWidth, height: canvas.proxyHeight },
    proxyToFinal: { ...body.profile.proxyToFinal, scaleX: canvas.width / canvas.proxyWidth, scaleY: canvas.height / canvas.proxyHeight } }
  delete body.baseVersionId
  delete body.baseHash
  return body
}

/**
 * Creates the project and one explicit variant. Returns the project, the creation Version, the variant Version (the head
 * a journey edits against) and the variant's identity.
 *
 * `project` is the creation body without `format` (name, objective, locale, briefing, desiredAction).
 */
export async function createProjectWithVariant(call, { project, aspectRatio = '16:9', key, variant = {} }) {
  const created = await call('/v1/projects', project, `${key}-project`)
  const projectId = created.projectAtCreation.id
  const root = created.creationVersion
  const made = await call(`/v1/projects/${projectId}/output-variants`,
    { ...variantBodyFor({ aspectRatio, locale: project.locale ?? 'pt-BR', ...variant }), baseVersionId: root.id, baseHash: root.baseHash },
    `${key}-variant`)
  return Object.freeze({ projectId, created, root, version: made.version, variant: made.variant, aspectRatio })
}
