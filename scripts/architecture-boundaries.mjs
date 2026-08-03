import { posix } from 'node:path'

export const V2_LAYER_DEPENDENCIES = Object.freeze({
  domain: Object.freeze(['domain']),
  application: Object.freeze(['application', 'domain']),
  infrastructure: Object.freeze(['infrastructure', 'application', 'domain']),
  'public-api': Object.freeze(['public-api', 'application', 'domain']),
  agent: Object.freeze(['agent', 'public-api', 'application', 'domain']),
  mcp: Object.freeze(['mcp', 'public-api', 'application', 'domain']),
  ui: Object.freeze(['ui', 'public-api', 'application', 'domain']),
})

const PUBLIC_API_COMPOSITION_ROOTS = new Set(['public-api/authentication.ts'])
const WEB_COMPOSITION_ROOTS = new Set(['src/app/_auth/ui-page-session.ts'])
const SQLITE_IMPORT = /^(?:better-sqlite3|sqlite3|sqlite|@prisma\/adapter-better-sqlite3)(?:\/|$)/
const SQLITE_PACKAGES = new Set(['better-sqlite3', 'sqlite3', 'sqlite', '@prisma/adapter-better-sqlite3'])

export function v2PersistenceConfigurationViolations(packageManifest, prismaSchema) {
  const violations = []
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(packageManifest?.[section] ?? {})) {
      if (SQLITE_PACKAGES.has(dependency)) violations.push(`package.json: V2 runtime cannot depend on ${dependency}`)
    }
  }
  if (!/datasource\s+db\s*\{[\s\S]*?provider\s*=\s*"postgresql"[\s\S]*?\}/.test(prismaSchema)) {
    violations.push('prisma/v2/schema.prisma: V2 datasource must remain PostgreSQL')
  }
  return violations
}

function v2TargetLayer(importer, specifier) {
  if (specifier.startsWith('@/v2/')) return specifier.slice('@/v2/'.length).split('/')[0]
  if (!specifier.startsWith('.')) return null
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier))
  return target.startsWith('../') ? null : target.split('/')[0]
}

export function architectureImportViolation(importer, specifier) {
  const sourceLayer = importer.split('/')[0]
  if (!(sourceLayer in V2_LAYER_DEPENDENCIES)) return null
  if (SQLITE_IMPORT.test(specifier)) {
    return `${importer}: V2 cannot import SQLite persistence through ${specifier}`
  }
  if (specifier.includes('generated/prisma') && sourceLayer !== 'infrastructure') {
    return `${importer}: ${sourceLayer} cannot import generated Prisma persistence through ${specifier}`
  }
  const targetLayer = v2TargetLayer(importer, specifier)
  if (!targetLayer || !(targetLayer in V2_LAYER_DEPENDENCIES)) return null
  if (sourceLayer === 'public-api' && targetLayer === 'infrastructure' && PUBLIC_API_COMPOSITION_ROOTS.has(importer)) return null
  if (V2_LAYER_DEPENDENCIES[sourceLayer].includes(targetLayer)) return null
  return `${importer}: ${sourceLayer} cannot import ${targetLayer} through ${specifier}`
}

export function webDataAccessViolation(repositoryRelativePath, source, specifiers) {
  if (!repositoryRelativePath.startsWith('src/app/') && !repositoryRelativePath.startsWith('src/components/')) return null
  if (
    !/\.(ts|tsx)$/.test(repositoryRelativePath) ||
    repositoryRelativePath.startsWith('src/app/v1/') ||
    WEB_COMPOSITION_ROOTS.has(repositoryRelativePath)
  ) return null
  const forbiddenImport = specifiers.find((specifier) =>
    specifier.includes('generated/prisma') ||
    specifier === '@prisma/client' ||
    specifier.includes('/infrastructure/prisma') ||
    specifier.includes('/infrastructure/media') ||
    specifier.includes('/infrastructure/repository-factory') ||
    specifier.startsWith('@aws-sdk/'))
  if (forbiddenImport) return `${repositoryRelativePath}: Web/Editor bypasses the Application API through ${forbiddenImport}`
  if (/\b(?:PrismaClient|DATABASE_URL|S3Client)\b/.test(source)) {
    return `${repositoryRelativePath}: Web/Editor contains a direct database or storage primitive`
  }
  return null
}
