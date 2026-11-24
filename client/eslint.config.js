import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * Client lint setup (flat config).
 *
 * Findings are ERRORS everywhere except the files listed in `PENDING`, which are
 * still being reworked by other teams: there the same rules are reported as
 * WARNINGS so `npm run lint` stays green while the debt stays visible. Remove a
 * path from `PENDING` once it is clean and its findings become errors.
 */
const PENDING = [
  'src/pages/Uns.jsx',
  'src/pages/Overview.jsx',
  'src/pages/TopicGraph.jsx',
  'src/pages/System.jsx',
  'src/pages/Trends.jsx',
  'src/pages/Devices.jsx',
  'src/pages/Tags.jsx',
  'src/pages/devices/**',
  'src/pages/tags/**',
  'src/components/ProducerFlows.jsx',
  'src/components/ConsumerFlows.jsx',
  'src/components/GraphToolbar.jsx',
  'src/components/TopicTree.jsx',
  'src/components/charts.jsx',
  'src/graph/**',
  'src/lib/api.js',
  'src/store/store.js'
];

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

const isOff = (v) => v === 'off' || v === 0 || (Array.isArray(v) && (v[0] === 'off' || v[0] === 0));
// Same rules, same options, but severity "warn" (rules that are off stay off).
const asWarnings = Object.fromEntries(
  Object.entries(rules)
    .filter(([, v]) => !isOff(v))
    .map(([k, v]) => [k, Array.isArray(v) ? ['warn', ...v.slice(1)] : 'warn'])
);

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
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
    files: ['*.config.js', 'src/test/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // Dev-only renderer benchmark (not linked from the UI): it measures wall
    // time and uses a seeded PRNG during render on purpose.
    files: ['src/pages/Bench.jsx'],
    rules: { 'react-hooks/purity': 'off', 'react-hooks/immutability': 'off', 'react-hooks/set-state-in-effect': 'off' }
  },
  { files: PENDING, rules: asWarnings }
];
