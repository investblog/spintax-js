/**
 * The `--include-root` resolver: containment, and the report that reconstructs what
 * the engine hid.
 *
 * The plain cases run against the committed tree in `test/fixtures/include-root/`.
 * The rest — a BOM, an oversized file, a symlink and a junction — are built in a temp
 * directory, because their content or their creation is what is being tested.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, type IncludeReport, type IncludeSupport } from '../src/call-tool';
import { createIncludeRoot } from '../src/include-root';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'include-root');

function support(root = ROOT, maxIncludeBytes = 1024 * 1024, maxDepth = 20): IncludeSupport {
  const made = createIncludeRoot({ root, maxIncludeBytes, maxDepth });
  if (made.kind !== 'ok') throw new Error(made.message);
  made.support.begin();
  return made.support;
}

/** Render through the real tool path, then read the report it attached. */
function render(
  template: string,
  include: IncludeSupport,
  maxDepth = 20,
): { text: string; report: IncludeReport } {
  const out = callTool('render_spintax', { template, count: 1, seed: 1 }, {
    maxVariants: 10,
    include,
    maxDepth,
  });
  if (out.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(out)}`);
  return { text: (out.structured.variants as string[])[0]!, report: out.structured.include as IncludeReport };
}

describe('startup', () => {
  it('refuses a root that does not exist', () => {
    const made = createIncludeRoot({
      root: join(tmpdir(), 'spintax-mcp-nope-xyz'),
      maxIncludeBytes: 1024,
      maxDepth: 20,
    });
    expect(made.kind).toBe('fail');
  });

  it('refuses a root that is a file, not a directory', () => {
    const made = createIncludeRoot({
      root: join(ROOT, 'greeting.txt'),
      maxIncludeBytes: 1024,
      maxDepth: 20,
    });
    expect(made).toMatchObject({ kind: 'fail' });
    expect(made.kind === 'fail' && made.message).toContain('not a directory');
  });
});

describe('resolution', () => {
  it('reads a file in the root and reports it resolved', () => {
    const inc = support();
    const { text, report } = render('#include "greeting.txt"', inc);
    expect(text).toContain('greeting partial');
    expect(report.resolved).toEqual(['greeting.txt']);
    expect(report.missing).toEqual([]);
    expect(report.suppressed).toEqual([]);
    expect(report.root).toContain('include-root');
    expect(report.maxDepth).toBe(20);
  });

  it('reads a nested file through a forward-slash ref', () => {
    const { text } = render('#include "nested/deep.txt"', support());
    expect(text).toContain('Nested content');
  });

  it('reads a file ONCE per call, proven by deleting it after the first read', () => {
    // Counting resolver calls would prove nothing about the filesystem — the report
    // dedupes refs, so a cache-less resolver passes that test too. Removing the file
    // between two asks is the only assertion that fails without the cache.
    const dir = mkdtempSync(join(tmpdir(), 'spintax-mcp-once-'));
    try {
      writeFileSync(join(dir, 'p.txt'), 'partial');
      const inc = support(dir);
      expect(inc.resolver('p.txt')).toBe('partial');
      rmSync(join(dir, 'p.txt'));
      expect(inc.resolver('p.txt')).toBe('partial');
      // ...and the cache is per-call, so the next window really does hit the disk.
      inc.begin();
      expect(inc.resolver('p.txt')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an #include verbatim when there is no resolver at all', () => {
    const out = callTool('render_spintax', { template: '#include "greeting.txt"', count: 1, seed: 1 }, {
      maxVariants: 5,
    });
    expect(out.kind === 'ok' && out.structured.variants).toEqual(['#include "greeting.txt"']);
  });
});

describe('containment — a ref is untrusted template data', () => {
  it.each([
    ['a parent traversal', '../outside-secret.txt', 'denied-shape'],
    ['a deep traversal', 'nested/../../outside-secret.txt', 'denied-shape'],
    ['an absolute POSIX path', '/etc/passwd', 'denied-shape'],
    ['a Windows drive path', 'C:\\Windows\\win.ini', 'denied-shape'],
    ['a backslash traversal', '..\\outside-secret.txt', 'denied-shape'],
    ['a UNC path', '\\\\server\\share\\file', 'denied-shape'],
    ['a URL', 'https://example.test/x.txt', 'denied-shape'],
    ['a NUL byte', 'greeting.txt\u0000.png', 'denied-shape'],
    ['an empty ref', ' ', 'denied-shape'],
    ['a directory', 'nested', 'not-a-file'],
    ['a missing file', 'no-such-file.txt', 'not-found'],
  ])('refuses %s', (_label, ref, reason) => {
    const inc = support();
    expect(inc.resolver(ref)).toBeNull();
    const report = inc.report(`#include "${ref}"`);
    expect(report.resolved).toEqual([]);
    expect(report.missing).toEqual([{ ref, reason }]);
  });

  it('renders a refused include as empty, and says so in the text content', () => {
    const inc = support();
    const { text, report } = render('before\n#include "../outside-secret.txt"\nafter', inc);
    expect(text).not.toContain('outside the root');
    expect(report.missing).toEqual([{ ref: '../outside-secret.txt', reason: 'denied-shape' }]);
    const out = callTool('render_spintax', { template: '#include "../outside-secret.txt"', count: 1, seed: 1 }, {
      maxVariants: 5,
      include: inc,
    });
    expect(out.kind === 'ok' && out.text).toContain('not used: denied-shape');
  });

  it('never throws, whatever the ref is', () => {
    const inc = support();
    for (const ref of ['', '.', '..', '//', 'a/'.repeat(500), '\u0000', 'con', 'nested/']) {
      expect(() => inc.resolver(ref)).not.toThrow();
    }
  });
});

