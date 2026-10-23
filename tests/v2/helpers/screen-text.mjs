import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * The words a screen shows, read from its source (the render itself needs a browser and a database; the E2E journeys cover that). Every JSX text, every
 * string a JSX attribute that a person reads (`title`, `placeholder`, `aria-label`, `alt`, `label`) and every string literal inside a JSX expression
 * (a label in a list, a branch of a ternary) is a visible text; the attributes that are code (`className`, `data-*`, `id`, `key`, `type`, `value`,
 * `name`, `htmlFor`, `href`, `role`...) are not. A string handed to `setNotice(...)`, `new Error(...)` or kept in a constant named `*_LABELS`/`*_TEXT`
 * is shown too, so those are read as well.
 */
const READ_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label'])
const MESSAGE_CALLS = new Set(['setNotice', 'setError', 'setMessage', 'setBriefingError', 'setNameError', 'setDestinationError', 'setDraftError'])

function literalTexts(node) {
  const found = []
  const visit = (current) => {
    if (ts.isStringLiteralLike(current)) found.push(current.text)
    else if (ts.isTemplateExpression(current)) {
      found.push(current.head.text, ...current.templateSpans.map((span) => span.literal.text))
      current.templateSpans.forEach((span) => visit(span.expression))
      return
    }
    // A nested element is read by the main walk (its own text and attributes); descending here would count its code attributes as texts.
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) return
    // Code inside an expression (a comparison, a lookup key) is not a text.
    if (ts.isBinaryExpression(current) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(current.operatorToken.kind)) return
    if (ts.isElementAccessExpression(current)) { visit(current.expression); return }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && ['includes', 'has', 'startsWith', 'endsWith', 'test', 'get'].includes(current.expression.name.text)) return
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

export function visibleTexts(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const texts = []
  const add = (text, node) => {
    const clean = text.replace(/\s+/gu, ' ').trim()
    if (clean.length === 0) return
    texts.push({ text: clean, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
  }
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node.text, node)
    else if (ts.isJsxAttribute(node) && node.initializer && READ_ATTRIBUTES.has(node.name.getText())) {
      if (ts.isStringLiteral(node.initializer)) add(node.initializer.text, node)
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) literalTexts(node.initializer.expression).forEach((text) => add(text, node))
    } else if (ts.isJsxExpression(node) && node.expression && !(node.parent && ts.isJsxAttribute(node.parent))) {
      literalTexts(node.expression).forEach((text) => add(text, node))
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && MESSAGE_CALLS.has(node.expression.text)) {
      node.arguments.forEach((argument) => literalTexts(argument).forEach((text) => add(text, node)))
    } else if (ts.isNewExpression(node) && node.expression.getText() === 'Error') {
      (node.arguments ?? []).forEach((argument) => literalTexts(argument).forEach((text) => add(text, node)))
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /(?:_LABELS|_TEXT|_TEXTS|_MESSAGE|_NAMES)$/u.test(node.name.text) && node.initializer) {
      literalTexts(node.initializer).forEach((text) => add(text, node))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return texts
}
