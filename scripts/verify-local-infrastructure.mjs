import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const postgres = read('infra/postgres/compose.yml')
const storage = read('infra/object-storage/compose.yml')
const envExample = read('.env.local.example')
const ci = read('.github/workflows/ci.yml')

function requires(source, pattern, message) {
  assert.match(source, pattern, message)
}

function forbids(source, pattern, message) {
  assert.doesNotMatch(source, pattern, message)
}

requires(postgres, /image: pgvector\/pgvector:[^\s]+pg16[^\s]*/, 'PostgreSQL must pin a pgvector PostgreSQL 16 image')
requires(postgres, /127\.0\.0\.1:\$\{POSTGRES_TUNNEL_PORT:-55432\}:5432/, 'PostgreSQL must bind only the documented loopback port')
for (const name of ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) {
  requires(postgres, new RegExp(`\\$\\{${name}:\\?${name} is required\\}`), `${name} must fail closed when absent`)
}
requires(postgres, /apollo-video-postgres-data:\/var\/lib\/postgresql\/data/, 'PostgreSQL data must use its dedicated volume')
requires(postgres, /pg_isready -U \$\$POSTGRES_USER -d \$\$POSTGRES_DB/, 'PostgreSQL must publish an authenticated health check')
requires(postgres, /no-new-privileges:true/, 'PostgreSQL must prevent privilege escalation')
forbids(postgres, /(?:^|["'])0\.0\.0\.0:/m, 'PostgreSQL must not publish on every interface')

requires(storage, /image: minio\/minio:RELEASE\.[0-9T-]+Z/, 'MinIO must use a pinned release')
requires(storage, /127\.0\.0\.1:\$\{MINIO_API_PORT:-59000\}:9000/, 'MinIO API must be loopback-only')
requires(storage, /127\.0\.0\.1:\$\{MINIO_CONSOLE_PORT:-59001\}:9001/, 'MinIO console must be loopback-only')
for (const name of ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']) {
  requires(storage, new RegExp(`\\$\\{${name}:\\?${name} is required\\}`), `${name} must fail closed when absent`)
}
requires(storage, /condition: service_healthy/, 'Bucket initialization must wait for a healthy server')
requires(storage, /apollo-object-storage:\/data/, 'MinIO data must use its dedicated volume')
requires(storage, /mc mb --ignore-existing/, 'Bucket creation must be convergent')
requires(storage, /mc version enable/, 'The artifact bucket must enable immutable object versions')
requires(storage, /APOLLO_V2_S3_BUCKET: \$\{APOLLO_V2_S3_BUCKET:\?APOLLO_V2_S3_BUCKET is required\}/, 'Bucket identity must be explicit')
requires(storage, /no-new-privileges:true/g, 'MinIO services must prevent privilege escalation')
forbids(storage, /apollo-local-change-me|minioadmin|(?:^|["'])0\.0\.0\.0:/m, 'Object storage must not contain default credentials or public binds')

requires(envExample, /V2_DATABASE_URL=postgresql:\/\/apollo:[^\r\n]+@127\.0\.0\.1:55432\/apollo_v2\?schema=public&application_name=apollo-video-local&connection_limit=5&pool_timeout=10&connect_timeout=10/, 'Local Prisma URL must match the isolated compose port and bounded pool')
requires(envExample, /APOLLO_V2_S3_ENDPOINT=http:\/\/127\.0\.0\.1:59000/, 'Local S3 endpoint must match the loopback compose port')
requires(envExample, /APOLLO_V2_S3_BUCKET=apollo-video/, 'Local bucket must be explicit')
requires(envExample, /APOLLO_V2_S3_FORCE_PATH_STYLE=true/, 'Local MinIO must use path-style addressing')
requires(ci, /run: npm run infra:validate/, 'CI must enforce the local infrastructure contract')

console.log('Local infrastructure contracts verified: PostgreSQL 16 and versioned MinIO are isolated and fail closed')
