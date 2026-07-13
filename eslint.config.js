// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.map', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript resolves identifiers (Request/Response/URL/console/globalThis),
      // so ESLint's no-undef would only false-positive here.
      'no-undef': 'off',
      // The engine deliberately embeds U+000B (vertical tab) in whitespace classes
      // to mirror PHP's ASCII `\s` (no PCRE_UCP) for post-process/parse parity —
      // these control chars are intentional, not stray copy-paste artifacts.
      'no-control-regex': 'off',
      // `_foo` = intentionally unused: a parameter that only exists to position the ones after
      // it, or to give a test mock the real call signature so the test can assert on what was
      // passed. The codebase already writes them that way; state the convention instead of
      // leaning on no-unused-vars' "after-used" default, which only covers the first case.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
