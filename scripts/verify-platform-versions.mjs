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
const storagePins = {
  minioImage: 'apollo-minio-source:RELEASE.2025-04-22T22-12-26Z-mc.RELEASE.2025-04-16T18-13-26Z',
  minioRelease: 'RELEASE.2025-04-22T22-12-26Z',
  minioSourceCommit: '0d7408fc9969caf07de6a8c3a84f9fbb10a6739e',
  minioArchiveSha256: '7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5',
  mcRelease: 'RELEASE.2025-04-16T18-13-26Z',
  mcSourceCommit: 'b00526b153a31b36767991a4f5ce2cced435ee8e',
  mcArchiveSha256: '4cd13e34daeeb8481c3ba8686b082f161b8dc1f7aad52d715a706a587349c6ae',
  builderImage: 'golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee',
  runtimeImage: 'alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c',
}
for (const [name, expected] of Object.entries(storagePins)) equal(versions.storage[name], expected, `storage ${name}`)

equal(rootPackage.engines?.node, `>=${versions.node.minimum}`, 'Node minimum')
for (const [name, expected] of [['next', versions.web.next], ['react', versions.web.react], ['react-dom', versions.web.reactDom]]) {
  equal(rootPackage.dependencies?.[name], expected, `${name} manifest`)
  equal(locked(rootLock, name), expected, `${name} lock`)
}
equal(rootPackage.devDependencies?.['eslint-config-next'], versions.web.next, 'eslint-config-next manifest')
equal(locked(rootLock, 'eslint-config-next'), versions.web.next, 'eslint-config-next lock')
equal(remotionPackage.dependencies?.remotion, versions.render.remotion, 'Remotion manifest')
equal(locked(remotionLock, 'remotion'), versions.render.remotion, 'Remotion lock')
equal(locked(remotionLock, '@remotion/renderer'), versions.render.remotion, 'Remotion renderer lock')
for (const [name, expected] of [['@prisma/client', versions.database.prisma], ['prisma', versions.database.prisma], ['@aws-sdk/client-s3', versions.storage.awsSdkS3], ['ai', versions.clients.aiSdk], ['@modelcontextprotocol/sdk', versions.clients.mcpSdk], ['typescript', versions.clients.typescript]]) equal(locked(rootLock, name), expected, `${name} lock`)
equal(rootPackage.dependencies?.uuid, versions.clients.uuid, 'uuid manifest')
equal(locked(rootLock, 'uuid'), versions.clients.uuid, 'uuid lock')
equal(rootPackage.devDependencies?.postcss, versions.clients.postcss, 'postcss manifest')
equal(rootPackage.overrides?.postcss, versions.clients.postcss, 'postcss override')
equal(remotionPackage.overrides?.postcss, versions.clients.postcss, 'postcss renderer override')
equal(locked(rootLock, 'postcss'), versions.clients.postcss, 'postcss root lock')
equal(locked(remotionLock, 'postcss'), versions.clients.postcss, 'postcss renderer lock')
equal(rootPackage.overrides?.['fast-uri'], versions.clients.fastUri, 'fast-uri root override')
equal(remotionPackage.overrides?.['fast-uri'], versions.clients.fastUri, 'fast-uri renderer override')
equal(locked(rootLock, 'fast-uri'), versions.clients.fastUri, 'fast-uri root lock')
equal(locked(remotionLock, 'fast-uri'), versions.clients.fastUri, 'fast-uri renderer lock')
equal(rootPackage.overrides?.hono, versions.clients.hono, 'hono override')
equal(locked(rootLock, 'hono'), versions.clients.hono, 'hono root lock')
equal(rootPackage.overrides?.['ip-address'], versions.clients.ipAddress, 'ip-address override')
equal(locked(rootLock, 'ip-address'), versions.clients.ipAddress, 'ip-address root lock')
equal(rootPackage.overrides?.sharp, versions.clients.sharp, 'sharp override')
equal(locked(rootLock, 'sharp'), versions.clients.sharp, 'sharp root lock')
equal(rootPackage.overrides?.['js-yaml'], versions.clients.jsYaml, 'js-yaml override')
equal(locked(rootLock, 'js-yaml'), versions.clients.jsYaml, 'js-yaml root lock')
if (locked(rootLock, 'form-data') || locked(remotionLock, 'form-data')) failures.push('form-data must remain absent from locked dependency trees')

