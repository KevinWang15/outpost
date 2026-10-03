import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig([
  globalIgnores(['dist', 'test-results', 'playwright-report', 'promo-v2/node_modules', 'promo-v2/output']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['*.{js,ts}', 'backend/**/*.ts', 'tests/**/*.js', 'scripts/**/*.mjs', 'promo-v2/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['promo-v2/src/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
])
