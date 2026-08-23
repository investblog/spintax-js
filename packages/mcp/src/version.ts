/**
 * A build-time constant, not a `readFileSync` of package.json: reading the manifest
 * at runtime would drag `node:fs` toward the shared entry — the one thing that must
 * stay importable by a Cloudflare Function with no `nodejs_compat`.
 *
 * `test/version.test.ts` asserts this equals package.json's version, so bumping one
 * without the other fails the suite rather than shipping a server that misreports
 * itself.
 */
export const VERSION = '0.3.0';
