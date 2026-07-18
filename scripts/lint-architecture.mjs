import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const v2Root = join(repositoryRoot, 'src', 'v2')
const publicRoutesRoot = join(repositoryRoot, 'src', 'app', 'v1')
const legacyRuntimeRoot = join(repositoryRoot, 'src', 'lib')
const compositionRoots = new Set(['public-api/authentication.ts'])

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

if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('Architecture boundaries verified: V2 has no legacy runtime imports')
