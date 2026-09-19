#!/usr/bin/env node
// Resolves the aggregate resource budget of one profile and prints the quotas
// the deploy must enforce, or refuses with exit code 2 before any mutation.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON node_modules/tsx/dist/cli.mjs \
//     scripts/ops/resource-budget.mjs --profile isolated-ci --localization-enabled false [--format json|shell]
//
// `--format shell` prints one `kind|role|cpus|memoryBytes|pidsLimit` line per
// enabled container and per auxiliary for the bash deploy to `read`. No
// secret is ever read or printed: the only inputs are the catalog and, for the
// shared profile, the operator-approved budget document.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as importedResourceBudget from '../../src/v2/infrastructure/resource-budget/resource-budget.ts'

// tsx transpiles the TypeScript module to CommonJS under this package (no
// `"type": "module"`), so the named export may sit behind `default`; Node's
// own type stripping exposes it directly. Same unwrapping as the worker scripts.
const resourceBudget = importedResourceBudget.resolveResourceBudget
  ? importedResourceBudget
  : importedResourceBudget.default
const { resolveResourceBudget } = resourceBudget

const root = resolve(import.meta.dirname, '..', '..')

function parseArguments(argv) {
  const options = { profile: null, catalog: 'config/resource-budget.json', approvedFile: null, format: 'json', features: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      return next
    }
    switch (argument) {
      case '--profile':
        options.profile = value()
        break
      case '--catalog':
        options.catalog = value()
        break
      case '--approved-file':
        options.approvedFile = value()
        break
      case '--format':
        options.format = value()
        break
      case '--localization-enabled': {
        const raw = value()
        if (raw !== 'true' && raw !== 'false') throw new Error('--localization-enabled must be true or false')
        options.features.localization = raw === 'true'
        break
      }
      default:
        throw new Error(`unknown argument ${argument}`)
    }
  }
  if (!options.profile) throw new Error('--profile is required')
  if (!['json', 'shell'].includes(options.format)) throw new Error('--format must be json or shell')
  return options
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'))
}

let options
try {
  options = parseArguments(process.argv.slice(2))
} catch (error) {
  console.error(`resource-budget: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const catalog = await readJson(options.catalog)
const approvedFile = options.approvedFile ?? process.env.APOLLO_RESOURCE_BUDGET_APPROVED_FILE ?? null
const approvedBudget = approvedFile ? await readJson(approvedFile) : undefined
const resolution = resolveResourceBudget({
  catalog,
  profile: options.profile,
  enabledFeatures: options.features,
  approvedBudget,
})

if (!resolution.ok) {
  for (const error of resolution.errors) console.error(`resource-budget: ${error}`)
  if (options.format === 'json') process.stdout.write(`${JSON.stringify(resolution)}\n`)
  process.exit(2)
}

if (options.format === 'json') {
  process.stdout.write(`${JSON.stringify(resolution)}\n`)
} else {
  const lines = [
    ...resolution.containers
      .filter((container) => container.enabled)
      .map((container) => ['container', container.role, container.cpus, container.memoryBytes, container.pidsLimit].join('|')),
    ...resolution.auxiliaries.map((auxiliary) => ['auxiliary', auxiliary.role, auxiliary.cpus, auxiliary.memoryBytes, auxiliary.pidsLimit].join('|')),
    ['envelope', resolution.profile, resolution.envelope.cpus, resolution.envelope.memoryBytes, resolution.envelope.pids].join('|'),
    ['sum', resolution.profile, resolution.sum.cpus, resolution.sum.memoryBytes, resolution.sum.pids].join('|'),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}
