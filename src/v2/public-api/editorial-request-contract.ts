import { describeEditorialRequest, type EditorialRequestView, type ReviseEditorialRequestBody } from '../application/revise-editorial-request.ts'
import type { EditorialRequestRevisionResult } from '../application/ports/editorial-request-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { presentProjectVersionV2 } from './presenters.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

const BODY_FIELDS = ['baseVersionId', 'baseHash', 'briefing', 'directives', 'variantOverrides', 'desiredAction', 'answers', 'objective', 'reason'] as const

/**
 * The body of `revise-editorial-request`. Each request field that is present REPLACES that part of the request; one that is absent keeps it
 * (`briefing: null` removes the briefing). The shape of the directives, the desired action and the answers is checked by the domain.
 */
export function parseReviseEditorialRequestBody(raw: unknown) {
  const body = object(raw, 'body')
  const unknown = Object.keys(body).filter((key) => !(BODY_FIELDS as readonly string[]).includes(key))
  if (unknown.length > 0) throw new DomainError('INVALID_ARGUMENT', 'body contains unknown fields', { fields: unknown })
  const revision: ReviseEditorialRequestBody = {
    ...(body.briefing !== undefined ? { briefing: body.briefing as string | null } : {}),
    ...(body.directives !== undefined ? { directives: body.directives } : {}),
    ...(body.variantOverrides !== undefined ? { variantOverrides: body.variantOverrides } : {}),
    ...(body.desiredAction !== undefined ? { desiredAction: body.desiredAction } : {}),
    ...(body.answers !== undefined ? { answers: body.answers } : {}),
    ...(body.objective !== undefined ? { objective: body.objective } : {}),
  }
  return Object.freeze({
    baseVersionId: text(body.baseVersionId, 'baseVersionId'),
    baseHash: text(body.baseHash, 'baseHash'),
    body: revision,
    ...(body.reason !== undefined ? { reason: text(body.reason, 'reason') } : {}),
  })
}

export function presentEditorialRequestView(view: Readonly<EditorialRequestView>) {
  const { request } = view
  return Object.freeze({
    state: view.state,
    request: Object.freeze({
      schemaVersion: request.schemaVersion,
      ...(request.briefing ? { briefing: { text: request.briefing.text, sha256: request.briefing.sha256 } } : {}),
      ...(request.objective ? { objective: request.objective } : {}),
      ...(request.desiredAction ? { desiredAction: request.desiredAction } : {}),
      directives: request.directives,
      variantOverrides: request.variantOverrides,
      requestHash: request.requestHash,
    }),
    interpretation: view.interpretation,
    interpretationAudit: view.interpretationAudit,
    unsupported: view.unsupported,
    openQuestions: view.openQuestions,
    blocksDirector: view.blocksDirector,
    hashes: view.hashes,
  })
}

type CurrentValue = EditorialRequestView & { version: { id: string; sequence: number; parentVersionId?: string | null; baseHash: string; createdAt: string } }

export function presentCurrentEditorialRequest(value: Readonly<CurrentValue>) {
  return Object.freeze({
    version: presentProjectVersionV2(
      {
        id: value.version.id,
        sequence: value.version.sequence,
        ...('parentVersionId' in value.version && value.version.parentVersionId ? { parentVersionId: value.version.parentVersionId } : {}),
        baseHash: value.version.baseHash,
        createdAt: value.version.createdAt,
      },
      { current: true, previewAvailable: false },
    ),
    ...presentEditorialRequestView(value),
  })
}

export function presentEditorialRequestRevisionResult(value: Readonly<EditorialRequestRevisionResult>) {
  const content = JSON.parse(value.briefSnapshot.contentJson) as Record<string, unknown>
  const view = describeEditorialRequest({
    ...(typeof content.objective === 'string' ? { objective: content.objective } : {}),
    briefSnapshot: { id: value.briefSnapshot.id, contentHash: value.briefSnapshot.contentHash, content },
  })
  return Object.freeze({
    command: Object.freeze({
      id: value.command.id,
      type: value.command.type,
      baseVersionId: value.command.baseVersionId,
      author: value.command.author,
      ...(value.command.reason ? { reason: value.command.reason } : {}),
      createdAt: value.command.createdAt,
    }),
    ...presentCurrentEditorialRequest({ ...view, version: value.version }),
    change: Object.freeze({ ...value.command.payload.change, objective: value.command.payload.change.objective ?? 'kept' as const }),
    interpreted: value.command.payload.interpreted,
    impact: value.impact,
    invalidations: value.invalidations,
    nextRequiredCapability: value.command.payload.nextRequiredCapability,
    replayed: value.replayed,
  })
}
