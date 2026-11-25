import js from '@eslint/js';
import globals from 'globals';

/**
 * MCP server lint (flat config, ESLint 10). Deliberately modest: eslint:recommended
 * plus a few rules that catch real defects. The MCP server is an ES module on Node >= 20.
 */
export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 }
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      // A swallowed error must at least say why: `catch { /* reason */ }` passes, a bare `catch {}` does not.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-shadow-restricted-names': 'error',
      'no-self-compare': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-binary-expression': 'error'
    }
  }
];
