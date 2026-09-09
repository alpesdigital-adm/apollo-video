import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import ts from 'typescript'

/**
 * Every row the PostgreSQL suite offers, against the columns the schema makes
 * mandatory.
 *
 * This exists because of how the Wave 20 database E2E actually failed. Two
 * migrations added `evidenceJson` and `transformJson` as TEXT NOT NULL with the
 * default dropped, and the suite that was written before them kept offering
 * rows without those columns. The result was not a red CHECK — it was
 * `Argument evidenceJson is missing` from Prisma, on the first insert, so the
 * suite died before it asserted anything; and in the block that asserts a
 * refusal, the row WAS refused, by the ORM, one line before the constraint it
 * names could see it. A suite that cannot reach its own assertions is worse
 * than no suite, because CI is green until someone brings a database.
 *
 * Nothing here needs a database. The schema is read from `schema.prisma` and
 * the row literals are read out of the E2E with the TypeScript parser, so the
 * check runs in `npm test` on a machine with no PostgreSQL at all — which is
 * every machine this lane was written on.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const schema = readFileSync(`${root}prisma/v2/schema.prisma`, 'utf8')
const E2E = 'tests/v2/wave20-persistence.e2e.mjs'
const e2eSource = readFileSync(`${root}${E2E}`, 'utf8')

const SCALARS = new Set([
  'String', 'Int', 'BigInt', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes',
])

/** One `model X { … }` block of the Prisma schema. */
function modelBlock(model) {
  const anchor = schema.indexOf(`model ${model} {`)
  assert.notEqual(anchor, -1, `${model} is not declared by the Prisma schema`)
  const end = schema.indexOf('\n}', anchor)
  return schema.slice(anchor, end)
}

/**
 * The columns a `create` must name: NOT NULL, no default, and nothing Prisma
 * fills in by itself.
 */
function requiredColumnsOf(model) {
  const required = []
  for (const line of modelBlock(model).split('\n').slice(1)) {
    const match = /^\s{2}(\w+)\s+(\w+)(\?|\[\])?\s*(.*)$/.exec(line)
    if (!match) continue
    const [, name, type, modifier, attributes] = match
    if (!SCALARS.has(type)) continue
    if (modifier === '?' || modifier === '[]') continue
    if (attributes.includes('@default(') || attributes.includes('@updatedAt')) continue
    required.push(name)
  }
  assert.notEqual(required.length, 0, `${model} has no required columns; the schema parse is wrong`)
  return required
}

const source = ts.createSourceFile(E2E, e2eSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

/** `const name = <initializer>` bindings, so a spread can be followed. */
const bindings = new Map()
;(function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    bindings.set(node.name.text, node.initializer)
  }
  ts.forEachChild(node, collect)
})(source)

/** The object an arrow function returns, when it returns one directly. */
function returnedObject(node) {
  if (!ts.isArrowFunction(node)) return null
  const body = ts.isParenthesizedExpression(node.body) ? node.body.expression : node.body
  return ts.isObjectLiteralExpression(body) ? body : null
}

/**
 * Every key a row literal ends up with, following spreads.
 *
 * `unresolved` collects what could not be followed rather than ignoring it: a
 * spread this cannot read would otherwise turn a missing column into a passing
 * test, which is the failure mode the whole file is about.
 */
function keysOf(literal, unresolved, depth = 0) {
  const keys = new Set()
  assert.ok(depth < 8, 'row literal spreads are nested deeper than this walker follows')
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
        keys.add(property.name.text)
        continue
      }
      unresolved.push(`computed key at line ${lineOf(property)}`)
      continue
    }
    if (!ts.isSpreadAssignment(property)) {
      unresolved.push(`property kind ${property.kind} at line ${lineOf(property)}`)
      continue
    }
    const spread = property.expression
    let target = null
    if (ts.isIdentifier(spread)) {
      const bound = bindings.get(spread.text)
      if (bound && ts.isObjectLiteralExpression(bound)) target = bound
    } else if (ts.isCallExpression(spread) && ts.isIdentifier(spread.expression)) {
      const bound = bindings.get(spread.expression.text)
      if (bound) target = returnedObject(bound)
    }
    if (!target) {
      unresolved.push(`spread at line ${lineOf(property)}`)
      continue
    }
    for (const key of keysOf(target, unresolved, depth + 1)) keys.add(key)
  }
  return keys
}

/** Every `client.v2X.create({ data: … })` and `.createMany({ data: [ … ] })`. */
function rowsWritten() {
  const rows = []
  const unresolved = []
    ;(function walk(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'create' || node.expression.name.text === 'createMany')
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text.startsWith('v2')
    ) {
      const delegate = node.expression.expression.name.text
      const model = `V2${delegate.slice(2)}`
      const argument = node.arguments[0]
      if (!argument || !ts.isObjectLiteralExpression(argument)) {
        unresolved.push(`${model} call at line ${lineOf(node)} has no literal argument`)
      } else {
        const data = argument.properties.find(
          (property) => ts.isPropertyAssignment(property)
            && ts.isIdentifier(property.name)
            && property.name.text === 'data',
        )
        if (!data) {
          unresolved.push(`${model} call at line ${lineOf(node)} has no data property`)
        } else {
          const literals = ts.isArrayLiteralExpression(data.initializer)
            ? data.initializer.elements
            : [data.initializer]
          for (const literal of literals) {
            if (ts.isObjectLiteralExpression(literal)) {
              rows.push({ model, line: lineOf(literal), keys: keysOf(literal, unresolved) })
              continue
            }
            if (ts.isIdentifier(literal)) {
              const bound = bindings.get(literal.text)
              if (bound && ts.isObjectLiteralExpression(bound)) {
                rows.push({ model, line: lineOf(node), keys: keysOf(bound, unresolved) })
                continue
              }
            }
            if (ts.isCallExpression(literal) && ts.isIdentifier(literal.expression)) {
              const bound = bindings.get(literal.expression.text)
              const returned = bound ? returnedObject(bound) : null
              if (returned) {
                rows.push({ model, line: lineOf(node), keys: keysOf(returned, unresolved) })
                continue
              }
            }
            unresolved.push(`${model} row at line ${lineOf(node)} is not a literal this walker reads`)
          }
        }
      }
    }
    ts.forEachChild(node, walk)
  })(source)
  return { rows, unresolved }
}

test('T-F4.012 every row the PostgreSQL suite writes names every column the schema requires', () => {
  const { rows, unresolved } = rowsWritten()
  assert.deepEqual(unresolved, [], 'a row this check cannot read is a row it cannot vouch for')
  assert.ok(rows.length >= 40, `expected the Wave 20 E2E to write many rows, found ${rows.length}`)

  const missing = []
  for (const row of rows) {
    for (const column of requiredColumnsOf(row.model)) {
      if (!row.keys.has(column)) missing.push(`${E2E}:${row.line} ${row.model} is missing ${column}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    'these rows would be refused by Prisma before any CHECK could see them',
  )
})

test('T-F4.012 the two columns the E2E was written before are named by it', () => {
  const { rows } = rowsWritten()
  for (const [model, column] of [
    ['V2MulticamAngleCandidate', 'evidenceJson'],
    ['V2CameraMatchTransform', 'transformJson'],
  ]) {
    const written = rows.filter((row) => row.model === model)
    assert.notEqual(written.length, 0, `${model} is not exercised by the E2E at all`)
    for (const row of written) {
      assert.ok(row.keys.has(column), `${E2E}:${row.line} ${model} must carry ${column}`)
    }
  }
})
