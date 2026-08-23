/**
 * The dispatcher is the single validator both servers run, so its behaviour is
 * pinned here rather than described. Several of these tests exist to pin
 * asymmetries that look like bugs and are not — each one says so.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherConfig,
  type HeaderAdapter,
  type ManifestEntry,
} from '../src/dispatch';
import {
  LEGACY_VERSIONS,
  META_CAPS,
  META_SERVER,
  META_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  type Outcome,
  type RpcResponse,
} from '../src/protocol';
import { buildTools } from '../src/tools';

const SERVER_INFO = { name: 'spintax-test', title: 'spintax test', version: '9.9.9' };

function make(overrides: Partial<DispatcherConfig> = {}): Dispatcher {
  return createDispatcher({
    serverInfo: SERVER_INFO,
    instructions: 'Test instructions.',
    tools: buildTools({ maxVariants: 20, maxTemplateChars: 8192 }),
    limits: { maxVariants: 20, maxTemplateChars: 8192 },
    ...overrides,
  });
}

function res(outcome: Outcome): { body: RpcResponse; httpStatus: number } {
  if (outcome.kind !== 'response') throw new Error(`expected a response, got ${outcome.kind}`);
  return { body: outcome.body, httpStatus: outcome.httpStatus };
}

function result(outcome: Outcome): Record<string, unknown> {
  const { body } = res(outcome);
  if (!('result' in body)) throw new Error(`expected a result, got ${JSON.stringify(body)}`);
  return body.result;
}

function error(outcome: Outcome): { code: number; message: string; data?: unknown; status: number } {
  const { body, httpStatus } = res(outcome);
  if (!('error' in body)) throw new Error(`expected an error, got ${JSON.stringify(body)}`);
  return { ...body.error, status: httpStatus };
}

/** A modern-era request: `_meta` carries the version AND the client capabilities. */
const modern = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { ...params, _meta: { [META_VERSION]: PROTOCOL_VERSION, [META_CAPS]: {} } },
});

const headers = (map: Record<string, string>, decode?: (v: string) => string): HeaderAdapter => ({
  get: (name: string) => {
    const key = Object.keys(map).find(k => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : map[key]!;
  },
  ...(decode ? { decode } : {}),
});

describe('envelope invariants', () => {
  it('injects serverInfo _meta into every result', async () => {
    const d = make();
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'server/discover' },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'render_spintax', arguments: { template: 'a', seed: 1 } },
      },
    ]) {
      expect(result(await d.dispatch(message))._meta).toEqual({ [META_SERVER]: SERVER_INFO });
    }
  });

  it('never injects _meta into an error — the asymmetry is the hosted behaviour', async () => {
    const { body } = res(await make().dispatch({ jsonrpc: '2.0', id: 1, method: 'nope' }));
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found: nope' },
    });
  });

  it("carries resultType 'complete' everywhere EXCEPT initialize (era-correct, not an omission)", async () => {
    const d = make();
    for (const method of ['ping', 'tools/list', 'server/discover']) {
      expect(result(await d.dispatch({ jsonrpc: '2.0', id: 1, method })).resultType).toBe('complete');
    }
    const init = result(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    expect(init).not.toHaveProperty('resultType');
  });

  it('advises 404 for an unknown method and 200 for a tool-argument mistake', async () => {
    const d = make();
    expect(error(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'nope' })).status).toBe(404);
    const bad = await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    expect(error(bad)).toMatchObject({ code: -32602, status: 200 });
  });

  it('echoes the id, including a literal null (NOT treated as a notification)', async () => {
    const { body } = res(await make().dispatch({ jsonrpc: '2.0', id: null, method: 'ping' }));
    expect(body.id).toBeNull();
  });
});

