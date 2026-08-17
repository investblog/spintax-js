/**
 * The method switch, the era detection and the `_meta` injection — one copy, both
 * transports. Everything the wire needs is an `Outcome`; nothing here constructs a
 * `Response`, reads a header directly, or writes a byte.
 *
 * Dual-era on one dispatcher, per the spec's compatibility matrix:
 *   - Modern clients (2026-07-28+) send per-request `_meta` and, on transports that
 *     have an envelope, mirroring headers. Served statelessly.
 *   - Legacy clients (2025-11-25 and earlier) open with `initialize`. Answered
 *     per-request, and no session id is ever minted — the session header was always
 *     optional for servers, which is what makes a stateless legacy server legal.
 */

import { callTool, type CallToolOptions, type IncludeSupport } from './call-tool';
import {
  LEGACY_VERSIONS,
  META_CAPS,
  META_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  rpcError,
  rpcResult,
  type Outcome,
  type RpcId,
  type RpcMessage,
  type ServerIdentity,
} from './protocol';
import type { ToolDef } from './tools';

/**
 * The transport's envelope, when it has one. Absent means body-only validation,
 * which is not a shortcut but the spec's own rule for stdio: all request metadata
 * is carried inline in the JSON-RPC message — "there is no header layer".
 */
export interface HeaderAdapter {
  get(name: string): string | null;
  /**
   * Decoder for the `=?base64?…?=` sentinel of the header-mirroring rules. Default
   * identity. The hosted server supplies its own so the refactor changes nothing.
   */
  decode?(value: string): string;
}

export interface ManifestEntry {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Omit entirely and the server advertises no `resources` capability and answers -32601. */
export interface ResourceProvider {
  list(): Promise<ManifestEntry[]>;
  read(uri: string): Promise<{ mimeType: string; text: string } | null>;
}

export interface DispatcherConfig {
  serverInfo: ServerIdentity;
  instructions: string;
  tools: ToolDef[];
  /** Same values the caller passed to `buildTools`, or the schemas will lie. */
  limits: { maxTemplateChars?: number; maxVariants: number };
  include?: IncludeSupport;
  maxDepth?: number;
  resources?: ResourceProvider;
  ttlMs?: number;
  cacheScope?: string;
}

export interface Dispatcher {
  /** Derived from the config, not a constant: no provider ⇒ no `resources` key. */
  readonly capabilities: Record<string, unknown>;
  dispatch(message: unknown, headers?: HeaderAdapter): Promise<Outcome>;
}

const identity = (v: string): string => v;

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const capabilities: Record<string, unknown> = {
    tools: { listChanged: false },
    ...(cfg.resources ? { resources: {} } : {}),
  };
  const ttlMs = cfg.ttlMs ?? 3_600_000;
  const cacheScope = cfg.cacheScope ?? 'public';
  const callOpts: CallToolOptions = {
    ...cfg.limits,
    ...(cfg.include === undefined ? {} : { include: cfg.include }),
    ...(cfg.maxDepth === undefined ? {} : { maxDepth: cfg.maxDepth }),
  };
  const ok = (id: RpcId, result: Record<string, unknown>): Outcome =>
    rpcResult(id, result, cfg.serverInfo);

