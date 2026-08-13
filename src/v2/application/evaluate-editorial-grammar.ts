import {
  evaluateEditorialGrammar,
  type EditorialGrammarEvaluationInput,
} from '../domain/editorial-grammar.ts'

export function evaluateEditorialGrammarService() {
  return async function evaluate(input: EditorialGrammarEvaluationInput) {
    return evaluateEditorialGrammar(input)
  }
}