describe('malformed messages', () => {
  it.each([
    ['an array (batching)', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], 'Batching is not supported: send a single request.'],
    ['a string', 'ping', 'Invalid JSON-RPC request.'],
    ['null', null, 'Invalid JSON-RPC request.'],
    ['no method', { jsonrpc: '2.0', id: 1 }, 'Invalid JSON-RPC request.'],
    ['a non-string method', { jsonrpc: '2.0', id: 1, method: 7 }, 'Invalid JSON-RPC request.'],
    // A client-sent RESPONSE lands here: the spec forbids it, and answering the way
    // both transports answer any other invalid frame beats being clever about it.
    ['a response frame', { jsonrpc: '2.0', id: 1, result: {} }, 'Invalid JSON-RPC request.'],
    // JSON-RPC allows a string, a number or null and nothing else, so any other id
    // cannot be echoed without emitting an envelope no conforming client can read.
    ['an object id', { jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }, 'Invalid JSON-RPC request.'],
    ['an array id', { jsonrpc: '2.0', id: [1], method: 'ping' }, 'Invalid JSON-RPC request.'],
    ['a boolean id', { jsonrpc: '2.0', id: true, method: 'ping' }, 'Invalid JSON-RPC request.'],
  ])('rejects %s with -32600 / 400 and id null', async (_label, message, message_) => {
    const e = error(await make().dispatch(message));
    expect(e).toMatchObject({ code: -32600, message: message_, status: 400 });
    expect(res(await make().dispatch(message)).body.id).toBeNull();
  });

  it('accepts and discards a notification', async () => {
    const d = make();
    expect(await d.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      kind: 'accepted',
    });
    expect(await d.dispatch({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })).toEqual(
      { kind: 'accepted' },
    );
  });
});

describe('initialize version table', () => {
  const cases: [string, string][] = [
    ...LEGACY_VERSIONS.map((v): [string, string] => [v, v]),
    // Asking for the CURRENT revision through the legacy handshake is answered
    // 2025-06-18: opening with initialize IS the legacy signal. Legal, but it
    // demotes silently — pinned so a change here has to be deliberate.
    [PROTOCOL_VERSION, '2025-06-18'],
    ['1999-01-01', '2025-06-18'],
    ['', '2025-06-18'],
  ];

  it.each(cases)('answers %s with %s', async (requested, expected) => {
    const r = result(
      await make().dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: requested },
      }),
    );
    expect(r.protocolVersion).toBe(expected);
    expect(r.serverInfo).toEqual(SERVER_INFO);
    expect(r.instructions).toBe('Test instructions.');
  });

  it('answers 2025-06-18 when protocolVersion is missing entirely', async () => {
    const r = result(await make().dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(r.protocolVersion).toBe('2025-06-18');
  });
});

describe('capabilities are derived, not declared', () => {
  it('advertises tools only when there is no resource provider', () => {
    expect(make().capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('advertises resources when a provider is present', () => {
    const provider = { list: async () => [], read: async () => null };
    expect(make({ resources: provider }).capabilities).toEqual({
      tools: { listChanged: false },
      resources: {},
    });
  });

  it('reports the same object in initialize and server/discover', async () => {
    const d = make();
    const init = result(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    const disc = result(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'server/discover' }));
    expect(init.capabilities).toEqual(d.capabilities);
    expect(disc.capabilities).toEqual(d.capabilities);
    expect(disc.supportedVersions).toEqual(SUPPORTED_VERSIONS);
  });

  it('answers -32601 for every resources/* method when it advertises none', async () => {
    const d = make();
    for (const method of ['resources/list', 'resources/templates/list', 'resources/read']) {
      const e = error(await d.dispatch({ jsonrpc: '2.0', id: 1, method, params: { uri: 'x' } }));
      expect(e).toMatchObject({ code: -32601, status: 404 });
    }
  });
});

describe('resources, when a provider is supplied', () => {
  const entry: ManifestEntry = {
    uri: 'https://example.test/a.md',
    name: 'a',
    description: 'A',
    mimeType: 'text/markdown',
  };
  const provider = {
    list: async (): Promise<ManifestEntry[]> => [entry],
    read: async (uri: string) =>
      uri === entry.uri ? { mimeType: entry.mimeType, text: '# a' } : null,
  };

  it('lists, reads and reports a miss the way the hosted server does', async () => {
    const d = make({ resources: provider });
    expect(result(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).resources).toEqual([
      entry,
    ]);
    const read = result(
      await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: entry.uri } }),
    );
    expect(read.contents).toEqual([{ uri: entry.uri, mimeType: 'text/markdown', text: '# a' }]);
    const miss = error(
      await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'nope' } }),
    );
    expect(miss).toMatchObject({
      code: -32602,
      message: 'Resource not found: nope',
      data: { uri: 'nope' },
      status: 200,
    });
    expect(
      result(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list' }))
        .resourceTemplates,
    ).toEqual([]);
  });

  it('does not read a document it did not list', async () => {
    const read = vi.fn(async () => ({ mimeType: 'text/markdown', text: 'leaked' }));
    const d = make({ resources: { list: async () => [], read } });
    error(await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'x' } }));
    expect(read).not.toHaveBeenCalled();
  });
});