  async function readResource(id: RpcId, uri: string): Promise<Outcome> {
    const provider = cfg.resources!;
    const manifest = await provider.list();
    const entry = manifest.find(r => r.uri === uri);
    const doc = entry ? await provider.read(uri) : null;
    if (!entry || !doc) {
      return rpcError(id, -32602, `Resource not found: ${uri}`, 200, { uri });
    }
    return ok(id, {
      resultType: 'complete',
      contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: doc.text }],
    });
  }

  async function dispatch(message: unknown, headers?: HeaderAdapter): Promise<Outcome> {
    if (Array.isArray(message)) {
      return rpcError(null, -32600, 'Batching is not supported: send a single request.', 400);
    }
    if (typeof message !== 'object' || message === null) {
      return rpcError(null, -32600, 'Invalid JSON-RPC request.', 400);
    }
    const msg = message as RpcMessage;
    if (typeof msg.method !== 'string') {
      return rpcError(null, -32600, 'Invalid JSON-RPC request.', 400);
    }
    const method = msg.method;
    const params = msg.params ?? {};

    // Notifications (no id): accept and discard. A stateless server has nothing to
    // track — this covers notifications/initialized and notifications/cancelled
    // alike. `id: null` is deliberately NOT a notification: it is answered with
    // `id: null`, which is what the hosted server has always done.
    if (!('id' in msg) || msg.id === undefined) return { kind: 'accepted' };
    const id = msg.id as RpcId;

    // Not a scalar id: echoing it back would emit a non-conforming envelope, so
    // treat the message as invalid instead.
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return rpcError(null, -32600, 'Invalid JSON-RPC request.', 400);
    }

    // ── Legacy era: the initialize handshake selects 2025-and-earlier semantics. ──
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      // A client asking for the CURRENT revision through `initialize` is answered
      // 2025-06-18: opening with a handshake is itself the legacy signal, and the
      // modern era is entered per-request via _meta. Pinned by a test so any change
      // here is deliberate.
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : '2025-06-18';
      // No `resultType` here, unlike every other result — era-correct, not an omission.
      return ok(id, {
        protocolVersion,
        capabilities,
        serverInfo: cfg.serverInfo,
        instructions: cfg.instructions,
      });
    }

    // ── Era detection: modern requests carry a per-request version in _meta. ──
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const metaVersion =
      typeof meta[META_VERSION] === 'string' ? (meta[META_VERSION] as string) : null;
    const headerVersion = headers ? headers.get('MCP-Protocol-Version') : null;

    if (metaVersion !== null || headerVersion === PROTOCOL_VERSION) {
      if (metaVersion === null) {
        return rpcError(id, -32602, `Missing required _meta field "${META_VERSION}".`, 400);
      }
      if (!SUPPORTED_VERSIONS.includes(metaVersion)) {
        return rpcError(id, -32022, 'Unsupported protocol version', 400, {
          supported: SUPPORTED_VERSIONS,
          requested: metaVersion,
        });
      }
      // Header mirroring is checked only where an envelope exists. On stdio these
      // -32020s are unreachable BY DESIGN, so a body the hosted server rejects for a
      // header mismatch is served here — that is the spec's rule, not a shortcut.
      if (headers) {
        const decode = headers.decode ?? identity;
        if (headerVersion === null) {
          return rpcError(id, -32020, 'Missing required MCP-Protocol-Version header.', 400);
        }
        if (headerVersion !== metaVersion) {
          return rpcError(
            id,
            -32020,
            `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match body value '${metaVersion}'.`,
            400,
          );
        }
        const headerMethod = headers.get('Mcp-Method');
        if (headerMethod === null) {
          return rpcError(id, -32020, 'Missing required Mcp-Method header.', 400);
        }
        if (decode(headerMethod) !== method) {
          return rpcError(
            id,
            -32020,
            `Header mismatch: Mcp-Method '${headerMethod}' does not match body method '${method}'.`,
            400,
          );
        }
        if (method === 'tools/call' || method === 'resources/read') {
          const bodyName = method === 'tools/call' ? params.name : params.uri;
          const headerName = headers.get('Mcp-Name');
          if (headerName === null) {
            return rpcError(id, -32020, 'Missing required Mcp-Name header.', 400);
          }
          if (typeof bodyName !== 'string' || decode(headerName) !== bodyName) {
            return rpcError(
              id,
              -32020,
              `Header mismatch: Mcp-Name '${headerName}' does not match body value '${String(bodyName)}'.`,
              400,
            );
          }
        }
      }
      // `server/discover` is exempt: it is the era PROBE, sent before the client has
      // agreed anything, and the spec says the probe must answer with a DiscoverResult
      // or a recognized modern error — anything else means "legacy, fall back to
      // initialize". Demanding clientCapabilities there mis-classifies a client that
      // is strict but incomplete. (The hosted server does not have this exemption yet;
      // it inherits it with the refactor. See CHANGELOG.)
      if (method !== 'server/discover' && meta[META_CAPS] === undefined) {
        return rpcError(id, -32602, `Missing required _meta field "${META_CAPS}".`, 400);
      }
    }
    // Requests with neither modern _meta nor the 2026 header are legacy-era
    // follow-ups (tools/list after initialize): same handlers, no modern validation.

    switch (method) {
      case 'ping':
        return ok(id, { resultType: 'complete' });

      case 'server/discover':
        return ok(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities,
          instructions: cfg.instructions,
          ttlMs,
          cacheScope,
        });

      case 'tools/list':
        return ok(id, { resultType: 'complete', tools: cfg.tools, ttlMs, cacheScope });

      case 'tools/call': {
        if (typeof params.name !== 'string') {
          return rpcError(id, -32602, 'tools/call requires a "name" parameter.');
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const outcome = callTool(params.name, args, callOpts);
        if (outcome.kind === 'unknown-tool') {
          return rpcError(id, -32602, `Unknown tool: ${outcome.name}`);
        }
        if (outcome.kind === 'error') {
          return ok(id, {
            resultType: 'complete',
            content: [{ type: 'text', text: outcome.message }],
            isError: true,
          });
        }
        return ok(id, {
          resultType: 'complete',
          content: [{ type: 'text', text: outcome.text }],
          structuredContent: outcome.structured,
          isError: false,
        });
      }

      case 'resources/list': {
        if (!cfg.resources) break;
        return ok(id, {
          resultType: 'complete',
          resources: await cfg.resources.list(),
          ttlMs,
          cacheScope,
        });
      }

      case 'resources/templates/list':
        if (!cfg.resources) break;
        return ok(id, { resultType: 'complete', resourceTemplates: [] });

      case 'resources/read': {
        if (!cfg.resources) break;
        if (typeof params.uri !== 'string') {
          return rpcError(id, -32602, 'resources/read requires a "uri" parameter.');
        }
        return readResource(id, params.uri);
      }
    }

    // 404 + -32601 lets a modern client distinguish "modern server, unknown method"
    // from a legacy HTTP+SSE 404 — do not soften this to a 200. A server with no
    // resource provider lands here for resources/*, which is the honest answer: it
    // does not advertise the capability, so it must not answer its methods either.
    return rpcError(id, -32601, `Method not found: ${method}`, 404);
  }

  return { capabilities, dispatch };
}
