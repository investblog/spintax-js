/**
 * The transport, tested by spawning the real executable.
 *
 * `spawn(process.execPath, [bin])` with NO `shell`: the repo's one
 * `shell: process.platform === 'win32'` precedent (scripts/check-cf-account.mjs)
 * exists because `npx` is `npx.cmd` on native Windows. Spawning `node` directly needs
 * no shell and therefore no quoting rules.
 *
 * The load-bearing assertion in this file is stdout PURITY — "the server MUST NOT
 * write anything to its stdout that is not a valid MCP message". It is invisible to
 * every other test, and one stray `console.log` away at all times.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SUPPORTED_VERSIONS } from '../src/protocol';
import { DEFAULT_MAX_VARIANTS } from '../src/args';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(pkgRoot, 'dist', 'bin.js');
const built = existsSync(BIN);
if (!built) {
  console.error(
    '[stdio-protocol.test] dist/bin.js is missing — the transport tests did NOT run. Run `npm run build -w @spintax/mcp` first.',
  );
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  /** Complete newline-terminated stdout lines, in arrival order. */
  lines: string[];
  /** Whatever is on stdout after the last newline — must be '' at exit. */
  partial: () => string;
  /** Everything written to stdout, newlines included. */
  text: () => string;
  stderr: () => string;
  send: (message: unknown) => void;
  raw: (text: string) => void;
  waitFor: (count: number) => Promise<string[]>;
  end: () => void;
  exit: () => Promise<number | null>;
}

const live: ChildProcessWithoutNullStreams[] = [];