describe('escape by link', () => {
  let dir = '';
  let outside = '';
  let root = '';
  let madeSymlink = false;
  let madeJunction = false;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'spintax-mcp-link-'));
    outside = join(dir, 'outside');
    root = join(dir, 'root');
    mkdirSync(outside);
    mkdirSync(root);
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    writeFileSync(join(root, 'ok.txt'), 'fine');

    // A file symlink needs Developer Mode or admin on Windows, so probe for it.
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file');
      madeSymlink = true;
    } catch {
      madeSymlink = false;
    }
    // A junction is directory-only and needs no privilege on Windows — which is why
    // it is here and not merely a nicety: without it this whole suite would skip on
    // the machine it was written on.
    try {
      if (process.platform === 'win32') {
        symlinkSync(outside, join(root, 'jn'), 'junction');
      } else {
        symlinkSync(outside, join(root, 'jn'), 'dir');
      }
      madeJunction = true;
    } catch {
      madeJunction = false;
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('actually created at least one link — a silently skipped escape test is worse than none', () => {
    expect(madeSymlink || madeJunction).toBe(true);
  });

  it('refuses a file symlink that points outside the root', () => {
    if (!madeSymlink) return;
    const inc = support(root);
    expect(inc.resolver('link.txt')).toBeNull();
    expect(inc.report('#include "link.txt"').missing).toEqual([
      { ref: 'link.txt', reason: 'outside-root' },
    ]);
  });

  it('refuses a file reached through a directory link that points outside the root', () => {
    if (!madeJunction) return;
    const inc = support(root);
    expect(inc.resolver('jn/secret.txt')).toBeNull();
    expect(inc.report('#include "jn/secret.txt"').missing).toEqual([
      { ref: 'jn/secret.txt', reason: 'outside-root' },
    ]);
  });

  it('still reads an ordinary file in the same root', () => {
    expect(support(root).resolver('ok.txt')).toBe('fine');
  });

  it('accepts a root that is ITSELF a link, by resolving it first', () => {
    if (!madeJunction) return;
    // The root's own symlinks are resolved once at startup; without that, nothing
    // under a linked root would ever match the containment check.
    const linked = join(dir, 'root-link');
    try {
      symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    expect(support(linked).resolver('ok.txt')).toBe('fine');
  });
});

