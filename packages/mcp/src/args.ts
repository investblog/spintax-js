/**
 * Command-line parsing, hand-rolled.
 *
 * NOT `node:util.parseArgs`: it is only stable from Node 20 and this repo's CI
 * matrix still covers 18. Zero dependencies is also the package's promise, and a
 * flag parser is not where to spend it.
 *
 * An unknown flag is an ERROR, not something to ignore: a client config with a
 * typo'd flag would otherwise start a server with silently different limits.
 */

import { DEFAULT_MAX_DEPTH } from '@spintax/core';
import { DEFAULT_MAX_LINE_CHARS } from './stdio';

export const DEFAULT_MAX_VARIANTS = 50;
export const DEFAULT_MAX_INCLUDE_BYTES = 1024 * 1024;

export interface ServerArgs {
  /** Absent ⇒ `#include` has no resolver and stays inert. */
  includeRoot?: string;
  maxVariants: number;
  maxDepth: number;
  maxIncludeBytes: number;
  /**
   * Framing safety valve — one JSON-RPC message may not be longer than this. It is a
   * flag rather than a constant because it is the ONE limit that can still refuse a
   * large template, which would otherwise contradict "no template size cap".
   */
  maxMessageChars: number;
}

export type ArgsOutcome =
  /** Start the server. */
  | { kind: 'run'; args: ServerArgs }
  /** Print to STDOUT and exit 0 — only ever before the server starts. */
  | { kind: 'print'; text: string }
  /** Print to STDERR and exit 2. Nothing goes to stdout. */
  | { kind: 'fail'; message: string };

export const HELP = `spintax-mcp — a local MCP server for spintax templates (stdio transport)

Usage:
  spintax-mcp [options]

It speaks MCP over stdin/stdout, so it is started by an MCP client rather than by
hand. A client config entry looks like:

  { "command": "npx", "args": ["-y", "@spintax/mcp"] }

Options:
  --include-root <dir>       Resolve #include against <dir>. Refs may not escape it.
                             Omitted: #include has no resolver and stays inert.
  --max-variants <n>         Cap for render_spintax count (default ${DEFAULT_MAX_VARIANTS}).
  --max-depth <n>            #include / nesting depth guard (default ${DEFAULT_MAX_DEPTH}).
  --max-include-bytes <n>    Refuse an #include file larger than this (default ${DEFAULT_MAX_INCLUDE_BYTES}).
  --max-message-chars <n>    Refuse a single JSON-RPC message longer than this
                             (default ${DEFAULT_MAX_LINE_CHARS}). Framing safety valve: past it, a
                             client has almost certainly lost the newline framing.
  --version                  Print the version and exit.
  --help                     Print this and exit.

Environment (used only when the matching flag is absent):
  SPINTAX_MCP_INCLUDE_ROOT, SPINTAX_MCP_MAX_VARIANTS, SPINTAX_MCP_MAX_DEPTH,
  SPINTAX_MCP_MAX_INCLUDE_BYTES, SPINTAX_MCP_MAX_MESSAGE_CHARS

There is no cap on the template itself: that one exists on the hosted server at
https://spintax.net/mcp because of its CPU budget, and running locally is how you get
rid of it. The one limit a big template can still meet is --max-message-chars, which
bounds the whole JSON-RPC line it arrives in; raise it if you mean to.`;

/**
 * Each numeric flag carries its own ceiling, and the ceilings are load-bearing rather
 * than decorative: `/^\d+$/` alone accepts a 400-digit string, which becomes
 * `Infinity` — and an infinite `--max-variants` serialises into the tool schema as
 * `"maximum": null` and turns a `count` of `1e999` into a render loop with no end.
 */
const NUMERIC = {
  '--max-variants': { key: 'maxVariants', max: 10_000 },
  '--max-depth': { key: 'maxDepth', max: 1_000 },
  '--max-include-bytes': { key: 'maxIncludeBytes', max: 1024 * 1024 * 1024 },
  '--max-message-chars': { key: 'maxMessageChars', max: 64 * 1024 * 1024 },
} as const;

type NumericFlag = keyof typeof NUMERIC;
type NumericKey = (typeof NUMERIC)[NumericFlag]['key'];

const ENV_KEYS = {
  includeRoot: 'SPINTAX_MCP_INCLUDE_ROOT',
  maxVariants: 'SPINTAX_MCP_MAX_VARIANTS',
  maxDepth: 'SPINTAX_MCP_MAX_DEPTH',
  maxIncludeBytes: 'SPINTAX_MCP_MAX_INCLUDE_BYTES',
  maxMessageChars: 'SPINTAX_MCP_MAX_MESSAGE_CHARS',
} as const;

function positiveInt(raw: string, label: string, max: number): number | string {
  const complaint = `${label} expects an integer between 1 and ${max}, got "${raw}".`;
  if (!/^\d+$/.test(raw)) return complaint;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) return complaint;
  return n;
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  version = '',
): ArgsOutcome {
  const numbers: Partial<Record<NumericKey, number>> = {};
  let includeRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') break;
    if (token === '--help' || token === '-h') return { kind: 'print', text: HELP };
    if (token === '--version' || token === '-v') return { kind: 'print', text: version };

    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    if (!flag.startsWith('--')) {
      return { kind: 'fail', message: `Unexpected argument "${token}". Try --help.` };
    }
    if (flag !== '--include-root' && !(flag in NUMERIC)) {
      return { kind: 'fail', message: `Unknown option "${flag}". Try --help.` };
    }

    let value = inlineValue;
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value === '') {
      return { kind: 'fail', message: `${flag} expects a value.` };
    }

    if (flag === '--include-root') {
      includeRoot = value;
      continue;
    }
    const spec = NUMERIC[flag as NumericFlag];
    const parsed = positiveInt(value, flag, spec.max);
    if (typeof parsed === 'string') return { kind: 'fail', message: parsed };
    numbers[spec.key] = parsed;
  }

  // Environment is a FALLBACK for flags, not an override — a client config that
  // spells a limit out on the command line wins over the shell it was started from.
  // Same validation either way: a bad value is a bad value wherever it came from.
  for (const flag of Object.keys(NUMERIC) as NumericFlag[]) {
    const spec = NUMERIC[flag];
    if (numbers[spec.key] !== undefined) continue;
    const raw = env[ENV_KEYS[spec.key]];
    if (raw === undefined || raw === '') continue;
    const parsed = positiveInt(raw, `${ENV_KEYS[spec.key]} (fallback for ${flag})`, spec.max);
    if (typeof parsed === 'string') return { kind: 'fail', message: parsed };
    numbers[spec.key] = parsed;
  }
  if (includeRoot === undefined) {
    const raw = env[ENV_KEYS.includeRoot];
    if (raw !== undefined && raw !== '') includeRoot = raw;
  }

  return {
    kind: 'run',
    args: {
      ...(includeRoot === undefined ? {} : { includeRoot }),
      maxVariants: numbers.maxVariants ?? DEFAULT_MAX_VARIANTS,
      maxDepth: numbers.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxMessageChars: numbers.maxMessageChars ?? DEFAULT_MAX_LINE_CHARS,
      maxIncludeBytes: numbers.maxIncludeBytes ?? DEFAULT_MAX_INCLUDE_BYTES,
    },
  };
}