describe('cache advice', () => {
  it('rides on tools/list, server/discover and resources/list', async () => {
    const d = make({ ttlMs: 42, cacheScope: 'private', resources: { list: async () => [], read: async () => null } });
    for (const method of ['tools/list', 'server/discover', 'resources/list']) {
      expect(result(await d.dispatch({ jsonrpc: '2.0', id: 1, method }))).toMatchObject({
        ttlMs: 42,
        cacheScope: 'private',
      });
    }
  });

  it('defaults to one hour, public', async () => {
    expect(result(await make().dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toMatchObject(
      { ttlMs: 3_600_000, cacheScope: 'public' },
    );
  });
});

describe('tools/call', () => {
  it('serves a tool result inside a successful envelope', async () => {
    const r = result(
      await make().dispatch(
        modern('tools/call', {
          name: 'render_spintax',
          arguments: { template: '{a|a}', seed: 1, count: 1 },
        }),
      ),
    );
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ variants: ['A'] });
    expect(r.content).toEqual([{ type: 'text', text: 'A' }]);
  });

  it('reports a tool failure as isError inside a RESULT, not a JSON-RPC error', async () => {
    const r = result(
      await make().dispatch(modern('tools/call', { name: 'render_spintax', arguments: {} })),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      { type: 'text', text: 'Missing or empty "template" argument (string required).' },
    ]);
  });

  it('reports an unknown tool as -32602', async () => {
    const e = error(
      await make().dispatch(modern('tools/call', { name: 'nope', arguments: { template: 'a' } })),
    );
    expect(e).toMatchObject({ code: -32602, message: 'Unknown tool: nope', status: 200 });
  });

  it('lists exactly the tools it was configured with', async () => {
    const tools = buildTools({ maxVariants: 3 });
    const r = result(await make({ tools }).dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.tools).toBe(tools);
  });
});

