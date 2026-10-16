import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig([
  globalIgnores([
    'dist',
    'test-results',
    'playwright-report',
    'promo-v2/node_modules',
    'promo-v2/output',
    'desktop/node_modules',
    'desktop/dist',
    'desktop/release',
    'desktop/resources',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: [
      '*.{js,ts}',
      'backend/**/*.ts',
      'terminal-service/**/*.ts',
      'desktop/src/**/*.ts',
      'desktop/scripts/**/*.mjs',
      'tests/**/*.{js,ts}',
      'scripts/**/*.mjs',
      'promo-v2/scripts/**/*.mjs',
    ],
    languageOptions: { globals: { ...globals.node, Bun: 'readonly' } },
  },
  {
    files: ['promo-v2/src/**/*.js', 'desktop/src/workspace-ui.ts', 'desktop/src/preload.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['public/terminal-notifications.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
])
