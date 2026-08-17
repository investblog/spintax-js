// @ts-check
import js from '@eslint/js';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `vendor/` is Composer's install dir for the PHP conformance runner. It is gitignored, so CI —
  // which lints a fresh checkout — never sees it, while any machine that has actually RUN the PHP
  // parity runner has it on disk, full of PHPUnit's bundled jquery/d3/bootstrap minified bundles.
  // Without this, `npm run lint` is green in CI and red locally, which is the worst way for a gate
  // to behave.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/vendor/**', '**/*.map', '**/*.d.ts'] },
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
  // A stdio MCP server MUST NOT write anything to stdout that is not a protocol
  // message, and `console.log` goes to stdout. One stray call breaks every client at
  // once, invisibly to any test that does not spawn the binary — so the rule is a lint
  // error in the server's source. `console.error` is stderr, which the spec leaves
  // free-form for diagnostics.
  {
    files: ['packages/mcp/src/**/*.ts'],
    rules: { 'no-console': ['error', { allow: ['error'] }] },
  },
  // n8n's community-node conventions, scoped to the node implementation files.
  // The plugin's package.json ruleset (needs jsonc-eslint-parser) is deliberately
  // not wired — the post-publish scanner checks the manifest instead (spec §4).
  {
    files: ['packages/n8n-node/src/nodes/**/*.ts'],
    plugins: { 'n8n-nodes-base': n8nNodesBase },
    rules: n8nNodesBase.configs.nodes.rules,
  },
);
