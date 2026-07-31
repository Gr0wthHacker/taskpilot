// Flat config for ESLint 9 (the project is ESM: package.json "type":"module").
// Replaces the legacy .eslintrc.cjs, which ESLint 9 no longer reads by default.
// Mirrors the previous rule set: eslint:recommended + @typescript-eslint
// recommended, no-unused-vars as a warning (underscore-prefixed args ignored),
// no-explicit-any as a warning, console allowed.
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist',
      'release',
      'build',
      'node_modules',
      'drizzle',
      'tmp',
      '.claude',
      'packages/*/dist',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
    ],
  },
  {
    // Pre-existing orphaned `// eslint-disable` comments (mostly for the
    // now-`off` no-console rule) would otherwise flood the report; they're
    // harmless dead directives, not code issues. Tracked as cleanup, silenced
    // here so real findings stay visible.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  js.configs.recommended,
  {
    // Node build/tooling scripts: give them node globals so core rules like
    // no-undef don't false-positive on `process`, `__dirname`, `require`.
    files: ['scripts/**', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript's own compiler already flags undefined identifiers, and
      // core `no-undef` doesn't understand types/globals in .ts files (it
      // false-positives on `console`, DOM types, etc.). Disable per
      // typescript-eslint's standard guidance.
      'no-undef': 'off',
      // The TS-aware version supersedes the core rule (which false-positives
      // on types/enums), so turn the core one off and configure the TS one.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
  {
    // React hook correctness — scoped to the renderer, the only React code.
    // (Applying it repo-wide false-positives on `use*`-named helpers in
    // tests/backend, e.g. the `useMockedDb` test fixture.) rules-of-hooks
    // catches real bugs; exhaustive-deps is a warning the codebase annotates
    // with inline disables where intentional.
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
