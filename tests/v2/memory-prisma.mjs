import { Prisma } from '../../generated/prisma-v2/index.js'

/**
 * A Prisma client that keeps its rows in a Map, driven by the real DMMF.
 *
 * This exists because there is no PostgreSQL on the machine the Wave 20
 * repositories were written on, and a repository nobody has ever read back from
 * is a repository nobody has tested. A hand-written stub would have proved
 * nothing — it would agree with whatever the repository assumed. So the shapes
 * come from `Prisma.dmmf`: the columns, which of them are NOT NULL, what their
 * defaults are, which sets of them are unique, and how the relations join.
 *
 * That makes it able to fail in the ways that matter here:
 *
 * - a column the repository forgot to write is a missing NOT NULL value, named;
 * - a second write of the same natural key raises P2002, so the replay and
 *   conflict branches are the real ones rather than dead code;
 *   the fence's `updateMany` returns a real count, so the loser really loses;
 * - `include` walks the same foreign keys the schema declares, so a child read
 *   back under the wrong parent is a mismatch rather than an empty list.
 *
 * What it cannot do, and what therefore stays unproven until CI runs the
 * PostgreSQL suite: CHECK and EXCLUDE constraints, foreign-key enforcement,
 * the driver's 64-bit integer handling, and real transaction isolation. The
 * `$transaction` here snapshots and restores, which is atomicity but not
 * concurrency.
 */

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]))

function delegateName(modelName) {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1)
}

function scalarDefault(field) {
  const value = field.default
  if (value === undefined) return undefined
  if (value !== null && typeof value === 'object') return undefined
  return value
}

function matchesValue(actual, expected) {
  if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('in' in expected) return expected.in.some((candidate) => matchesValue(actual, candidate))
    if ('notIn' in expected) return !expected.notIn.some((candidate) => matchesValue(actual, candidate))
    if ('endsWith' in expected) return typeof actual === 'string' && actual.endsWith(expected.endsWith)
    if ('startsWith' in expected) return typeof actual === 'string' && actual.startsWith(expected.startsWith)
    if ('contains' in expected) return typeof actual === 'string' && actual.includes(expected.contains)
    if ('not' in expected) return !matchesValue(actual, expected.not)
    throw new Error(`memory prisma does not implement the filter ${JSON.stringify(expected)}`)
  }
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime()
  return actual === expected
}

function compareValues(left, right) {
  if (left === right) return 0
  if (left === null || left === undefined) return -1
  if (right === null || right === undefined) return 1
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime()
  if (typeof left === 'bigint' || typeof right === 'bigint') return left < right ? -1 : 1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left) < String(right) ? -1 : 1
}

/**
 * A double the way a DOUBLE PRECISION column gives it back through Prisma.
 *
 * Prisma serialises a float parameter with sixteen significant digits, so a
 * JS number that needs seventeen — 0.22745236862429172, or 0.1 + 0.2 — is
 * stored as a DIFFERENT double and read back as that different double. Against
 * a real PostgreSQL 16 that is what turned one colour measurement into
 * "camera colour measurement hash does not match its stored content": the
 * write succeeded, the read was refused for ever.
 *
 * Keeping the JS value verbatim here would make this client lie about the
 * channel it stands in for, and every round trip through it would stay green
 * while the same data was unreadable in production. So the lossy step is
 * modelled: what goes into a Float column comes back out of it. Integers and
 * anything a domain rounds are unaffected — 16 digits is a wide channel — and
 * a value that is not is refused by its own aggregate hash, here, where the
 * fixture that produced it can be fixed.
 */
function throughFloatColumn(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  return Number(value.toPrecision(16))
}

