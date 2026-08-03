import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FOUNDATION_CAPABILITIES } from '../src/v2/public-api/capability-registry.ts'
import { createOpenApiDocument } from '../src/v2/public-api/openapi.ts'
import {
  PUBLIC_SCHEMA_EXAMPLES,
  publicSchemaDocument,
} from '../src/v2/public-api/schema-examples.ts'
import { PUBLIC_SCHEMAS } from '../src/v2/public-api/schema-registry.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoot = resolve(repositoryRoot, 'generated')
export const PUBLIC_API_DOCUMENTATION_DIRECTORY = resolve(generatedRoot, 'public-api')

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function createPublicApiDocumentationBundle() {
  const openApi = createOpenApiDocument()
  const documents = [
    ['openapi.json', serialize(openApi)],
    ...PUBLIC_SCHEMAS.map((definition) => [
      `schemas/${definition.id}/v${definition.version}.json`,
      serialize(publicSchemaDocument(definition)),
    ]),
  ].sort(([left], [right]) => left.localeCompare(right))
  const files = documents.map(([path, content]) => Object.freeze({
    path,
    content,
    bytes: Buffer.byteLength(content),
    sha256: digest(content),
  }))
  const bundleHash = digest(files
    .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`)
    .join(''))
  const manifest = Object.freeze({
    schemaVersion: 'public-api-documentation-build/v1',
    apiVersion: 'v1',
    bundleHash,
    openApiPath: 'openapi.json',
    capabilityCount: FOUNDATION_CAPABILITIES.length,
    schemaCount: PUBLIC_SCHEMAS.length,
    exampleCount: Object.values(PUBLIC_SCHEMA_EXAMPLES)
      .reduce((total, examples) => total + examples.length, 0),
    pathCount: Object.keys(openApi.paths).length,
    files: files.map(({ path, bytes, sha256 }) => Object.freeze({ path, bytes, sha256 })),
  })
  return Object.freeze({
    files: Object.freeze(files),
    manifest,
    manifestContent: serialize(manifest),
  })
}

export function writePublicApiDocumentationBundle() {
  const outputDirectory = PUBLIC_API_DOCUMENTATION_DIRECTORY
  if (!outputDirectory.startsWith(`${generatedRoot}${sep}`)) {
    throw new Error('Public API documentation output must remain inside generated/')
  }
  const bundle = createPublicApiDocumentationBundle()
  rmSync(outputDirectory, { recursive: true, force: true })
  for (const file of bundle.files) {
    const target = resolve(outputDirectory, file.path)
    if (!target.startsWith(`${outputDirectory}${sep}`)) {
      throw new Error('Public API documentation path escaped its output directory')
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }
  writeFileSync(resolve(outputDirectory, 'manifest.json'), bundle.manifestContent, 'utf8')
  return bundle.manifest
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = writePublicApiDocumentationBundle()
  process.stdout.write(
    `Public API documentation built: ${manifest.capabilityCount} capabilities, ` +
    `${manifest.schemaCount} schemas, ${manifest.exampleCount} examples, ` +
    `${manifest.pathCount} paths, sha256 ${manifest.bundleHash}\n`,
  )
}
