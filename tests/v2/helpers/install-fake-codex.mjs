import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('./fake-codex.mjs', import.meta.url)

/**
 * Installs a copy of the Codex stand-in in a directory of its own with the behaviour a suite asks for. Returns the path to hand to
 * `APOLLO_V2_CODEX_BIN`, the invocations it has seen, a way to change its behaviour and a way to remove it.
 */
export function installFakeCodex(config = {}, root = tmpdir()) {
  const directory = mkdtempSync(join(root, 'apollo-fake-codex-'))
  const binary = join(directory, 'fake-codex.mjs')
  copyFileSync(SCRIPT, binary)
  const write = (next) => writeFileSync(`${binary}.config.json`, JSON.stringify(next))
  write(config)
  return Object.freeze({
    binary, directory,
    configure: (next) => write(next),
    invocations: () => (existsSync(`${binary}.log.jsonl`) ? readFileSync(`${binary}.log.jsonl`, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    executions: () => (existsSync(`${binary}.log.jsonl`) ? readFileSync(`${binary}.log.jsonl`, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.command === 'exec') : []),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  })
}