function start(args: string[] = []): Session {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  live.push(child);
  const lines: string[] = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    lines,
    partial: () => buffer,
    text: () => lines.map(l => `${l}\n`).join('') + buffer,
    stderr: () => stderr,
    send: message => child.stdin.write(`${JSON.stringify(message)}\n`),
    raw: text => child.stdin.write(text),
    waitFor: async count => {
      const deadline = Date.now() + 10_000;
      while (lines.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} lines; got ${lines.length}: ${lines.join(' | ')}`);
        }
        await new Promise(r => setTimeout(r, 15));
      }
      return lines;
    },
    end: () => child.stdin.end(),
    exit: async () =>
      new Promise(resolve => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.on('exit', code => resolve(code));
      }),
  };
}

afterEach(() => {
  for (const child of live.splice(0)) child.kill();
});

const parsed = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

describe.skipIf(!built)('framing', () => {
  it('answers two requests with exactly two lines, in order', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 'a', method: 'ping' });
    s.send({ jsonrpc: '2.0', id: 'b', method: 'tools/list' });
    const lines = await s.waitFor(2);
    expect(lines.map(l => parsed(l).id)).toEqual(['a', 'b']);
    s.end();
    expect(await s.exit()).toBe(0);
    expect(s.lines).toHaveLength(2);
    expect(s.partial()).toBe('');
  });

  it('puts a multi-line render on ONE stdout line', async () => {
    const s = start();
    s.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'render_spintax',
        arguments: { template: 'first\nsecond\nthird', count: 2, seed: 1 },
      },
    });
    const [line] = await s.waitFor(1);
    expect(line).not.toContain('\n');
    const result = parsed(line!).result as { structuredContent: { variants: string[] } };
    expect(result.structuredContent.variants[0]).toContain('\n');
  });

  it('writes nothing but protocol JSON to stdout, and nothing at all to stderr', async () => {
    const s = start();
    for (const method of ['ping', 'tools/list', 'server/discover']) {
      s.send({ jsonrpc: '2.0', id: method, method });
    }
    await s.waitFor(3);
    s.end();
    await s.exit();
    expect(s.stderr()).toBe('');
    for (const line of s.lines) {
      expect(parsed(line).jsonrpc).toBe('2.0');
    }
  });

  it('tolerates CRLF, blank lines and a request split across writes', async () => {
    const s = start();
    s.raw('\r\n   \r\n');
    s.raw('{"jsonrpc":"2.0","id":1,"me');
    s.raw('thod":"ping"}\r\n');
    const lines = await s.waitFor(1);
    expect(parsed(lines[0]!).id).toBe(1);
    expect(s.lines).toHaveLength(1);
  });

  it('reports a bad line and keeps answering the next one — no desync', async () => {
    const s = start();
    s.raw('this is not json\n');
    s.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const lines = await s.waitFor(2);
    expect(parsed(lines[0]!)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: body is not valid JSON.' },
    });
    expect(parsed(lines[1]!).id).toBe(7);
  });

  it('keeps responses in request order even when a parse error sits between them', async () => {
    // The first version wrote parse errors synchronously and real answers through a
    // queue, so line 2's answer overtook line 1's. Hence one fifo for both.
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    s.raw('nope\n');
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const lines = await s.waitFor(3);
    expect(lines.map(l => parsed(l).id)).toEqual([1, null, 2]);
  });

  it('writes no line at all for a notification', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    s.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const lines = await s.waitFor(1);
    expect(lines).toHaveLength(1);
    expect(parsed(lines[0]!).id).toBe(1);
  });
});

describe.skipIf(!built)('what a client actually calls', () => {
  it('answers server/discover, initialize and tools/list', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    s.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const lines = await s.waitFor(3);
    const [discover, init, list] = lines.map(l => parsed(l).result as Record<string, unknown>);
    expect(discover!.supportedVersions).toEqual(SUPPORTED_VERSIONS);
    expect(init!.protocolVersion).toBe('2025-06-18');
    expect((init!.capabilities as Record<string, unknown>).resources).toBeUndefined();
    expect((list!.tools as { name: string }[]).map(t => t.name)).toEqual([
      'validate_spintax',
      'render_spintax',
      'analyze_spintax',
    ]);
  });

  it('serves a modern-era request with no headers in sight', async () => {
    const s = start();
    s.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    const lines = await s.waitFor(1);
    expect((parsed(lines[0]!).result as { resultType: string }).resultType).toBe('complete');
  });

  it('caps count at --max-variants, and reports that cap in the schema', async () => {
    const s = start(['--max-variants', '2']);
    s.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    s.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'render_spintax', arguments: { template: 'x', count: 99, seed: 1 } },
    });
    const lines = await s.waitFor(2);
    const tools = (parsed(lines[0]!).result as { tools: ToolShape[] }).tools;
    expect(tools[1]!.inputSchema.properties.count!.maximum).toBe(2);
    const variants = (
      parsed(lines[1]!).result as { structuredContent: { variants: string[] } }
    ).structuredContent.variants;
    expect(variants).toHaveLength(2);
  });

  it('has no template cap at all — the reason to run it locally', async () => {
    const s = start();
    s.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'render_spintax', arguments: { template: 'x'.repeat(20_000), count: 1, seed: 1 } },
    });
    const lines = await s.waitFor(1);
    const result = parsed(lines[0]!).result as {
      isError: boolean;
      structuredContent: { variants: string[] };
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.variants[0]!.length).toBe(20_000);
  });
});

interface ToolShape {
  name: string;
  inputSchema: { properties: Record<string, Record<string, unknown> | undefined> };
}

describe.skipIf(!built)('oversized input', () => {
  it('refuses a COMPLETE line over the cap, not only an unterminated one', async () => {
    // The first version only measured the leftover buffer, so an over-limit line whose
    // newline arrived in the same chunk was parsed and executed — which is most of the
    // time. The cap has to apply to the extracted line too.
    const s = start();
    s.raw(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${'y'.repeat(9 * 1024 * 1024)}"}}\n`);
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const lines = await s.waitFor(2);
    expect(parsed(lines[0]!)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(parsed(lines[1]!).id).toBe(2);
  });

  it('honours --max-message-chars, so the framing cap is reachable from a client config', async () => {
    const s = start(['--max-message-chars', '200']);
    s.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(400) } });
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const lines = await s.waitFor(2);
    expect(parsed(lines[0]!)).toMatchObject({ id: null, error: { code: -32600 } });
    expect((parsed(lines[0]!).error as { message: string }).message).toContain('200 characters');
    expect(parsed(lines[1]!).id).toBe(2);
  });

  it('reports once and resyncs on the next newline instead of desyncing', async () => {
    const s = start();
    // A 9 MiB line with no newline: over the transport's 8 MiB default. There is no
    // flag for it on purpose — a client that needs a bigger single message is a client
    // that has lost the framing.
    s.raw(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${'y'.repeat(9 * 1024 * 1024)}`);
    const first = await s.waitFor(1);
    expect(parsed(first[0]!)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(String((parsed(first[0]!).error as { message: string }).message)).toContain('exceeds');
    // The rest of the oversized line, then a good one.
    s.raw('"}}\n');
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const lines = await s.waitFor(2);
    expect(parsed(lines[1]!).id).toBe(2);
  });
});

describe.skipIf(!built)('lifecycle and flags', () => {
  it('exits 0 on stdin EOF, having answered everything queued', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    s.end();
    expect(await s.exit()).toBe(0);
    expect(s.lines).toHaveLength(1);
  });

  it('exits 0 on EOF with nothing sent at all', async () => {
    const s = start();
    s.end();
    expect(await s.exit()).toBe(0);
    expect(s.lines).toEqual([]);
  });

  it('prints --help to stdout and exits 0, mentioning the client config', async () => {
    const s = start(['--help']);
    expect(await s.exit()).toBe(0);
    expect(s.text()).toContain('spintax-mcp');
    expect(s.text()).toContain('--include-root');
    expect(s.text()).toContain('npx');
    expect(s.stderr()).toBe('');
  });

  it('prints --version to stdout and exits 0', async () => {
    const s = start(['--version']);
    expect(await s.exit()).toBe(0);
    expect(s.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('refuses an unknown flag: exit 2, stderr, and NOTHING on stdout', async () => {
    const s = start(['--nope']);
    expect(await s.exit()).toBe(2);
    expect(s.stderr()).toContain('Unknown option "--nope"');
    expect(s.text()).toBe('');
  });

  it('refuses a bad numeric value and an unusable include root, with nothing on stdout', async () => {
    const bad = start(['--max-variants', 'lots']);
    expect(await bad.exit()).toBe(2);
    expect(bad.stderr()).toContain('expects an integer');
    expect(bad.text()).toBe('');

    const missing = start(['--include-root', join(tmpdir(), 'spintax-mcp-does-not-exist-xyz')]);
    expect(await missing.exit()).toBe(2);
    expect(missing.stderr()).toContain('--include-root');
    expect(missing.text()).toBe('');
  });

  it('reads limits from the environment when the flag is absent', async () => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SPINTAX_MCP_MAX_VARIANTS: '4' },
    });
    live.push(child);
    child.stdout.setEncoding('utf8');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    const line = await new Promise<string>((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (c: string) => {
        buf += c;
        const nl = buf.indexOf('\n');
        if (nl !== -1) resolve(buf.slice(0, nl));
      });
      setTimeout(() => reject(new Error('timed out')), 10_000);
    });
    child.stdin.end();
    const tools = (parsed(line).result as { tools: ToolShape[] }).tools;
    expect(tools[1]!.inputSchema.properties.count!.maximum).toBe(4);
    expect(DEFAULT_MAX_VARIANTS).not.toBe(4);
  });
});
