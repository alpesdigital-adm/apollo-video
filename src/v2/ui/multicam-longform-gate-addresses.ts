import type { MulticamLongformEvidenceResourceType } from '../domain/multicam-longform-gate.ts'

/**
 * Where a phase-gate evidence reference of each kind can actually be opened.
 *
 * Only the kinds whose reference id IS the resource id of a published `/v1`
 * endpoint. Everything else is shown as an id and a kind: inventing an address
 * for a row that has none would hand an operator a link that 404s and teach
 * them the gate is unreliable.
 *
 * It lives here, as templates in the shape the capability registry publishes,
 * rather than as four string literals inside the page, because of what the
 * page could not prove about them. `bindUiNetworkActionsToCapabilities` walks
 * `fetch` call sites, so an `<a href>` is invisible to it: retargeting
 * `capture-session` at a path no capability declares left the whole suite, the
 * parity report and the browser E2E green, while the browser E2E asserts
 * exactly one of the four addresses. As templates, all four are checked against
 * `FOUNDATION_CAPABILITIES` the way the seven fetches are — see
 * `tests/v2/multicam-longform-gate-public-contract.test.mjs`.
 *
 * The page is a client component, so nothing here may import a domain value:
 * the resource type arrives as a type, which the compiler erases.
 */
export const MULTICAM_LONGFORM_ARTIFACT_ADDRESSES = Object.freeze({
  'media-artifact': '/v1/artifacts/{artifactId}',
  'final-export': '/v1/operations/{operationId}',
  'capture-session': '/v1/projects/{projectId}/capture-sessions/{sessionId}',
  'colour-critic-report': '/v1/projects/{projectId}/color-critic-reports/{reportId}',
} as const satisfies Partial<Record<MulticamLongformEvidenceResourceType, string>>)

export type AddressableGateArtifactType =
  keyof typeof MULTICAM_LONGFORM_ARTIFACT_ADDRESSES

/**
 * How many cited artifacts the gate page asks for.
 *
 * The listing is paginated and the route defaults to 100, so an evaluation
 * citing more than that arrived truncated with nobody saying so. Asking for the
 * capability's declared maximum makes truncation rare and `omittedArtifacts`
 * makes it visible when it still happens. Here rather than in the page so the
 * contract suite can hold it against the `limit` parameter the capability
 * publishes: asking for more than the route allows is a 400, and this page
 * swallows a failed artifact listing into an empty one.
 */
export const MULTICAM_LONGFORM_ARTIFACT_PAGE_LIMIT = 200

const ADDRESSABLE = new Set<string>(Object.keys(MULTICAM_LONGFORM_ARTIFACT_ADDRESSES))

/**
 * The address of one cited artifact, or `null` when its kind has none.
 *
 * Every template takes at most two parameters and they are not interchangeable:
 * `{projectId}` is the project the record belongs to and any other placeholder
 * is the reference's own id. Both are percent-encoded, because an evidence id
 * is a composite the server built and may carry `:` and `/`.
 */
export function multicamLongformArtifactHref(
  projectId: string,
  artifact: Readonly<{ type: string; id: string }>,
): string | null {
  if (!ADDRESSABLE.has(artifact.type)) return null
  const template =
    MULTICAM_LONGFORM_ARTIFACT_ADDRESSES[artifact.type as AddressableGateArtifactType]
  const project = encodeURIComponent(projectId)
  const id = encodeURIComponent(artifact.id)
  return template.replaceAll(
    /\{([^}]+)\}/g,
    (_match, name: string) => (name === 'projectId' ? project : id),
  )
}
