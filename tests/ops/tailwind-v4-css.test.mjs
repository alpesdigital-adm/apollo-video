import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const postcss = require('postcss')
const tailwind = require('@tailwindcss/postcss')
const project = fileURLToPath(new URL('../../', import.meta.url))
const stylesheet = path.join(project, 'src', 'app', 'globals.css')
const input = readFileSync(stylesheet, 'utf8')

const compileFrom = async (cwd) => {
  const original = process.cwd()
  try {
    process.chdir(cwd)
    return (await postcss([tailwind()]).process(input, { from: stylesheet })).css
  } finally {
    process.chdir(original)
  }
}

test('Tailwind 4 CSS includes V2 utilities and retained component styles from either build cwd', async () => {
  const fromProject = await compileFrom(project)
  const fromSrc = await compileFrom(path.join(project, 'src'))
  assert.equal(fromSrc, fromProject, 'source scanning must not depend on process cwd')

  const css = postcss.parse(fromProject)
  const declarations = (selector) => {
    let found
    css.walkRules((rule) => {
      if (rule.selector === selector) found = Object.fromEntries(rule.nodes.filter((node) => node.type === 'decl').map(({ prop, value }) => [prop, value]))
    })
    assert.ok(found, `${selector} missing from generated CSS`)
    return found
  }

  assert.ok(declarations('.rounded-2xl')['border-radius'])
  assert.ok(declarations('.border-zinc-800')['border-color'])
  assert.equal(declarations('.badge-primary').display, 'inline-flex')
  assert.ok(declarations('.badge-primary')['background-color'])
  assert.ok(declarations('.btn-primary')['background-image'])
  assert.equal(declarations('.outline-hidden')['outline-style'], 'none')
  assert.match(fromProject, /@media \(forced-colors: active\)/)
  assert.match(fromProject, /@keyframes accent-pulse[\s\S]*?opacity: 0\.75/)
})
