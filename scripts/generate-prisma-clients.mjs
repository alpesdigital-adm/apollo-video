import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))
const environment = {
  ...process.env,
  V2_DATABASE_URL:
    process.env.V2_DATABASE_URL ??
    'postgresql://apollo:generate-only@127.0.0.1:5432/apollo_v2?schema=public',
}

for (const args of [
  ['prisma', 'generate', '--schema', 'prisma/v2/schema.prisma'],
]) {
  const result = spawnSync(process.execPath, [prismaCli, ...args.slice(1)], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