const [dockerfile, postgresCompose, storageCompose, storageDockerfile, adr001, adr002, adr003, adr008] = await Promise.all(['Dockerfile', 'infra/postgres/compose.yml', 'infra/object-storage/compose.yml', 'infra/object-storage/Dockerfile', 'docs/adr/ADR-001-v2-modular-architecture.md', 'docs/adr/ADR-002-database-and-migrations.md', 'docs/adr/ADR-003-object-storage-content-addressing.md', 'docs/adr/ADR-008-render-architecture-cache.md'].map((path) => readFile(resolve(root, path), 'utf8')))
if (!dockerfile.includes(`FROM node:${versions.node.containerMajor}-bookworm-slim`)) failures.push('Dockerfile Node image drifted')
if (!postgresCompose.includes(`image: ${versions.database.image}`)) failures.push('PostgreSQL/pgvector image drifted')
if ((storageCompose.match(/^\s+image: /gm) ?? []).length !== 2 || storageCompose.split(`image: ${versions.storage.minioImage}`).length !== 3) failures.push('MinIO services must use the pinned local image')
if (storageDockerfile.split(`FROM ${versions.storage.builderImage}`).length !== 3 || !storageDockerfile.includes(`FROM ${versions.storage.runtimeImage}`)) failures.push('MinIO builder/runtime base images drifted')
for (const [component, commit, hash] of [['minio', versions.storage.minioSourceCommit, versions.storage.minioArchiveSha256], ['mc', versions.storage.mcSourceCommit, versions.storage.mcArchiveSha256]]) {
  if (!storageDockerfile.includes(`ADD --checksum=sha256:${hash} https://codeload.github.com/minio/${component}/tar.gz/${commit}`)) failures.push(`${component} source archive pin drifted`)
  if (!storageDockerfile.includes(`cmd.CommitID=${commit}`) || !storageDockerfile.includes(`cmd.ShortCommitID=${commit.slice(0, 12)}`)) failures.push(`${component} binary commit metadata drifted`)
}
for (const [component, release] of [['minio', versions.storage.minioRelease], ['mc', versions.storage.mcRelease]]) {
  if (!storageDockerfile.includes(`github.com/minio/${component}/cmd.ReleaseTag=${release}`)) failures.push(`${component} release metadata drifted`)
}
if ((storageDockerfile.match(/CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -tags kqueue -trimpath/g) ?? []).length !== 2) failures.push('MinIO and mc must use upstream-compatible static build flags and read-only modules')
if ((storageDockerfile.match(/GOTOOLCHAIN=local go mod verify/g) ?? []).length !== 2) failures.push('MinIO and mc must verify downloaded Go modules')
if (!storageDockerfile.includes('COPY --from=minio-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt')) failures.push('MinIO runtime must include the builder CA bundle')
for (const token of [versions.storage.minioSourceCommit, versions.storage.mcSourceCommit, versions.storage.minioArchiveSha256, versions.storage.mcArchiveSha256, versions.storage.builderImage, versions.storage.runtimeImage]) if (!adr003.includes(token)) failures.push(`ADR-003 does not declare ${token}`)
for (const [label, document, expected] of [['ADR-001', adr001, [versions.web.next, versions.web.react, `Node ${versions.node.containerMajor}`]], ['ADR-002', adr002, [versions.database.image, `Prisma ${versions.database.prisma}`]], ['ADR-008', adr008, [`FFmpeg ${versions.render.ffmpegTarget}`, `ffprobe ${versions.render.ffprobeTarget}`, `Remotion ${versions.render.remotion}`]]]) for (const token of expected) if (!document.includes(token)) failures.push(`${label} does not declare ${token}`)

if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('Platform versions verified against manifests, locks, images and ADRs')