export function createMemoryPrismaClient() {
  const tables = new Map([...MODELS.keys()].map((name) => [name, []]))

  const relationField = (model, name) => {
    const field = model.fields.find((entry) => entry.name === name && entry.kind === 'object')
    if (!field) throw new Error(`memory prisma: ${model.name} has no relation ${name}`)
    return field
  }

  const rowsOf = (modelName) => tables.get(modelName) ?? []

  function matchesWhere(model, row, where) {
    if (!where) return true
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'AND') {
        if (!(Array.isArray(expected) ? expected : [expected]).every((entry) => matchesWhere(model, row, entry))) return false
        continue
      }
      if (key === 'OR') {
        if (!(Array.isArray(expected) ? expected : [expected]).some((entry) => matchesWhere(model, row, entry))) return false
        continue
      }
      const field = model.fields.find((entry) => entry.name === key)
      if (field && field.kind === 'object') {
        // Only the `some` form is used by the Wave 20 repositories; anything
        // else would be silently answered "true" and is refused instead.
        if (!expected || typeof expected !== 'object' || !('some' in expected)) {
          throw new Error(`memory prisma does not implement the relation filter on ${model.name}.${key}`)
        }
        const children = childrenOf(model, field, row)
        const childModel = MODELS.get(field.type)
        if (!children.some((child) => matchesWhere(childModel, child, expected.some))) return false
        continue
      }
      if (!matchesValue(row[key], expected)) return false
    }
    return true
  }

  function childrenOf(model, field, row) {
    const targetModel = MODELS.get(field.type)
    if (field.relationFromFields && field.relationFromFields.length > 0) {
      const found = rowsOf(field.type).filter((candidate) =>
        field.relationFromFields.every((from, index) => candidate[field.relationToFields[index]] === row[from]))
      return found
    }
    const opposite = targetModel.fields.find((entry) =>
      entry.kind === 'object' && entry.relationName === field.relationName &&
      entry.relationFromFields && entry.relationFromFields.length > 0)
    if (!opposite) throw new Error(`memory prisma: no owning side for ${model.name}.${field.name}`)
    return rowsOf(field.type).filter((candidate) =>
      opposite.relationFromFields.every((from, index) => candidate[from] === row[opposite.relationToFields[index]]))
  }

  function applyOrder(rows, orderBy) {
    if (!orderBy) return rows
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]
    return [...rows].sort((left, right) => {
      for (const clause of clauses) {
        for (const [key, direction] of Object.entries(clause)) {
          const value = typeof direction === 'string' ? direction : direction.sort
          const comparison = compareValues(left[key], right[key])
          if (comparison !== 0) return value === 'desc' ? -comparison : comparison
        }
      }
      return 0
    })
  }

  function project(model, row, spec) {
    const output = { ...row }
    if (spec.select) {
      const selected = {}
      for (const [key, wanted] of Object.entries(spec.select)) {
        if (wanted) selected[key] = row[key]
      }
      return selected
    }
    for (const [name, nested] of Object.entries(spec.include ?? {})) {
      const field = relationField(model, name)
      const childModel = MODELS.get(field.type)
      const options = nested === true ? {} : nested
      let children = childrenOf(model, field, row)
      if (options.where) children = children.filter((child) => matchesWhere(childModel, child, options.where))
      children = applyOrder(children, options.orderBy)
      const rendered = children.map((child) => project(childModel, child, options))
      output[name] = field.isList ? rendered : rendered[0] ?? null
    }
    return output
  }

  function uniqueKeySets(model) {
    const keys = []
    const idField = model.fields.find((field) => field.isId)
    if (idField) keys.push([idField.name])
    if (model.primaryKey) keys.push([...model.primaryKey.fields])
    for (const field of model.fields) if (field.isUnique) keys.push([field.name])
    for (const unique of model.uniqueFields ?? []) keys.push([...unique])
    return keys
  }

  function assertUnique(model, row) {
    for (const key of uniqueKeySets(model)) {
      const clash = rowsOf(model.name).some((candidate) =>
        key.every((field) => candidate[field] === row[field]))
      if (!clash) continue
      const error = new Error(
        `Unique constraint failed on the fields: (${key.join(',')})`,
      )
      error.code = 'P2002'
      error.meta = { target: key }
      throw error
    }
  }

  function buildRow(model, data) {
    const row = {}
    for (const field of model.fields) {
      if (field.kind === 'object') continue
      const value = data[field.name]
      if (value !== undefined) {
        row[field.name] = field.type === 'Float' ? throughFloatColumn(value) : value
        continue
      }
      const fallback = scalarDefault(field)
      if (fallback !== undefined) {
        row[field.name] = fallback
        continue
      }
      if (field.isRequired) {
        // The failure a hand-written stub would have swallowed: a column the
        // repository never wrote is NOT NULL in PostgreSQL and would have been
        // a runtime error there and a silent `undefined` here.
        throw new Error(`memory prisma: ${model.name}.${field.name} is required and was not written`)
      }
      row[field.name] = null
    }
    for (const key of Object.keys(data)) {
      if (!model.fields.some((field) => field.name === key)) {
        throw new Error(`memory prisma: ${model.name} has no column ${key}`)
      }
    }
    return row
  }

  const delegates = {}
  for (const model of MODELS.values()) {
    delegates[delegateName(model.name)] = {
      async create(spec) {
        const row = buildRow(model, spec.data)
        assertUnique(model, row)
        rowsOf(model.name).push(row)
        return project(model, row, spec)
      },
      async createMany(spec) {
        const rows = Array.isArray(spec.data) ? spec.data : [spec.data]
        for (const data of rows) {
          const row = buildRow(model, data)
          assertUnique(model, row)
          rowsOf(model.name).push(row)
        }
        return { count: rows.length }
      },
      async findFirst(spec = {}) {
        const matched = applyOrder(
          rowsOf(model.name).filter((row) => matchesWhere(model, row, spec.where)),
          spec.orderBy,
        )
        const row = matched[0]
        return row ? project(model, row, spec) : null
      },
      async findMany(spec = {}) {
        let matched = applyOrder(
          rowsOf(model.name).filter((row) => matchesWhere(model, row, spec.where)),
          spec.orderBy,
        )
        if (typeof spec.take === 'number') matched = matched.slice(0, spec.take)
        return matched.map((row) => project(model, row, spec))
      },
      async updateMany(spec) {
        const matched = rowsOf(model.name).filter((row) => matchesWhere(model, row, spec.where))
        for (const row of matched) Object.assign(row, spec.data)
        return { count: matched.length }
      },
      async count(spec = {}) {
        return rowsOf(model.name).filter((row) => matchesWhere(model, row, spec.where)).length
      },
      async deleteMany(spec = {}) {
        const kept = rowsOf(model.name).filter((row) => !matchesWhere(model, row, spec.where))
        const removed = rowsOf(model.name).length - kept.length
        tables.set(model.name, kept)
        return { count: removed }
      },
    }
  }

  const client = {
    ...delegates,
    /** Atomic, not isolated: the snapshot is restored when the body throws. */
    async $transaction(body) {
      const snapshot = new Map([...tables].map(([name, rows]) => [name, rows.map((row) => structuredClone(row))]))
      try {
        return await body(client)
      } catch (error) {
        for (const [name, rows] of snapshot) tables.set(name, rows)
        throw error
      }
    },
    async $disconnect() {},
    /** Direct access, for a test that has to edit a row underneath a reader. */
    rows(modelName) {
      return rowsOf(modelName)
    },
  }
  return client
}
