/**
 * Cross-repo parity, without a network call.
 *
 * The hosted server publishes its identity in FOUR places: `functions/mcp.ts`,
 * `server.json` (the registry manifest), and twice inside
 * `static/.well-known/mcp.json` (top level and `servers[0]`). Once this package owns
 * the dispatcher, those copies can drift from the code that serves them — so the
 * invariants are asserted here, against the sibling checkout when it exists.
 *
 * Deliberately NOT a request to https://spintax.net/mcp: the hosted server and this
 * package can legitimately run different engine versions, an unseeded render is
 * random, and a release gate must not depend on the public internet. A live probe is
 * a human's job (`npm run parity:live` in the site repo).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../src/dispatch';
import { SUPPORTED_VERSIONS } from '../src/protocol';
import { buildTools } from '../src/tools';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'spintax.net');
const CARD = join(SITE, 'static', '.well-known', 'mcp.json');
const MANIFEST = join(SITE, 'server.json');
const present = existsSync(CARD) && existsSync(MANIFEST);

if (!present) {
  console.error(
    `[parity-card.test] sibling checkout not found at ${SITE} — the cross-repo invariants did NOT run.`,
  );
}

interface Card {
  serverInfo: { name: string; title: string; version: string };
  description: string;
  protocolVersions: string[];
  capabilities: Record<string, unknown>;
  servers: {
    version: string;
    protocolVersions: string[];
    capabilities: Record<string, unknown>;
  }[];
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe.skipIf(!present)('the hosted server card', () => {
  const card = present ? read<Card>(CARD) : ({} as Card);
  const manifest = present ? read<{ version: string }>(MANIFEST) : { version: '' };

  it('reports one version in all three places', () => {
    expect(card.serverInfo.version).toBe(card.servers[0]!.version);
    expect(manifest.version).toBe(card.serverInfo.version);
  });

  it('advertises exactly the revisions this dispatcher supports, in order', () => {
    expect(card.protocolVersions).toEqual(SUPPORTED_VERSIONS);
    expect(card.servers[0]!.protocolVersions).toEqual(SUPPORTED_VERSIONS);
  });

  it('advertises the capabilities the dispatcher derives for an HTTP-shaped server', () => {
    // The hosted server has a resource provider (the Markdown mirrors through
    // ASSETS), so its derived capabilities carry `resources`.
    const hosted = createDispatcher({
      serverInfo: card.serverInfo,
      instructions: '',
      tools: [],
      limits: { maxVariants: 20, maxTemplateChars: 8192 },
      resources: { list: async () => [], read: async () => null },
    });
    expect(card.capabilities).toEqual(hosted.capabilities);
    expect(card.servers[0]!.capabilities).toEqual(hosted.capabilities);
  });

  it('names the tools that actually exist', () => {
    for (const tool of buildTools({ maxVariants: 20 })) {
      expect(card.description).toContain(tool.name);
    }
  });
});
