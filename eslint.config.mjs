// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Base ──────────────────────────────────────────────────────────────────
  eslint.configs.recommended,

  // ── TypeScript (type-aware) ────────────────────────────────────────────────
  // recommendedTypeChecked catches async/promise bugs that tsc won't flag.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Critical correctness ───────────────────────────────────────────────
      // Silent async failures are the most common bug class in indexer code.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises':  'error',
      // Adapter pattern: async interface implemented with sync backend (e.g. better-sqlite3).
      // Requiring await in every async method would force dummy awaits.
      '@typescript-eslint/require-await': 'off',

      // ── Imports ───────────────────────────────────────────────────────────
      // Prefer `import type` for type-only imports — smaller bundles, clearer intent.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // ── Dead code ─────────────────────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // ── Safety ────────────────────────────────────────────────────────────
      // null: 'ignore' allows `x != null` as the idiomatic nullish check (catches both null and undefined).
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',

      // ── Warnings — valid escape hatches exist, but flag for review ────────
      // Libraries occasionally need `any` for generic boundaries; warn, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Library code shouldn't console.log in production paths.
      'no-console': 'warn',
    },
  },

  // ── Test files — relaxed ──────────────────────────────────────────────────
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console':                       'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Test helpers often need unsafe assignment patterns.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  // ── Ignore generated / vendored ───────────────────────────────────────────
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
