import { describe, test, expect } from 'vitest';
import { parse, render, validate } from '../src/index';
import { decodeVerbatim, encodeVerbatim, projectSource } from '../src/internal/verbatim';

// `/! … !/` verbatim spans (#92, ADR 0001). The cross-engine rules are corpus fixtures (`verbatim/*`);
// what lives here is engine-local: the codec, the expansion budget, the position map, reuse.

describe('token codec', () => {
  test('round-trips any code point, astral and reserved ones included', () => {
    const content = 'aé中\u{1F600}\u{F0000}\u{10FFFF}\r\n';
    const token = encodeVerbatim(content);
    expect(decodeVerbatim(token)).toBe(content);
    expect([...token]).toHaveLength(2 + 2 * [...content].length);
  });

  test('decodes in one pass: a token inside a token comes back as a token', () => {
    const inner = encodeVerbatim('A');
    expect(decodeVerbatim(encodeVerbatim(inner))).toBe(inner);
  });

  test('leaves a malformed token alone', () => {
    const broken = String.fromCodePoint(0xf0000, 0xf1000, 0xf0001);
    expect(decodeVerbatim(broken)).toBe(broken);
  });
});

describe('expansion budget (rule 7a)', () => {
  test('charges a token as its content, not its encoded length', () => {
    // 3 × 300 000 characters fit the 1 MB budget; encoded (~4 units each) the second would not.
    const out = render(`#set %a% = /!${'x'.repeat(300_000)}!/\n%a%%a%%a%`, { postProcess: false });
    expect(out).toHaveLength(1 + 900_000);
    expect(out).not.toContain('%a%');
  });
});

describe('reuse and runtime values', () => {
  test('a parse() handle renders spans on every reuse', () => {
    const ast = parse('{x|y} /!{a|b}!/');
    for (const seed of [1, 2, 3]) expect(render(ast, { seed, postProcess: false })).toMatch(/^[xy] \{a\|b\}$/);
  });

  test('a context key named __proto__ stays an ordinary name when a value is stripped', () => {
    const context = JSON.parse('{"__proto__": "p", "v": "x"}') as Record<string, string>;
    context.v = `x${encodeVerbatim('q')}y`;
    expect(render('%__proto__% %v%', { context, postProcess: false })).toBe('p xy');
  });
});

describe('validator positions (rule 9)', () => {
  test('a diagnostic after a multi-line span points at the source line', () => {
    const [d] = validate('/!a\nb\nc!/\n{x');
    expect(d).toMatchObject({ code: 'bracket.unclosed', line: 4, column: 1 });
  });

  test('a diagnostic after a comment points at the source column', () => {
    const [d] = validate('/# note #/ {x');
    expect(d).toMatchObject({ code: 'bracket.unclosed', line: 1, column: 12 });
  });

  test('verbatim.unclosed points at the opener', () => {
    const d = validate('ok\n  /! rest').find((x) => x.code === 'verbatim.unclosed');
    expect(d).toMatchObject({ severity: 'warning', line: 2, column: 3, endLine: 2, endColumn: 5 });
  });

  test('moving many diagnostics stays linear', () => {
    for (const body of ['}'.repeat(100_000), '\u{1F600}}'.repeat(50_000)]) {
      const started = Date.now();
      const out = validate(`/#x#/${body}`);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(out.length).toBeGreaterThan(1000);
    }
    const [last] = validate('/#x#/\u{1F600}}').slice(-1);
    expect(last).toMatchObject({ code: 'bracket.unexpected-closing', line: 1, column: 7 });
  });

  test('a range ending before a removed comment does not stretch over it', () => {
    const [d] = validate('}/#x#/a');
    expect(d).toMatchObject({ code: 'bracket.unexpected-closing', line: 1, column: 1, endLine: 1, endColumn: 2 });
  });

  test('a diagnostic quotes the author text, never a token (rule 6)', () => {
    const d = validate('[<minsize=/!x!/>a|b]').find((x) => x.code === 'permutation.minsize-not-integer');
    expect(d?.data).toMatchObject({ value: 'x' });
    expect(d?.message).toContain('x');
    expect(JSON.stringify(d)).not.toMatch(/[\uDB80-\uDB87]/);
  });

  test('the projection maps offsets inside and after a token', () => {
    const p = projectSource('ab/!xy!/cd');
    const tokenStart = 2;
    expect(p.toSource(tokenStart)).toBe(2);
    expect(p.toSource(p.text.length - 2)).toBe(8);
    expect(p.toSource(p.text.length)).toBe(10);
  });
});
