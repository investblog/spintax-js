/**
 * `@spintax/mcp` — the transport-free half of an MCP server for spintax templates.
 *
 * This entry is what the hosted Cloudflare Function at spintax.net/mcp imports, so
 * it MUST stay free of `node:*` at runtime: that Pages project has no
 * `nodejs_compat` flag. `test/no-node-imports.test.ts` asserts it on the built
 * artifact, because no compiler flag can express the rule.
 *
 * The transport lives behind `@spintax/mcp/stdio`, and the executable
 * (`spintax-mcp`) wires the two together with a local `#include` resolver.
 */

export * from './protocol';
export * from './tools';
export * from './call-tool';
export * from './dispatch';
export { VERSION } from './version';
