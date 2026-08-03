import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'))
const versions = await readJson('config/platform-versions.json')
const rootPackage = await readJson('package.json')
const rootLock = await readJson('package-lock.json')
const remotionPackage = await readJson('remotion/package.json')
const remotionLock = await readJson('remotion/package-lock.json')
const failures = []
const equal = (actual, expected, label) => { if (actual !== expected) failures.push(`${label}: expected ${expected}, found ${actual ?? '<missing>'}`) }
const locked = (lock, name) => lock.packages?.[`node_modules/${name}`]?.version

equal(rootPackage.engines?.node, `>=${versions.node.minimum}`, 'Node minimum')
for (const [name, expected] of [['next', versions.web.next], ['react', versions.web.react], ['react-dom', versions.web.reactDom]]) {
  equal(rootPackage.dependencies?.[name], expected, `${name} manifest`)
  equal(locked(rootLock, name), expected, `${name} lock`)
}
equal(remotionPackage.dependencies?.remotion, versions.render.remotion, 'Remotion manifest')
equal(locked(remotionLock, 'remotion'), versions.render.remotion, 'Remotion lock')
equal(locked(remotionLock, '@remotion/renderer'), versions.render.remotion, 'Remotion renderer lock')
for (const [name, expected] of [['@prisma/client', versions.database.prisma], ['prisma', versions.database.prisma], ['@aws-sdk/client-s3', versions.storage.awsSdkS3], ['ai', versions.clients.aiSdk], ['@modelcontextprotocol/sdk', versions.clients.mcpSdk], ['typescript', versions.clients.typescript]]) equal(locked(rootLock, name), expected, `${name} lock`)

const [dockerfile, postgresCompose, storageCompose, adr001, adr002, adr008] = await Promise.all(['Dockerfile', 'infra/postgres/compose.yml', 'infra/object-storage/compose.yml', 'docs/adr/ADR-001-v2-modular-architecture.md', 'docs/adr/ADR-002-database-and-migrations.md', 'docs/adr/ADR-008-render-architecture-cache.md'].map((path) => readFile(resolve(root, path), 'utf8')))
if (!dockerfile.includes(`FROM node:${versions.node.containerMajor}-bookworm-slim`)) failures.push('Dockerfile Node image drifted')
if (!postgresCompose.includes(`image: ${versions.database.image}`)) failures.push('PostgreSQL/pgvector image drifted')
if (!storageCompose.includes(`image: ${versions.storage.minioImage}`)) failures.push('MinIO image drifted')
for (const [label, document, expected] of [['ADR-001', adr001, [versions.web.next, versions.web.react, `Node ${versions.node.containerMajor}`]], ['ADR-002', adr002, [versions.database.image, `Prisma ${versions.database.prisma}`]], ['ADR-008', adr008, [`FFmpeg ${versions.render.ffmpegTarget}`, `ffprobe ${versions.render.ffprobeTarget}`, `Remotion ${versions.render.remotion}`]]]) for (const token of expected) if (!document.includes(token)) failures.push(`${label} does not declare ${token}`)

if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('Platform versions verified against manifests, locks, images and ADRs')
