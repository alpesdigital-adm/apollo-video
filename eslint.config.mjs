import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // A name used outside the scope that defines it is a runtime failure, and
    // in a suite that only runs with a database attached it is a runtime
    // failure nobody sees until CI. One test file's helper called from another
    // test's body in the same file passed every gate here — lint, typecheck and
    // `npm test` — because the body it sat in was skipped without a server.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-undef': 'error' },
  },
  globalIgnores([
    '.next/**',
    'generated/**',
    'output/**',
    'remotion/**',
  ]),
])
