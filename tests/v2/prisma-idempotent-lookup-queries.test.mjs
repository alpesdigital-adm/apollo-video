import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Prisma } from '../../generated/prisma-v2/index.js'

const repositoryDirectory = fileURLToPath(
  new URL('../../src/v2/infrastructure/prisma', import.meta.url),
)

function compoundUniqueSpreads() {
  const spreads = []
  for (const file of readdirSync(repositoryDirectory)) {
    if (!file.endsWith('.ts')) continue
    const lines = readFileSync(
      path.join(repositoryDirectory, file),
      'utf8',
    ).split('\n')
    lines.forEach((line, index) => {
      const match = line.match(
        /^\s*([A-Za-z]+(?:_[A-Za-z]+)+)\s*:\s*input\s*,?\s*$/,
      )
      if (!match) return
      let signature = index
      while (
        signature >= 0 &&
        !/^\s*(?:async\s+)?[A-Za-z]+\s*\(\s*input\s*:\s*\{/
          .test(lines[signature])
      ) {
        signature -= 1
      }
      const declared = []
      for (let cursor = signature + 1; cursor < index; cursor += 1) {
        const field = lines[cursor].match(/^\s{4}([A-Za-z][A-Za-z0-9]*)\??\s*:/)
        if (field) declared.push(field[1])
        if (/^\s*\}\)?\s*[:{]/.test(lines[cursor])) break
      }
      spreads.push({
        location: `${file}:${index + 1}`,
        compound: match[1],
        columns: match[1].split('_'),
        declared,
        hasSignature: signature >= 0,
      })
    })
  }
  return spreads
}

test('T-FR-131 compound unique lookups receive exactly the unique columns', () => {
  const spreads = compoundUniqueSpreads()
  for (const spread of spreads) {
    assert.ok(
      spread.hasSignature,
      `${spread.location} has no readable input signature`,
    )
    assert.deepEqual(
      spread.declared.toSorted(),
      spread.columns.toSorted(),
      `${spread.location} passes ${JSON.stringify(spread.declared)} into the ` +
        `${spread.compound} unique, which accepts only ` +
        `${JSON.stringify(spread.columns)}; Prisma rejects unknown keys while ` +
        'building the query, and TypeScript does not catch it because excess ' +
        'property checks do not apply to a variable',
    )
  }
})

test('T-FR-131 idempotency lookups never leak the actor context hash into a unique', () => {
  const offenders = []
  for (const file of readdirSync(repositoryDirectory)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(path.join(repositoryDirectory, file), 'utf8')
    const pattern =
      /([A-Za-z]+(?:_[A-Za-z]+)+)\s*:\s*\{([^}]*)\}/g
    for (const match of source.matchAll(pattern)) {
      const [, compound, body] = match
      if (!compound.includes('idempotencyKey')) continue
      if (compound.split('_').includes('actorContextHash')) continue
      if (/\bactorContextHash\s*:/.test(body)) {
        offenders.push(`${file} ${compound}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('T-FR-131 every compound unique used by the repositories exists in the schema', () => {
  const uniqueNames = new Set(
    Prisma.dmmf.datamodel.models.flatMap((model) =>
      (model.uniqueFields ?? []).map((fields) => fields.join('_'))),
  )
  for (const spread of compoundUniqueSpreads()) {
    assert.ok(
      uniqueNames.has(spread.compound),
      `${spread.location} targets ${spread.compound}, which is not a compound unique of the schema`,
    )
  }
})
