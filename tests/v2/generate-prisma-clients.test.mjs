import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const wrapper = fileURLToPath(new URL('../../scripts/generate-prisma-clients.mjs', import.meta.url))

function packageAt(root, name) {
  const directory = join(root, 'node_modules', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  return directory
}

function fixture(root) {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"private":true}')
  copyFileSync(wrapper, join(root, 'scripts', 'generate-prisma-clients.mjs'))
  const prisma = packageAt(root, 'prisma')
  packageAt(root, '@prisma/client')
  packageAt(root, 'typescript')
  mkdirSync(join(prisma, 'build'), { recursive: true })
  writeFileSync(join(prisma, 'build', 'index.js'), [
    "const { writeFileSync } = require('node:fs')",
    'writeFileSync(process.env.PRISMA_WRAPPER_PROBE_OUTPUT, JSON.stringify({',
    '  cwd: process.cwd(), skipAutoinstall: process.env.PRISMA_GENERATE_SKIP_AUTOINSTALL,',
    '  argv: process.argv.slice(2),',
    '}))',
  ].join('\n'))
  return join(root, 'scripts', 'generate-prisma-clients.mjs')
}

function run(script, outside, output, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: outside,
    env: { ...process.env, PRISMA_GENERATE_SKIP_AUTOINSTALL: '0',
      PRISMA_WRAPPER_PROBE_OUTPUT: output },
    encoding: 'utf8', timeout: 10_000,
  })
}

test('Prisma wrapper pins checkout cwd and prevents auto-install before local CLI spawn', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'apollo-prisma-wrapper-'))
  try {
    const project = join(scratch, 'project')
    const script = fixture(project)
    const output = join(scratch, 'invocation.json')
    const checked = run(script, scratch, output, ['--check'])
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(existsSync(output), false)
    const result = run(script, scratch, output)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      cwd: project, skipAutoinstall: '1',
      argv: ['generate', '--schema', 'prisma/v2/schema.prisma'],
    })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('Prisma wrapper rejects packages or CLI escaping checkout dependencies before spawn', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'apollo-prisma-wrapper-'))
  try {
    const escapedPackageProject = join(scratch, 'package-escape')
    const packageScript = fixture(escapedPackageProject)
    const externalPackage = join(scratch, 'external-prisma')
    mkdirSync(join(externalPackage, 'build'), { recursive: true })
    writeFileSync(join(externalPackage, 'package.json'), '{"name":"prisma","version":"0.0.0"}')
    writeFileSync(join(externalPackage, 'build', 'index.js'), '')
    const localPackage = join(escapedPackageProject, 'node_modules', 'prisma')
    rmSync(localPackage, { recursive: true })
    symlinkSync(externalPackage, localPackage, 'junction')
    const packageOutput = join(scratch, 'package-invocation.json')
    const packageResult = run(packageScript, scratch, packageOutput, ['--check'])
    assert.notEqual(packageResult.status, 0)
    assert.match(packageResult.stderr, /checkout-local prisma/)
    assert.equal(existsSync(packageOutput), false)

    const escapedCliProject = join(scratch, 'cli-escape')
    const cliScript = fixture(escapedCliProject)
    const externalBuild = join(scratch, 'external-build')
    mkdirSync(externalBuild)
    writeFileSync(join(externalBuild, 'index.js'), '')
    const localBuild = join(escapedCliProject, 'node_modules', 'prisma', 'build')
    rmSync(localBuild, { recursive: true })
    symlinkSync(externalBuild, localBuild, 'junction')
    const cliOutput = join(scratch, 'cli-invocation.json')
    const cliResult = run(cliScript, scratch, cliOutput)
    assert.notEqual(cliResult.status, 0)
    assert.match(cliResult.stderr, /CLI must resolve inside checkout-local prisma/)
    assert.equal(existsSync(cliOutput), false)

    const escapedDependencyProject = join(scratch, 'dependency-escape')
    const dependencyScript = fixture(escapedDependencyProject)
    const externalDependencies = join(scratch, 'external-dependencies')
    const externalPrisma = packageAt(externalDependencies, 'prisma')
    packageAt(externalDependencies, '@prisma/client')
    packageAt(externalDependencies, 'typescript')
    mkdirSync(join(externalPrisma, 'build'))
    writeFileSync(join(externalPrisma, 'build', 'index.js'), '')
    writeFileSync(join(escapedDependencyProject, 'package-lock.json'), '{"name":"checkout"}')
    writeFileSync(join(externalDependencies, 'package-lock.json'), '{"name":"other"}')
    const localDependencies = join(escapedDependencyProject, 'node_modules')
    rmSync(localDependencies, { recursive: true })
    symlinkSync(join(externalDependencies, 'node_modules'), localDependencies, 'junction')
    const dependencyOutput = join(scratch, 'dependency-invocation.json')
    const dependencyResult = run(dependencyScript, scratch, dependencyOutput)
    assert.notEqual(dependencyResult.status, 0)
    assert.match(dependencyResult.stderr, /must match the checkout lockfile/)
    assert.equal(existsSync(dependencyOutput), false)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
