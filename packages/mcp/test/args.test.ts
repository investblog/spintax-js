/**
 * Flag parsing. Two of these are here because a review found them: a numeric value
 * long enough to become `Infinity`, and an environment fallback that skipped the
 * validation the flag path applies.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_INCLUDE_BYTES, DEFAULT_MAX_VARIANTS, HELP, parseArgs } from '../src/args';
import { DEFAULT_MAX_LINE_CHARS } from '../src/stdio';

const run = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseArgs(argv, env, '9.9.9');

const args = (argv: string[], env: Record<string, string | undefined> = {}) => {
  const out = run(argv, env);
  if (out.kind !== 'run') throw new Error(`expected run, got ${JSON.stringify(out)}`);
  return out.args;
};

describe('defaults', () => {
  it('runs with no flags and no include root', () => {
    expect(args([])).toEqual({
      maxVariants: DEFAULT_MAX_VARIANTS,
      maxDepth: 20,
      maxIncludeBytes: DEFAULT_MAX_INCLUDE_BYTES,
      maxMessageChars: DEFAULT_MAX_LINE_CHARS,
    });
  });

  it('exposes the framing cap as a flag, because it is the one limit a big template meets', () => {
    expect(args(['--max-message-chars', '4096']).maxMessageChars).toBe(4096);
    expect(args([], { SPINTAX_MCP_MAX_MESSAGE_CHARS: '4096' }).maxMessageChars).toBe(4096);
  });

  it('takes --max-include-bytes at its own default, which is above the variant ceiling', () => {
    // The ceilings are per flag for a reason: one shared limit small enough for
    // `count` would reject the default byte size.
    expect(args(['--max-include-bytes', String(DEFAULT_MAX_INCLUDE_BYTES)]).maxIncludeBytes).toBe(
      DEFAULT_MAX_INCLUDE_BYTES,
    );
  });
});

describe('forms', () => {
  it('accepts --flag value and --flag=value alike', () => {
    expect(args(['--max-variants', '7']).maxVariants).toBe(7);
    expect(args(['--max-variants=7']).maxVariants).toBe(7);
    expect(args(['--include-root', 'C:\\partials']).includeRoot).toBe('C:\\partials');
    expect(args(['--include-root=/srv/partials']).includeRoot).toBe('/srv/partials');
  });

  it('prints help and version instead of running', () => {
    expect(run(['--help'])).toEqual({ kind: 'print', text: HELP });
    expect(run(['-h'])).toEqual({ kind: 'print', text: HELP });
    expect(run(['--version'])).toEqual({ kind: 'print', text: '9.9.9' });
  });

  it('stops reading flags at --', () => {
    expect(args(['--', '--max-variants', '7']).maxVariants).toBe(DEFAULT_MAX_VARIANTS);
  });
});

describe('refusals', () => {
  it.each([
    ['an unknown flag', ['--nope'], 'Unknown option "--nope"'],
    ['a positional argument', ['whatever'], 'Unexpected argument "whatever"'],
    ['a flag with no value', ['--max-variants'], '--max-variants expects a value'],
    ['an empty value', ['--max-variants='], '--max-variants expects a value'],
    ['a non-numeric value', ['--max-depth', 'deep'], 'expects an integer between 1 and 1000'],
    ['zero', ['--max-variants', '0'], 'expects an integer between 1 and 10000'],
    ['a value over the ceiling', ['--max-variants', '10001'], 'expects an integer between 1 and 10000'],
  ])('refuses %s', (_label, argv, message) => {
    const out = run(argv);
    expect(out.kind).toBe('fail');
    expect(out.kind === 'fail' && out.message).toContain(message);
  });

  it('refuses a value long enough to become Infinity', () => {
    // `/^\d+$/` accepts this; `Number()` turns it into Infinity, which serialises into
    // the tool schema as `"maximum": null` and makes `count: 1e999` a render loop with
    // no end. Found in review, not in the field.
    const huge = '9'.repeat(400);
    const out = run(['--max-variants', huge]);
    expect(out.kind).toBe('fail');
    expect(out.kind === 'fail' && out.message).toContain('expects an integer');
  });

  it('refuses a value above Number.MAX_SAFE_INTEGER', () => {
    expect(run(['--max-include-bytes', '9007199254740993']).kind).toBe('fail');
  });
});

describe('environment fallbacks', () => {
  it('fills in a limit the command line left out', () => {
    expect(args([], { SPINTAX_MCP_MAX_VARIANTS: '4' }).maxVariants).toBe(4);
    expect(args([], { SPINTAX_MCP_INCLUDE_ROOT: '/srv/p' }).includeRoot).toBe('/srv/p');
  });

  it('loses to an explicit flag', () => {
    expect(args(['--max-variants', '9'], { SPINTAX_MCP_MAX_VARIANTS: '4' }).maxVariants).toBe(9);
    expect(
      args(['--include-root', '/from/flag'], { SPINTAX_MCP_INCLUDE_ROOT: '/from/env' }).includeRoot,
    ).toBe('/from/flag');
  });

  it('is validated exactly like a flag — a bad value is a bad value wherever it came from', () => {
    const out = run([], { SPINTAX_MCP_MAX_VARIANTS: '9'.repeat(400) });
    expect(out.kind).toBe('fail');
    expect(out.kind === 'fail' && out.message).toContain('SPINTAX_MCP_MAX_VARIANTS');
  });

  it('ignores an empty variable rather than failing on it', () => {
    expect(args([], { SPINTAX_MCP_MAX_VARIANTS: '', SPINTAX_MCP_INCLUDE_ROOT: '' })).toEqual({
      maxVariants: DEFAULT_MAX_VARIANTS,
      maxDepth: 20,
      maxIncludeBytes: DEFAULT_MAX_INCLUDE_BYTES,
      maxMessageChars: DEFAULT_MAX_LINE_CHARS,
    });
  });
});
