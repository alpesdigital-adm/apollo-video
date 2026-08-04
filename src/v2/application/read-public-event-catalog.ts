import { PUBLIC_EVENT_CATALOG } from '../domain/public-event.ts'

export function readPublicEventCatalogService() {
  return function readPublicEventCatalog() {
    return Object.freeze({
      envelopeSchemaRef: 'apollo://schemas/public-event/v1' as const,
      events: Object.freeze(PUBLIC_EVENT_CATALOG.map((descriptor) =>
        Object.freeze({ ...descriptor }))),
    })
  }
}
