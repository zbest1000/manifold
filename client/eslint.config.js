import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/** Client lint setup (flat config). Every finding is an error. */
const rules = {
  ...js.configs.recommended.rules,
  ...react.configs.flat.recommended.rules,
  ...react.configs.flat['jsx-runtime'].rules,
  ...reactHooks.configs.flat.recommended.rules,
  ...jsxA11y.flatConfigs.recommended.rules,
  'react/prop-types': 'off', // no PropTypes in this codebase; components are documented inline
  'react/no-unescaped-entities': 'off', // quotes in JSX copy are fine
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_|^[A-Z]', ignoreRestSiblings: true, caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Scrollable regions (<pre> blocks, tables) must be keyboard-focusable (axe:
  // scrollable-region-focusable), so a labelled region is allowed to take tabIndex.
  'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'], tags: [] }]
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  {
    files: ['**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2024 },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    settings: { react: { version: 'detect' } },
    rules
  },
  {
    // Node-side tooling and tests
    files: ['*.config.js', 'src/test/**', 'e2e/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // Dev-only renderer benchmark (not linked from the UI): it measures wall
    // time and uses a seeded PRNG during render on purpose.
    files: ['src/pages/Bench.jsx'],
    rules: { 'react-hooks/purity': 'off', 'react-hooks/immutability': 'off', 'react-hooks/set-state-in-effect': 'off' }
  },
  {
    // Playwright fixtures receive a `use` callback that is not a React hook.
    files: ['e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' }
  }
];
