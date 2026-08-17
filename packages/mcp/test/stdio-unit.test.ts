/**
 * The transport driven through an injected fake stream.
 *
 * `stdio-protocol.test.ts` spawns the real binary, which is the honest end-to-end
 * check — but it cannot control CHUNKING: a 9 MiB write arrives in many small pipe
 * reads, so its over-long-line test would also pass against a version that only
 * measured the leftover buffer. Here one `data` event carries one complete over-limit
 * line, which is the only way to test that branch for real.
 */

import { describe, expect, it, vi } from 'vitest';
import { serveStdio, type StdioIo } from '../src/stdio';
import { rpcError, rpcResult, type Outcome } from '../src/protocol';

const SERVER = { name: 't', title: 'T', version: '0' };

interface Harness {
  io: StdioIo;
  emit: (event: 'data', chunk: string) => void;
  close: (event: 'end' | 'close' | 'error') => void;
  out: () => string[];
  err: () => string;
}

function harness(): Harness {
  const listeners = new Map<string, ((arg?: unknown) => void)[]>();
  let stdout = '';
  let stderr = '';
  const io: StdioIo = {
    stdin: {
      setEncoding: () => undefined,
      on: (event: string, listener: (...args: never[]) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(listener as (arg?: unknown) => void);
        listeners.set(event, list);
        return undefined;
      },
    } as unknown as StdioIo['stdin'],
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
  };
  return {
    io,
    emit: (event, chunk) => {
      for (const l of listeners.get(event) ?? []) l(chunk);
    },
    close: event => {
      for (const l of listeners.get(event) ?? []) l();
    },
    out: () => stdout.split('\n').filter(line => line !== ''),
    err: () => stderr,
  };
}

const ping = (id: number | string): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`;

/** Answers every message, after `delay` microtasks — enough to reorder a naive queue. */
const echo =
  (delay = 0) =>
  async (message: unknown): Promise<Outcome> => {
    for (let i = 0; i < delay; i++) await Promise.resolve();
    const id = (message as { id?: string | number }).id ?? null;
    return rpcResult(id, { ok: true }, SERVER);
  };

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

describe('the line-length cap', () => {
  it('refuses a COMPLETE over-limit line delivered in ONE chunk', async () => {
    const h = harness();
    const handle = vi.fn(echo());
    serveStdio(handle, { io: h.io, maxLineChars: 100 });
    h.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(200) })}\n`);
    await settle();
    expect(handle).not.toHaveBeenCalled();
    expect(h.out()).toHaveLength(1);
    expect(JSON.parse(h.out()[0]!)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Message exceeds 100 characters.' },
    });
  });

  it('refuses an over-limit line that arrives with no newline, then resyncs', async () => {
    const h = harness();
    serveStdio(echo(), { io: h.io, maxLineChars: 50 });
    h.emit('data', 'x'.repeat(60));
    await settle();
    expect(h.out()).toHaveLength(1);
    // The tail of the bad line is discarded up to its newline; the next line answers.
    h.emit('data', `still the bad line\n${ping(7)}`);
    await settle();
    expect(h.out()).toHaveLength(2);
    expect(JSON.parse(h.out()[1]!).id).toBe(7);
  });

  it('draws the boundary on the line WITHOUT its newline', async () => {
    // The cap measures the line, and the line is what precedes the '\n'. Passing
    // `line.length` (newline included) as the limit tests one character below the
    // boundary and would miss an accidental `>=`, so pin both sides of it.
    const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

    const atLimit = harness();
    serveStdio(echo(), { io: atLimit.io, maxLineChars: json.length });
    atLimit.emit('data', `${json}\n`);
    await settle();
    expect(JSON.parse(atLimit.out()[0]!).id).toBe(1);

    const overLimit = harness();
    serveStdio(echo(), { io: overLimit.io, maxLineChars: json.length - 1 });
    overLimit.emit('data', `${json}\n`);
    await settle();
    expect(JSON.parse(overLimit.out()[0]!).error.code).toBe(-32600);
  });
});

