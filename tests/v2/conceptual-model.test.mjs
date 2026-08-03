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

function centralRelations(source) {
  return [...source.matchAll(/^\| (V2[A-Za-z0-9]+) \| ([A-Za-z][A-Za-z0-9]+) \| ([A-Za-z0-9,]+) \| (V2[A-Za-z0-9]+) \| ([A-Za-z0-9,]+) \| (Cascade|Restrict|SetNull) \|$/gm)].map((match) => ({
    child: match[1],
    relation: match[2],
    fields: match[3].split(','),
    parent: match[4],
    references: match[5].split(','),
    onDelete: match[6],
  }))
}

function modelBlock(prisma, model) {
  const body = prisma.match(new RegExp(`^model ${model} \\{\\n([\\s\\S]*?)^\\}`, 'm'))?.[1]
  assert.ok(body, `${model} must exist in the Prisma schema`)
  return body
}

function relationDefinition(prisma, row) {
  const body = modelBlock(prisma, row.child)
  const line = body.match(new RegExp(`^\\s*${row.relation}\\s+(V2[A-Za-z0-9]+)\\??\\s+@relation\\(([^\\n]+)\\)`, 'm'))
  assert.ok(line, `${row.child}.${row.relation} must be an owning Prisma relation`)
  const fields = line[2].match(/fields:\s*\[([^\]]+)\]/)?.[1].split(',').map((field) => field.trim())
  const references = line[2].match(/references:\s*\[([^\]]+)\]/)?.[1].split(',').map((field) => field.trim())
  const onDelete = line[2].match(/onDelete:\s*(Cascade|Restrict|SetNull)/)?.[1]
  return { parent: line[1], fields, references, onDelete }
}

function hasUniqueTarget(prisma, model, fields) {
  const body = modelBlock(prisma, model)
  if (fields.length === 1) {
    const field = body.match(new RegExp(`^\\s*${fields[0]}\\s+[^\\n]+$`, 'm'))?.[0] ?? ''
    if (/@(?:id|unique)\b/.test(field)) return true
  }
  const tuples = [...body.matchAll(/@@(?:id|unique)\(\[([^\]]+)\]\)/g)]
    .map((match) => match[1].split(',').map((field) => field.trim()))
  return tuples.some((tuple) => JSON.stringify(tuple) === JSON.stringify(fields))
}

function assertCentralGraph(prisma, rows) {
  assert.ok(rows.length >= 50, 'central reference graph must remain explicit and substantial')
  assert.equal(new Set(rows.map((row) => `${row.child}.${row.relation}`)).size, rows.length)
  for (const row of rows) {
    assert.deepEqual(relationDefinition(prisma, row), {
      parent: row.parent,
      fields: row.fields,
      references: row.references,
      onDelete: row.onDelete,
    })
    assert.ok(hasUniqueTarget(prisma, row.parent, row.references), `${row.parent} [${row.references}] must be unique`)
  }
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

test('T-F0-033 documents and enforces the central aggregate reference graph', async () => {
  const [specification, prisma] = await Promise.all([
    readFile(resolve(root, 'docs/specs/10-conceptual-model.md'), 'utf8'),
    readFile(resolve(root, 'prisma/v2/schema.prisma'), 'utf8'),
  ])
  const rows = centralRelations(specification)
  assertCentralGraph(prisma, rows)

  const parents = new Map()
  for (const row of rows) {
    const adjacent = parents.get(row.child) ?? new Set()
    adjacent.add(row.parent)
    parents.set(row.child, adjacent)
  }
  for (const start of parents.keys()) {
    const pending = [start]
    const visited = new Set()
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === 'V2Workspace' || visited.has(current)) continue
      visited.add(current)
      pending.push(...(parents.get(current) ?? []))
    }
    assert.ok(visited.has(start))
    assert.ok([...visited].some((model) => parents.get(model)?.has('V2Workspace')), `${start} must reach V2Workspace`)
  }

  const manifestBindings = rows.filter((row) => row.parent === 'V2MediaArtifactManifest' && row.child !== 'V2MediaArtifactLineage')
  assert.ok(manifestBindings.length >= 8)
  for (const row of manifestBindings) {
    assert.ok(row.fields.some((field) => /artifactId$/i.test(field)), `${row.child}.${row.relation} must bind its artifact`)
    assert.deepEqual(row.references, ['id', 'artifactId', 'workspaceId'])
  }

  const crossProjectMutation = prisma.replace(
    'fields: [resultVersionId, projectId, workspaceId], references: [id, projectId, workspaceId]',
    'fields: [resultVersionId, workspaceId], references: [id, workspaceId]',
  )
  assert.throws(() => assertCentralGraph(crossProjectMutation, rows))

  const crossArtifactMutation = prisma.replace(
    '@relation("ProjectProxySourceManifest", fields: [sourceManifestId, sourceArtifactId, workspaceId], references: [id, artifactId, workspaceId]',
    '@relation("ProjectProxySourceManifest", fields: [sourceManifestId, workspaceId], references: [id, workspaceId]',
  )
  assert.throws(() => assertCentralGraph(crossArtifactMutation, rows))
})
