/**
 * JSON-RPC 2.0 plumbing and the MCP revision table — transport-free.
 *
 * Nothing here knows about HTTP or stdio. A handler returns an `Outcome`; the
 * transport decides what an Outcome looks like on the wire (a `Response` with a
 * status, or one newline-terminated line on stdout, or nothing at all).
 */

/** Current revision. Requests carrying `_meta.protocolVersion` are served in modern era. */
export const PROTOCOL_VERSION = '2026-07-28';

/** Legacy revisions we answer `initialize` for (newest first). */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, ...LEGACY_VERSIONS];

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER = 'io.modelcontextprotocol/serverInfo';

export type RpcId = string | number | null;

export interface RpcMessage {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: {
    _meta?: Record<string, unknown>;
    name?: string;
    uri?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
    [key: string]: unknown;
  };
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: RpcId; error: RpcErrorBody };

/** Server identity reported in `initialize` and mirrored into every result's `_meta`. */
export interface ServerIdentity {
  name: string;
  title: string;
  version: string;
}

/**
 * A handler's verdict.
 *
 * `httpStatus` is advice from the handler, not a property of JSON-RPC: HTTP uses
 * it verbatim, stdio ignores it. It travels with the outcome rather than living in
 * a code→status table because the mapping is genuinely not a function of the code —
 * `-32602` is 200 for a tool-argument mistake and 400 for modern-era `_meta`
 * validation, and both spellings are load-bearing on the hosted server.
 *
 * `accepted` is a notification: HTTP answers 202 with no body, stdio writes nothing.
 */
export type Outcome =
  | { kind: 'response'; body: RpcResponse; httpStatus: number }
  | { kind: 'accepted' };

export function rpcResult(
  id: RpcId,
  result: Record<string, unknown>,
  serverInfo: ServerIdentity,
): Outcome {
  return {
    kind: 'response',
    body: { jsonrpc: '2.0', id, result: { ...result, _meta: { [META_SERVER]: serverInfo } } },
    httpStatus: 200,
  };
}

/**
 * Unparseable payload. Lives here so every transport answers a bad payload with the
 * same body — the wording says "body" because there is one string, not two.
 */
export function rpcParseError(): Outcome {
  return rpcError(null, -32700, 'Parse error: body is not valid JSON.', 400);
}

/**
 * Note the asymmetry with `rpcResult`, which is deliberate and matches the hosted
 * server: an error body carries no `_meta`.
 */
export function rpcError(
  id: RpcId,
  code: number,
  message: string,
  status = 200,
  data?: Record<string, unknown>,
): Outcome {
  return {
    kind: 'response',
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } },
    httpStatus: status,
  };
}
