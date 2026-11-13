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
    'desktop/node_modules',
    'desktop/dist',
    'desktop/release',
    'desktop/resources',
    'machine/vendor/*.js',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Overridable methods name parameters only some implementations use.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    files: [
      '*.{js,ts}',
      'backend/**/*.ts',
      'machine/**/*.ts',
      'desktop/src/**/*.ts',
      'desktop/scripts/**/*.mjs',
      'tests/**/*.{js,ts}',
      'scripts/**/*.mjs',
    ],
    languageOptions: { globals: { ...globals.node, Bun: 'readonly' } },
  },
  {
    files: ['desktop/src/workspace-ui.ts', 'desktop/src/preload.ts'],
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
