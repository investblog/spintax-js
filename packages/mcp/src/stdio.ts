/**
 * The stdio transport (MCP 2026-07-28 §Transports).
 *
 * Three rules from the spec drive every decision here:
 *   - "Messages are delimited by newlines, and MUST NOT contain embedded newlines."
 *     Our messages are JSON, so `JSON.stringify` guarantees the second half for free.
 *   - "The server MUST NOT write anything to its stdout that is not a valid MCP
 *     message." Hence: no `console.log` in this package at all, ever. Diagnostics go
 *     to stderr, which the spec leaves free-form.
 *   - "Servers SHOULD exit promptly when their standard input is closed … the primary
 *     graceful-shutdown signal and the only portable one." EOF, not a signal, is the
 *     real lifecycle. (Windows clients cannot deliver SIGTERM at all.)
 *
 * There is no header layer on stdio: request metadata travels inline in `_meta`.
 * That is why the dispatcher is called with no `HeaderAdapter` — see the comment on
 * the -32020 family in dispatch.ts.
 */

import { rpcError, rpcParseError, type Outcome, type RpcId } from './protocol';

/** 8 MiB with no newline in sight is a client that has lost the framing. */
export const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;

interface Writable {
  write(chunk: string): boolean;
  on?(event: 'error', listener: () => void): unknown;
}

interface Readable {
  // 'utf8' rather than `string`: Node types this as BufferEncoding, and the whole
  // point of the local type is to accept process.stdin without importing node:*.
  setEncoding?(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown;
}

export interface StdioIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export interface ServeStdioOptions {
  io?: StdioIo;
  maxLineChars?: number;
}

export interface StdioServer {
  /** Resolves with the process exit code once the loop is finished and drained. */
  readonly done: Promise<number>;
  /** Ask the loop to finish (a signal handler; EOF is the normal path). */
  stop(): void;
}

function scalarId(message: unknown): RpcId {
  if (typeof message !== 'object' || message === null) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Reads newline-delimited JSON-RPC from stdin and writes one line per response.
 *
 * Work goes through ONE fifo drained by one worker, so responses leave in the order
 * their requests arrived. This is not decoration: a synchronous write for a parse
 * error alongside an awaited write for a real request overtakes it, which is exactly
 * the bug the first version of this file had — a client saw the answer to line 2
 * before the answer to line 1.
 */
export function serveStdio(
  handle: (message: unknown) => Promise<Outcome>,
  options: ServeStdioOptions = {},
): StdioServer {
  // Annotated, not inferred: without the annotation `io` is a UNION of StdioIo and
  // the literal type of the default, and calling an overloaded method on a union
  // resolves to a nonsense signature set.
  const io: StdioIo = options.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  let buffer = '';
  /** True while discarding the remainder of an over-long line. */
  let resync = false;
  let finished = false;
  let draining = false;
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>(resolve => {
    resolveDone = resolve;
  });

  /** Either a line to answer, or a ready-made outcome the reader produced. */
  type Job = { line: string } | { outcome: Outcome };
  const fifo: Job[] = [];

  const write = (outcome: Outcome): void => {
    // A notification produces no line at all — the stdio equivalent of HTTP 202.
    if (outcome.kind === 'response') io.stdout.write(`${JSON.stringify(outcome.body)}\n`);
  };

  const answer = async (line: string): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(rpcParseError());
      return;
    }
    try {
      write(await handle(message));
    } catch (e) {
      // The dispatcher catches tool failures itself, so landing here means a bug in
      // this package. Answer rather than hang, and say why on stderr.
      io.stderr.write(`spintax-mcp: internal error — ${String(e)}\n`);
      write(rpcError(scalarId(message), -32603, 'Internal error.', 500));
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    for (let job = fifo.shift(); job !== undefined; job = fifo.shift()) {
      if ('outcome' in job) write(job.outcome);
      else await answer(job.line);
    }
    draining = false;
    if (finished) resolveDone(0);
  };

  const push = (job: Job): void => {
    fifo.push(job);
    void drain();
  };

  const tooLong = (): Outcome =>
    rpcError(null, -32600, `Message exceeds ${maxLineChars} characters.`, 400);

  const onLine = (raw: string): void => {
    // The cap applies to a COMPLETE line too, not only to an unterminated buffer:
    // checking the leftover alone lets a 9 MiB line through whenever its newline
    // happens to arrive in the same chunk, which is most of the time.
    if (raw.length > maxLineChars) {
      push({ outcome: tooLong() });
      return;
    }
    // One trailing CR, for a client that writes CRLF.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    push({ line });
  };

  io.stdin.setEncoding?.('utf8');

  io.stdin.on('data', (chunk: string) => {
    // Once shutting down, take no new work. Without this, a client that keeps writing
    // after SIGINT — or after stdout raised EPIPE — keeps the fifo non-empty, so the
    // drain loop never ends and `done` never resolves: the process hangs in the one
    // situation where it was asked to leave. Work already queued still gets answered.
    if (finished) return;
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (resync) {
        // That newline ended the over-long line; resume normal reading after it.
        resync = false;
        continue;
      }
      onLine(line);
    }
    if (resync) {
      buffer = '';
      return;
    }
    if (buffer.length > maxLineChars) {
      // Report once, then resync instead of desyncing every following message.
      push({ outcome: tooLong() });
      buffer = '';
      resync = true;
    }
  });

  const finish = (): void => {
    if (finished) return;
    finished = true;
    // Let the fifo finish, then report the exit code. Deliberately NOT
    // `process.exit()`: killing the process after a write loses the last response,
    // which is the classic bug of this transport.
    if (!draining) resolveDone(0);
  };

  io.stdin.on('end', finish);
  io.stdin.on('close', finish);
  // A dead client makes stdin/stdout raise EPIPE/ECONNRESET. Unhandled, Node throws
  // and the process exits non-zero, which clients report as a crash.
  io.stdin.on('error', finish);
  io.stdout.on?.('error', finish);
  io.stderr.on?.('error', () => {});

  return { done, stop: finish };
}
