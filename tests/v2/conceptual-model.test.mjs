import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const owners = Object.freeze({
  '10.1': 'Workspace',
  '10.2': 'Project',
  '10.3': 'Media',
  '10.4': 'Capture',
  '10.5': 'Synthetic',
  '10.6': 'Execution',
})

function prdEntities(source) {
  const result = []
  for (const section of ['10.1', '10.2', '10.3', '10.4', '10.5', '10.6']) {
    const body = source.match(new RegExp(`### ${section}[^\\n]*\\n([\\s\\S]*?)(?=\\n### 10\\.|\\n---)`))?.[1] ?? ''
    for (const match of body.matchAll(/^- ([A-Za-z][A-Za-z0-9]+)$/gm)) result.push(`${section}:${match[1]}`)
  }
  return result
}

function mappings(source) {
  return [...source.matchAll(/^\| (10\.[1-6]) \| ([A-Za-z][A-Za-z0-9]+) \| ([A-Za-z]+) \| (table|snapshot|value-object|planned) \| ([^|]+) \| ([^|]+) \|$/gm)].map((match) => ({
    key: `${match[1]}:${match[2]}`,
    owner: match[3],
    representation: match[4],
    target: match[5].trim(),
    lifecycle: match[6].trim(),
  }))
}

test('T-F0-033 maps every PRD 10.1-10.6 entity exactly once to a typed target or explicit gap', async () => {
  const [prd, specification, prisma, projectSnapshots] = await Promise.all([
    readFile(resolve(root, 'docs/PRD-APOLLO-V2.md'), 'utf8'),
    readFile(resolve(root, 'docs/specs/10-conceptual-model.md'), 'utf8'),
    readFile(resolve(root, 'prisma/v2/schema.prisma'), 'utf8'),
    readFile(resolve(root, 'src/v2/domain/project-snapshot.ts'), 'utf8'),
  ])
  const expected = prdEntities(prd)
  const rows = mappings(specification)
  assert.equal(expected.length, 57)
  assert.deepEqual(rows.map((row) => row.key).sort(), [...expected].sort())
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length)

  for (const row of rows) {
    assert.equal(row.owner, owners[row.key.slice(0, 4)])
    assert.match(row.lifecycle, /\S/)
    if (row.representation === 'table' || row.representation === 'snapshot') {
      const models = row.target.match(/V2[A-Za-z0-9]+/g) ?? []
      assert.ok(models.length > 0, `${row.key} must name a typed Prisma model`)
      for (const model of models) assert.match(prisma, new RegExp(`^model ${model} \\{`, 'm'))
      if (row.representation === 'snapshot') {
        const kind = row.target.match(/kind=([a-z-]+)/)?.[1]
        assert.ok(kind, `${row.key} must declare a snapshot kind`)
        assert.match(projectSnapshots, new RegExp(`'${kind}'`))
      }
    } else if (row.representation === 'value-object') {
      const [relativePath, symbol] = row.target.split('#')
      assert.ok(relativePath && symbol, `${row.key} must point to file#symbol`)
      const source = await readFile(resolve(root, relativePath), 'utf8')
      assert.match(source, new RegExp(`export (?:interface|type|class|const) ${symbol}\\b`))
    } else {
      assert.match(row.target, /^gap: /)
    }
  }
  assert.doesNotMatch(prisma, /^model V2(?:Conceptual|Generic|Entity|Document)\b/m)
})
