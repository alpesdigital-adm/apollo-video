import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  architectureImportViolation,
  v2PersistenceConfigurationViolations,
  webDataAccessViolation,
} from './architecture-boundaries.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const v2Root = join(repositoryRoot, 'src', 'v2')
const publicRoutesRoot = join(repositoryRoot, 'src', 'app', 'v1')
const applicationUiRoots = [
  join(repositoryRoot, 'src', 'app'),
  join(repositoryRoot, 'src', 'components'),
]
const legacyRuntimeRoot = join(repositoryRoot, 'src', 'lib')
const operationalRoots = [
  join(repositoryRoot, 'scripts'),
  join(repositoryRoot, 'tests', 'v2'),
]
const compositionRoots = new Set(['public-api/authentication.ts'])
const forbiddenLegacyPaths = [
  'prisma/schema.prisma',
  'src/app/api',
  'src/app/project',
  'src/app/assets',
  'src/app/capture',
  'src/app/settings',
  'src/components/ApolloEditorWorkspace.tsx',
  'src/components/RemotionProjectPlayer.tsx',
  'src/lib',
  'src/v2/infrastructure/synthetic-providers.ts',
]

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  ))
  return nested.flat()
}

function normalized(value) {
  return value.split(sep).join('/')
}

function staticImports(source) {
  return [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map((match) => match[2])
}

function resolvesIntoLegacyRuntime(file, specifier) {
  if (specifier.startsWith('@/lib/') || specifier === '@/lib') return true
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(file), specifier)
  return target === legacyRuntimeRoot || target.startsWith(`${legacyRuntimeRoot}${sep}`)
}

const violations = []
const rootPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
const v2PrismaSchema = await readFile(join(repositoryRoot, 'prisma', 'v2', 'schema.prisma'), 'utf8')
violations.push(...v2PersistenceConfigurationViolations(rootPackage, v2PrismaSchema))
for (const forbiddenPath of forbiddenLegacyPaths) {
  try {
    const target = join(repositoryRoot, forbiddenPath)
    const metadata = await stat(target)
    if (metadata.isFile() || (metadata.isDirectory() && (await files(target)).length > 0)) {
      violations.push(`${forbiddenPath}: retired Apollo runtime path must not contain code`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
for (const file of await files(v2Root)) {
  if (!/\.(ts|tsx)$/.test(file)) continue
  const rel = normalized(relative(v2Root, file))
  const source = await readFile(file, 'utf8')
  if (rel.startsWith('domain/') && /from ['"].*(infrastructure|application|public-api)/.test(source)) {
    violations.push(`${rel}: domain imports outer layer`)
  }
  if (rel.startsWith('public-api/') && !compositionRoots.has(rel) && /from ['"].*infrastructure/.test(source)) {
    violations.push(`${rel}: public API imports infrastructure`)
  }
  for (const specifier of staticImports(source)) {
    const layerViolation = architectureImportViolation(rel, specifier)
    if (layerViolation) violations.push(layerViolation)
    if (resolvesIntoLegacyRuntime(file, specifier)) {
      violations.push(`${rel}: V2 imports legacy runtime ${specifier}`)
    }
    if (specifier === '@prisma/client') {
      violations.push(`${rel}: V2 imports the legacy Prisma client`)
    }
  }
  if (source.includes('sqlite-prototype')) {
    violations.push(`${rel}: V2 contains compatibility persistence`)
  }
}

for (const file of await files(publicRoutesRoot)) {
  if (!/\.(ts|tsx)$/.test(file)) continue
  const rel = normalized(relative(repositoryRoot, file))
  const source = await readFile(file, 'utf8')
  for (const specifier of staticImports(source)) {
    if (resolvesIntoLegacyRuntime(file, specifier)) {
      violations.push(`${rel}: public V2 route imports legacy runtime ${specifier}`)
    }
  }
}

for (const root of applicationUiRoots) {
  for (const file of await files(root)) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const rel = normalized(relative(repositoryRoot, file))
    const source = await readFile(file, 'utf8')
    const specifiers = staticImports(source)
    for (const specifier of specifiers) {
      if (resolvesIntoLegacyRuntime(file, specifier)) {
        violations.push(`${rel}: V2 UI imports legacy runtime ${specifier}`)
      }
      if (specifier === '@prisma/client') {
        violations.push(`${rel}: V2 UI bypasses the public API through the legacy Prisma client`)
      }
    }
    const dataAccessViolation = webDataAccessViolation(rel, source, specifiers)
    if (dataAccessViolation) violations.push(dataAccessViolation)
  }
}

const destructiveRemoteDatabasePatterns = [
  {
    pattern: new RegExp(`\\b${'drop' + 'db'}\\b`, 'i'),
    reason: 'operational code must not invoke the database-drop CLI',
  },
  {
    pattern: new RegExp(`\\b${'DROP'}\\s+${'DATABASE'}\\b`, 'i'),
    reason: 'operational code must reset an isolated schema, never drop a remote database',
  },
]
for (const root of operationalRoots) {
  for (const file of await files(root)) {
    if (!/\.(mjs|cjs|js|ts|tsx|ps1|sh)$/.test(file)) continue
    if (file === fileURLToPath(import.meta.url)) continue
    const rel = normalized(relative(repositoryRoot, file))
    const source = await readFile(file, 'utf8')
    for (const rule of destructiveRemoteDatabasePatterns) {
      if (rule.pattern.test(source)) {
        violations.push(`${rel}: ${rule.reason}`)
      }
    }
    if (/detached\s*:\s*true/.test(source)) {
      violations.push(
        `${rel}: E2E processes must remain supervised and cannot be detached`,
      )
    }
  }
}

if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log(
  'Architecture and E2E operational boundaries verified: only the supervised Postgres/API-first Apollo runtime exists',
)