describe('modern era with an envelope (HTTP-shaped transports)', () => {
  const meta = { [META_VERSION]: PROTOCOL_VERSION, [META_CAPS]: {} };
  const req = (method: string, params: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: meta },
  });
  const good = { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'ping' };

  it('passes with matching headers', async () => {
    expect(result(await make().dispatch(req('ping'), headers(good))).resultType).toBe('complete');
  });

  it.each([
    ['missing MCP-Protocol-Version', { 'Mcp-Method': 'ping' }, 'Missing required MCP-Protocol-Version header.'],
    [
      'a version mismatch',
      { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Method': 'ping' },
      `Header mismatch: MCP-Protocol-Version '2025-06-18' does not match body value '${PROTOCOL_VERSION}'.`,
    ],
    ['missing Mcp-Method', { 'MCP-Protocol-Version': PROTOCOL_VERSION }, 'Missing required Mcp-Method header.'],
    [
      'a method mismatch',
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
      "Header mismatch: Mcp-Method 'tools/list' does not match body method 'ping'.",
    ],
  ])('rejects %s with -32020 / 400', async (_label, map, message) => {
    expect(error(await make().dispatch(req('ping'), headers(map)))).toMatchObject({
      code: -32020,
      message,
      status: 400,
    });
  });

  it('requires Mcp-Name on tools/call and resources/read', async () => {
    const d = make();
    const noName = await d.dispatch(
      req('tools/call', { name: 'render_spintax', arguments: { template: 'a' } }),
      headers({ 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/call' }),
    );
    expect(error(noName)).toMatchObject({ code: -32020, message: 'Missing required Mcp-Name header.' });

    const wrongName = await d.dispatch(
      req('tools/call', { name: 'render_spintax', arguments: { template: 'a' } }),
      headers({
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'other',
      }),
    );
    expect(error(wrongName)).toMatchObject({
      code: -32020,
      message: "Header mismatch: Mcp-Name 'other' does not match body value 'render_spintax'.",
    });
  });

  it('runs Mcp-Method / Mcp-Name through the decode hook', async () => {
    const decode = (v: string): string => {
      const m = /^=\?rev\?(.*)\?=$/.exec(v);
      return m ? m[1]!.split('').reverse().join('') : v;
    };
    const ok = await make().dispatch(
      req('ping'),
      headers({ 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': '=?rev?gnip?=' }, decode),
    );
    expect(result(ok).resultType).toBe('complete');
  });

  it('rejects an unsupported version with -32022 and the supported list', async () => {
    const e = error(
      await make().dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { _meta: { [META_VERSION]: '2030-01-01', [META_CAPS]: {} } },
      }),
    );
    expect(e).toMatchObject({
      code: -32022,
      message: 'Unsupported protocol version',
      status: 400,
      data: { supported: SUPPORTED_VERSIONS, requested: '2030-01-01' },
    });
  });

  it('demands _meta.protocolVersion when only the 2026 header says modern', async () => {
    const e = error(
      await make().dispatch(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        headers({ 'MCP-Protocol-Version': PROTOCOL_VERSION }),
      ),
    );
    expect(e).toMatchObject({
      code: -32602,
      message: `Missing required _meta field "${META_VERSION}".`,
      status: 400,
    });
  });
});

describe('modern era WITHOUT an envelope (stdio)', () => {
  // The spec is explicit for stdio: "All request metadata … is carried inline in the
  // JSON-RPC message body … There is no header layer." So the -32020 family is
  // unreachable here BY DESIGN — a body the hosted server rejects for a header
  // mismatch is served. This test exists so that stays a decision, not an accident.
  it('serves a modern request that carries no headers at all', async () => {
    expect(result(await make().dispatch(modern('ping'))).resultType).toBe('complete');
  });

  it('still enforces the body-side rules: version support and clientCapabilities', async () => {
    const d = make();
    const unsupported = await d.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { _meta: { [META_VERSION]: '2030-01-01', [META_CAPS]: {} } },
    });
    expect(error(unsupported).code).toBe(-32022);

    const noCaps = await d.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { _meta: { [META_VERSION]: PROTOCOL_VERSION } },
    });
    expect(error(noCaps)).toMatchObject({
      code: -32602,
      message: `Missing required _meta field "${META_CAPS}".`,
      status: 400,
    });
  });

  it('exempts server/discover from the clientCapabilities requirement', async () => {
    // The era probe is sent before the client has agreed anything; per the spec it
    // must get a DiscoverResult or a recognized modern error, or the client concludes
    // "legacy server". A -32602 there mis-classifies a strict-but-incomplete client.
    const r = result(
      await make().dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: { [META_VERSION]: PROTOCOL_VERSION } },
      }),
    );
    expect(r.supportedVersions).toEqual(SUPPORTED_VERSIONS);
  });

  it('treats a request with no _meta as a legacy follow-up, not an error', async () => {
    expect(result(await make().dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).tools).toHaveLength(
      4,
    );
  });
});