describe('file content and size', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'spintax-mcp-file-'));
    // Written here rather than committed: a BOM is invisible in review and easy for
    // an editor to strip.
    writeFileSync(join(dir, 'bom.txt'), '\uFEFFwith a byte-order mark');
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(4096));
    writeFileSync(join(dir, 'small.txt'), 'ok');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips a leading BOM, which would otherwise land mid-template', () => {
    expect(support(dir).resolver('bom.txt')).toBe('with a byte-order mark');
  });

  it('refuses a file over --max-include-bytes', () => {
    const inc = support(dir, 1024);
    expect(inc.resolver('big.txt')).toBeNull();
    expect(inc.report('#include "big.txt"').missing).toEqual([
      { ref: 'big.txt', reason: 'too-large' },
    ]);
    expect(inc.resolver('small.txt')).toBe('ok');
  });
});

describe('the report reconstructs what the engine hid', () => {
  it('names only the reference the engine actually cut, not everything in the cycle', () => {
    const inc = support();
    const { report } = render('#include "cycle-a.txt"', inc);
    // source → A → B → A: both files resolve, and the ONLY dropped reference is the
    // closing one back to A. Reporting B as well would be inventing work for the
    // reader — which the first implementation did, by classifying nodes (is this ref
    // part of a cycle?) instead of edges (which reference was refused?).
    expect(report.resolved).toEqual(['cycle-a.txt', 'cycle-b.txt']);
    expect(report.suppressed).toEqual([{ ref: 'cycle-a.txt', reason: 'cycle' }]);
  });

  it('classifies a self-include as a cycle', () => {
    const inc = support();
    const { report } = render('#include "self.txt"', inc);
    expect(report.suppressed).toEqual([{ ref: 'self.txt', reason: 'cycle' }]);
  });

  it('classifies an acyclic chain cut by maxDepth as depth-exceeded', () => {
    const inc = support(ROOT, 1024 * 1024, 3);
    const { report } = render('#include "chain-1.txt"', inc, 3);
    expect(report.resolved).toEqual(['chain-1.txt', 'chain-2.txt', 'chain-3.txt']);
    expect(report.suppressed).toEqual([{ ref: 'chain-4.txt', reason: 'depth-exceeded' }]);
    expect(report.maxDepth).toBe(3);
  });

  it('unions and dedupes across variants of one call', () => {
    const out = callTool(
      'render_spintax',
      { template: '{#include "greeting.txt"|#include "nested/deep.txt"}', count: 6, seed: 'x' },
      { maxVariants: 10, include: support() },
    );
    expect(out.kind).toBe('ok');
    const report = out.kind === 'ok' ? (out.structured.include as IncludeReport) : null;
    // A ref inside a spin choice is invisible to static analysis, so it can only ever
    // appear here by having been ASKED for — which is the honest half of the report.
    expect(report!.resolved.length).toBeGreaterThan(0);
    expect(new Set(report!.resolved).size).toBe(report!.resolved.length);
  });

  it('says so when the classification walk runs out of budget', () => {
    // Stacked diamonds: two files per level, each including BOTH files of the next.
    // 26 files, but 2^13 distinct paths through them — which is the shape that makes a
    // path-walk exponential. (Repeating the same ref inside one file would not do it:
    // `analyze().includes` dedupes per file, so that tree is linear.) The point is not
    // the number; it is that a short list announces itself instead of looking complete.
    const LEVELS = 13;
    const dir = mkdtempSync(join(tmpdir(), 'spintax-mcp-wide-'));
    try {
      for (let i = 1; i <= LEVELS; i++) {
        const children = `#include "a${i + 1}.txt"\n#include "b${i + 1}.txt"`;
        writeFileSync(join(dir, `a${i}.txt`), `A${i}\n${children}\n`);
        writeFileSync(join(dir, `b${i}.txt`), `B${i}\n${children}\n`);
      }
      writeFileSync(join(dir, `a${LEVELS + 1}.txt`), 'leaf a\n');
      writeFileSync(join(dir, `b${LEVELS + 1}.txt`), 'leaf b\n');
      const inc = support(dir);
      const { report } = render('#include "a1.txt"\n#include "b1.txt"', inc);
      expect(report.truncated).toBe(true);
      expect(report.resolved.length).toBe(2 * LEVELS + 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not truncated on an ordinary template', () => {
    const inc = support();
    expect(render('#include "greeting.txt"', inc).report.truncated).toBe(false);
    expect(render('#include "cycle-a.txt"', inc).report.truncated).toBe(false);
  });

  it('starts a fresh window per call, so a stale miss cannot leak into the next report', () => {
    const inc = support();
    render('#include "no-such-file.txt"', inc);
    const { report } = render('#include "greeting.txt"', inc);
    expect(report.missing).toEqual([]);
    expect(report.resolved).toEqual(['greeting.txt']);
  });
});

describe('validate_spintax with a root', () => {
  const template = '#include "greeting.txt"\n#include "no-such-file.txt"';

  it('turns an unresolvable #include into an error instead of a silent empty string', () => {
    const withRoot = callTool('validate_spintax', { template }, {
      maxVariants: 5,
      include: support(),
    });
    expect(withRoot.kind).toBe('ok');
    const structured = withRoot.kind === 'ok' ? structuredOf(withRoot) : null;
    expect(structured!.valid).toBe(false);
    expect(structured!.diagnostics.some(d => d.severity === 'error')).toBe(true);

    // Without a root there is no allow-list, so the engine files no verdict — the
    // hosted server's behaviour, unchanged.
    const without = callTool('validate_spintax', { template }, { maxVariants: 5 });
    expect(without.kind === 'ok' && structuredOf(without).valid).toBe(true);
  });

  it('stays silent when NOTHING resolves — engine contract, and the report covers it', () => {
    // `validator.ts` only files unknown-target verdicts for a NON-EMPTY allow-list,
    // so a template whose every include is broken validates clean. Corpus-gated
    // across five engines; not something to work around from a consumer. What the
    // agent gets instead is the render-time report.
    const out = callTool('validate_spintax', { template: '#include "no-such-file.txt"' }, {
      maxVariants: 5,
      include: support(),
    });
    expect(out.kind === 'ok' && structuredOf(out).valid).toBe(true);

    const inc = support();
    const { report } = render('#include "no-such-file.txt"', inc);
    expect(report.missing).toEqual([{ ref: 'no-such-file.txt', reason: 'not-found' }]);
  });

  it('accepts an #include that does resolve', () => {
    const out = callTool(
      'validate_spintax',
      { template: '#include "greeting.txt"' },
      { maxVariants: 5, include: support() },
    );
    expect(out.kind === 'ok' && structuredOf(out).valid).toBe(true);
  });
});

function structuredOf(out: { kind: 'ok'; structured: Record<string, unknown> }): {
  valid: boolean;
  diagnostics: { severity: string; code: string }[];
} {
  return out.structured as { valid: boolean; diagnostics: { severity: string; code: string }[] };
}

describe('the fixture tree is what these tests think it is', () => {
  it('has a file outside the root for the traversal cases to aim at', () => {
    // If this ever disappears, every traversal test above would pass for the wrong
    // reason (nothing to read rather than refusing to read it).
    const outside = join(ROOT, '..', 'outside-secret.txt');
    expect(() => execFileSync(process.execPath, ['-e', `require('node:fs').readFileSync(${JSON.stringify(outside)})`])).not.toThrow();
  });
});