describe('ordering', () => {
  it('answers in request order even when the handler resolves out of order', async () => {
    const h = harness();
    let call = 0;
    // First call takes many microtasks, second none: a queue that did not serialise
    // would emit the second answer first.
    const handle = async (message: unknown): Promise<Outcome> => {
      const slow = call++ === 0;
      for (let i = 0; i < (slow ? 20 : 0); i++) await Promise.resolve();
      return rpcResult((message as { id: number }).id, { ok: true }, SERVER);
    };
    serveStdio(handle, { io: h.io });
    h.emit('data', ping(1) + ping(2));
    await settle();
    expect(h.out().map(l => JSON.parse(l).id)).toEqual([1, 2]);
  });

  it('keeps a parse error in place between two good lines', async () => {
    const h = harness();
    serveStdio(echo(3), { io: h.io });
    h.emit('data', `${ping(1)}nonsense\n${ping(2)}`);
    await settle();
    expect(h.out().map(l => JSON.parse(l).id)).toEqual([1, null, 2]);
    expect(JSON.parse(h.out()[1]!).error.code).toBe(-32700);
  });
});

describe('lifecycle', () => {
  it('resolves 0 on end, after the queue has drained', async () => {
    const h = harness();
    const server = serveStdio(echo(5), { io: h.io });
    h.emit('data', ping(1));
    h.close('end');
    expect(await server.done).toBe(0);
    expect(h.out()).toHaveLength(1);
  });

  it('resolves 0 on a stream error, which is a dead client and not a crash', async () => {
    const h = harness();
    const server = serveStdio(echo(), { io: h.io });
    h.close('error');
    expect(await server.done).toBe(0);
  });

  it('resolves 0 when stop() is called, and only once', async () => {
    const h = harness();
    const server = serveStdio(echo(), { io: h.io });
    server.stop();
    server.stop();
    expect(await server.done).toBe(0);
  });

  it('stops taking new work after stop(), so a chatty client cannot hold it open', async () => {
    // The failure this prevents: stop() arrives mid-drain, the client keeps writing,
    // the fifo never empties, and the process hangs in the one situation where it was
    // asked to leave. Already-queued work is still answered.
    const h = harness();
    const handle = vi.fn(echo(5));
    const server = serveStdio(handle, { io: h.io });
    h.emit('data', ping(1));
    server.stop();
    for (let i = 2; i <= 20; i++) h.emit('data', ping(i));
    expect(await server.done).toBe(0);
    await settle();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(h.out().map(l => JSON.parse(l).id)).toEqual([1]);
  });

  it('writes nothing for a notification', async () => {
    const h = harness();
    serveStdio(async () => ({ kind: 'accepted' }) as Outcome, { io: h.io });
    h.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await settle();
    expect(h.out()).toEqual([]);
  });

  it('skips blank and whitespace-only lines without answering them', async () => {
    const h = harness();
    const handle = vi.fn(echo());
    serveStdio(handle, { io: h.io });
    h.emit('data', '\n   \n\r\n');
    await settle();
    expect(handle).not.toHaveBeenCalled();
    expect(h.out()).toEqual([]);
  });
});

describe('a handler that throws', () => {
  it('answers -32603 with the request id and explains itself on stderr', async () => {
    const h = harness();
    serveStdio(async () => {
      throw new Error('boom');
    }, { io: h.io });
    h.emit('data', ping(42));
    await settle();
    const body = JSON.parse(h.out()[0]!);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32603, message: 'Internal error.' },
    });
    expect(h.err()).toContain('internal error');
  });

  it('keeps serving the next line', async () => {
    const h = harness();
    let first = true;
    serveStdio(async message => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return rpcError((message as { id: number }).id, -32601, 'nope', 404);
    }, { io: h.io });
    h.emit('data', ping(1) + ping(2));
    await settle();
    expect(h.out().map(l => JSON.parse(l).error.code)).toEqual([-32603, -32601]);
  });
});
