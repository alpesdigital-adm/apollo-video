import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkoutRoot = fileURLToPath(new URL('..', import.meta.url))
const requireFromCheckout = createRequire(join(checkoutRoot, 'package.json'))
const dependencyRoot = realpathSync.native(join(checkoutRoot, 'node_modules'))
const physicalCheckout = realpathSync.native(checkoutRoot)
const dependencyWithinCheckout = relative(physicalCheckout, dependencyRoot)
if (dependencyWithinCheckout === '..' || dependencyWithinCheckout.startsWith(`..${sep}`) ||
    isAbsolute(dependencyWithinCheckout)) {
  const checkoutLock = readFileSync(join(checkoutRoot, 'package-lock.json'))
  const dependencyLock = readFileSync(join(dirname(dependencyRoot), 'package-lock.json'))
  if (!checkoutLock.equals(dependencyLock)) {
    throw new Error('External checkout dependencies must match the checkout lockfile')
  }
}

function resolveLocalPackage(name) {
  const packageJson = realpathSync.native(requireFromCheckout.resolve(`${name}/package.json`))
  const expected = realpathSync.native(join(dependencyRoot, name, 'package.json'))
  const inside = relative(dependencyRoot, packageJson)
  if (
    packageJson.toLowerCase() !== expected.toLowerCase() ||
    inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
  ) {
    throw new Error(`Prisma generation requires checkout-local ${name}`)
  }
  return dirname(packageJson)
}

const prismaDirectory = resolveLocalPackage('prisma')
const prismaCli = realpathSync.native(join(prismaDirectory, 'build', 'index.js'))
const cliWithinPackage = relative(prismaDirectory, prismaCli)
if (cliWithinPackage === '..' || cliWithinPackage.startsWith(`..${sep}`) ||
    isAbsolute(cliWithinPackage)) {
  throw new Error('Prisma CLI must resolve inside checkout-local prisma')
}
resolveLocalPackage('@prisma/client')
resolveLocalPackage('typescript')

if (process.argv.length > 2) {
  if (process.argv.length === 3 && process.argv[2] === '--check') {
    process.exit(0)
  }
  throw new Error('Unsupported Prisma generation argument')
}

const environment = {
  ...process.env,
  PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
  V2_DATABASE_URL:
    process.env.V2_DATABASE_URL ??
    'postgresql://apollo:generate-only@127.0.0.1:5432/apollo_v2?schema=public',
}

for (const args of [
  ['prisma', 'generate', '--schema', 'prisma/v2/schema.prisma'],
]) {
  const result = spawnSync(process.execPath, [prismaCli, ...args.slice(1)], {
    cwd: checkoutRoot,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
