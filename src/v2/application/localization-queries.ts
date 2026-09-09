import { DomainError } from '../domain/errors.ts'
import type { LocalizationQueryRepository } from './ports/localization-query-repository.ts'

export function createLocalizationQueries(repository: LocalizationQueryRepository) {
  return Object.freeze({
    listCanonicals: (input: { workspaceId: string; projectId: string }) => repository.listCanonicals(input),
    listCandidates: (input: { workspaceId: string; projectId: string }) => repository.listCandidates(input),
    listProfiles: (input: { workspaceId: string }) => repository.listProfiles(input),
    listVariants: (input: { workspaceId: string; projectId: string }) => repository.listVariants(input),
    readVariant: async (input: { workspaceId: string; projectId: string; variantId: string }) => {
      const variant = await repository.readVariant(input)
      if (!variant) throw new DomainError('LOCALIZATION_VARIANT_NOT_FOUND', 'Localization variant was not found')
      return variant
    },
  })
}
