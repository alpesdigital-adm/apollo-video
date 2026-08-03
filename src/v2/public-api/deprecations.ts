export interface PublicDeprecationDefinition {
  readonly schemaRef: string
  readonly deprecatedAt: string
  readonly sunsetAt: string
  readonly migrationGuide: string
}

function requireCanonicalDateTime(value: string, field: string): Date {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`public deprecation ${field} must be a canonical UTC date-time`)
  }
  return parsed
}

function requireMigrationGuide(value: string): void {
  if (!/^\/migration-guides\/[a-z0-9][a-z0-9-]*\.md$/.test(value)) {
    throw new Error('public deprecation migrationGuide must be a canonical local Markdown path')
  }
}

export function definePublicDeprecationRegistry(
  definitions: readonly PublicDeprecationDefinition[],
): Readonly<Record<string, Readonly<PublicDeprecationDefinition>>> {
  const registry: Record<string, Readonly<PublicDeprecationDefinition>> = Object.create(null)
  for (const input of definitions) {
    if (!/^apollo:\/\/schemas\/[a-z0-9-]+\/v[1-9]\d*$/.test(input.schemaRef)) {
      throw new Error('public deprecation schemaRef must identify a versioned public schema')
    }
    if (Object.hasOwn(registry, input.schemaRef)) {
      throw new Error(`duplicate public deprecation for ${input.schemaRef}`)
    }
    const deprecatedAt = requireCanonicalDateTime(input.deprecatedAt, 'deprecatedAt')
    const sunsetAt = requireCanonicalDateTime(input.sunsetAt, 'sunsetAt')
    if (sunsetAt.getTime() - deprecatedAt.getTime() < 180 * 24 * 60 * 60 * 1000) {
      throw new Error('public deprecation sunset must allow at least 180 days')
    }
    requireMigrationGuide(input.migrationGuide)
    registry[input.schemaRef] = Object.freeze({ ...input })
  }
  return Object.freeze(registry)
}

export const PUBLIC_DEPRECATIONS = definePublicDeprecationRegistry([
  {
    schemaRef: 'apollo://schemas/error-envelope/v1',
    deprecatedAt: '2026-08-03T00:00:00.000Z',
    sunsetAt: '2027-08-03T00:00:00.000Z',
    migrationGuide: '/migration-guides/error-envelope-v1-to-v3.md',
  },
] as const)

export function isPublicMigrationGuidePath(pathname: string): boolean {
  return Object.values(PUBLIC_DEPRECATIONS).some(
    (definition) => definition.migrationGuide === pathname,
  )
}

export function publicDeprecationHeadersForSchema(
  schemaRef: string,
): Readonly<Record<string, string>> {
  const definition = PUBLIC_DEPRECATIONS[schemaRef]
  if (!definition) return Object.freeze({})
  const deprecatedSeconds = Math.floor(new Date(definition.deprecatedAt).getTime() / 1000)
  return Object.freeze({
    Deprecation: `@${deprecatedSeconds}`,
    Sunset: new Date(definition.sunsetAt).toUTCString(),
    Link: `<${definition.migrationGuide}>; rel="deprecation"; type="text/markdown"`,
  })
}
