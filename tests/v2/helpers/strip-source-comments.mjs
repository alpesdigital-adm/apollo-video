/**
 * Remove comments from TypeScript/JavaScript source before asserting on it.
 *
 * Several suites prove a route calls something by looking for the call in the
 * file — the only way to assert on a Next handler without running it. A plain
 * `source.includes(...)` measures characters rather than code: commenting the
 * call out satisfied the assertion, while deleting it failed. Strings and
 * template literals are preserved, so a call written inside a string still
 * counts as text and not as code; that is a narrower lie than a comment and no
 * assertion here depends on it.
 *
 * Not a parser. It tracks quotes so a `//` inside a string is not read as a
 * comment, and it deliberately does not try to recognise regular expression
 * literals: a regex holding an unpaired quote would confuse it. Every caller
 * asserts on the stripped text and would fail loudly rather than silently pass.
 */
export function stripSourceComments(source) {
  let out = ''
  let index = 0
  let quote = null
  while (index < source.length) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') {
        out += source.slice(index, index + 2)
        index += 2
        continue
      }
      if (character === quote) quote = null
      out += character
      index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    out += character
    index += 1
  }
  return out
}
