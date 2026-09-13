import { describe, test, expect } from 'vitest';
import { parseTemplate, splitTopLevel, stripComments } from '../src/internal/parser';
import { AST_VERSION, type Node } from '../src/internal/ast';

function nodes(src: string): Node[] {
  return parseTemplate(src).nodes as Node[];
}

const lit = (value: string): Node => ({ type: 'literal', value });
const v = (name: string): Node => ({ type: 'variable', name });
const DEF_CFG = { minsize: null, maxsize: null, sep: ' ', lastsep: null };
const opt = (
  n: Node[],
  separator: string | null = null,
): { nodes: Node[]; separator: string | null } => ({ nodes: n, separator });

describe('parseTemplate — core constructs', () => {
  test('literal only', () => {
    expect(parseTemplate('hello').astVersion).toBe(AST_VERSION);
    expect(nodes('hello')).toEqual([lit('hello')]);
  });

  test('variable reference', () => {
    expect(nodes('hi %name%')).toEqual([lit('hi '), v('name')]);
  });

  test('variable name may start with a digit (\\w+)', () => {
    expect(nodes('%1x%')).toEqual([v('1x')]);
  });

  test('bare percent stays literal', () => {
    expect(nodes('50% off')).toEqual([lit('50% off')]);
  });

  test('enumeration', () => {
    expect(nodes('{a|b|c}')).toEqual([
      { type: 'enumeration', options: [[lit('a')], [lit('b')], [lit('c')]] },
    ]);
  });

  test('nested enumeration', () => {
    expect(nodes('{a|{b|c}}')).toEqual([
      {
        type: 'enumeration',
        options: [[lit('a')], [{ type: 'enumeration', options: [[lit('b')], [lit('c')]] }]],
      },
    ]);
  });

  test('empty option', () => {
    expect(nodes('{|a}')).toEqual([{ type: 'enumeration', options: [[], [lit('a')]] }]);
  });

  test('permutation (default config)', () => {
    expect(nodes('[a|b]')).toEqual([
      { type: 'permutation', config: DEF_CFG, options: [opt([lit('a')]), opt([lit('b')])] },
    ]);
  });

  test('mixed nesting: permutation inside enumeration', () => {
    expect(nodes('{a|[b|c]}')).toEqual([
      {
        type: 'enumeration',
        options: [
          [lit('a')],
          [{ type: 'permutation', config: DEF_CFG, options: [opt([lit('b')]), opt([lit('c')])] }],
        ],
      },
    ]);
  });
});

describe('parseTemplate — permutation config & separators', () => {
  test('full config: minsize/maxsize/sep/lastsep', () => {
    expect(nodes('[<minsize=2;maxsize=3;sep=", ";lastsep=" and "> a|b|c]')).toEqual([
      {
        type: 'permutation',
        config: { minsize: 2, maxsize: 3, sep: ', ', lastsep: ' and ' },
        options: [opt([lit('a')]), opt([lit('b')]), opt([lit('c')])],
      },
    ]);
  });

  test('config is extracted BEFORE the split — a pipe in a quoted sep is not a separator', () => {
    expect(nodes('[<sep="|">a|b]')).toEqual([
      {
        type: 'permutation',
        config: { minsize: null, maxsize: null, sep: '|', lastsep: null },
        options: [opt([lit('a')]), opt([lit('b')])],
      },
    ]);
  });

  test('single-separator form: the whole config string is sep (and lastsep)', () => {
    expect(nodes('[<+>a|b]')).toEqual([
      {
        type: 'permutation',
        config: { minsize: null, maxsize: null, sep: '+', lastsep: '+' },
        options: [opt([lit('a')]), opt([lit('b')])],
      },
    ]);
  });

  test('leading <li>…</li> is HTML, not config', () => {
    expect(nodes('[<li>a</li>|b]')).toEqual([
      {
        type: 'permutation',
        config: DEF_CFG,
        options: [opt([lit('<li>a</li>')]), opt([lit('b')])],
      },
    ]);
  });

  test('per-element separator: a trailing < sep > travels to the next element', () => {
    expect(nodes('[a < and > | b]')).toEqual([
      {
        type: 'permutation',
        config: DEF_CFG,
        options: [opt([lit('a')], null), opt([lit('b')], ' and ')],
      },
    ]);
  });

  test('a trailing < sep > on the LAST part is NOT extracted (stays literal)', () => {
    expect(nodes('[a|b< , >]')).toEqual([
      {
        type: 'permutation',
        config: DEF_CFG,
        options: [opt([lit('a')]), opt([lit('b< , >')])],
      },
    ]);
  });

  test('minsize-only config (sep stays default)', () => {
    expect(nodes('[<minsize=2>a|b|c]')).toEqual([
      {
        type: 'permutation',
        config: { minsize: 2, maxsize: null, sep: ' ', lastsep: null },
        options: [opt([lit('a')]), opt([lit('b')]), opt([lit('c')])],
      },
    ]);
  });

  test('empty and config-only permutations yield no options', () => {
    expect(nodes('[]')).toEqual([{ type: 'permutation', config: DEF_CFG, options: [] }]);
    expect(nodes('[<sep=",">]')).toEqual([
      { type: 'permutation', config: { minsize: null, maxsize: null, sep: ',', lastsep: null }, options: [] },
    ]);
  });

  test('nested permutation is a nested node', () => {
    expect(nodes('[a|[b|c]]')).toEqual([
      {
        type: 'permutation',
        config: DEF_CFG,
        options: [
          opt([lit('a')]),
          opt([{ type: 'permutation', config: DEF_CFG, options: [opt([lit('b')]), opt([lit('c')])] }]),
        ],
      },
    ]);
  });
});

describe('parseTemplate — conditionals', () => {
  test('then|else', () => {
    expect(nodes('{?flag?yes|no}')).toEqual([
      { type: 'conditional', name: 'flag', inverted: false, then: [lit('yes')], else: [lit('no')] },
    ]);
  });

  test('inverted, then-only (empty else)', () => {
    expect(nodes('{?!flag?yes}')).toEqual([
      { type: 'conditional', name: 'flag', inverted: true, then: [lit('yes')], else: [] },
    ]);
  });

  test('branch split ignores pipes nested in the then-branch', () => {
    expect(nodes('{?a?{x|y}|z}')).toEqual([
      {
        type: 'conditional',
        name: 'a',
        inverted: false,
        then: [{ type: 'enumeration', options: [[lit('x')], [lit('y')]] }],
        else: [lit('z')],
      },
    ]);
  });

  test('malformed conditional (name starts with digit) falls back to enumeration', () => {
    expect(nodes('{?1bad?x}')).toEqual([
      { type: 'enumeration', options: [[lit('?1bad?x')]] },
    ]);
  });
});

describe('parseTemplate — plurals', () => {
  test('count + raw forms are kept as strings (renderer expands vars, then splits/trims)', () => {
    expect(nodes('{plural 2: one|two}')).toEqual([{ type: 'plural', countRaw: '2', formsRaw: ' one|two' }]);
  });

  test('count may be a %var%', () => {
    expect(nodes('{plural %n%: a|b}')).toEqual([{ type: 'plural', countRaw: '%n%', formsRaw: ' a|b' }]);
  });

  test('no colon ⇒ not a plural, treated as enumeration', () => {
    expect(nodes('{plural noun}')).toEqual([
      { type: 'enumeration', options: [[lit('plural noun')]] },
    ]);
  });
});

describe('parseTemplate — #set global extraction / #include literal', () => {
  test('#set is extracted globally (not a node), stripping its line', () => {
    const ast = parseTemplate('#set %greeting% = Hello');
    expect(ast.setDefs).toEqual({ greeting: 'Hello' });
    expect(ast.nodes).toEqual([]);
  });

  test('#set name is lower-cased; value is raw', () => {
    expect(parseTemplate('#set %Brand% = Acme').setDefs).toEqual({ brand: 'Acme' });
  });

  test('#set line stripped; a following reference remains', () => {
    const ast = parseTemplate('#set %g% = hi\n%g%');
    expect(ast.setDefs).toEqual({ g: 'hi' });
    expect(ast.nodes).toEqual([lit('\n'), v('g')]);
  });

  test('#set on its OWN line inside a group is still globally extracted (the blocking case)', () => {
    const ast = parseTemplate('{\n#set %x% = A\n|%x%}');
    expect(ast.setDefs).toEqual({ x: 'A' });
    // `raw` is here because an option holds a direct reference — the render-time splice
    // re-reads this body (the stripped directive line included, as `\n\n`).
    expect(ast.nodes).toEqual([
      { type: 'enumeration', options: [[lit('\n\n')], [v('x')]], raw: '\n\n|%x%' },
    ]);
  });

  test('mid-line #set is NOT a directive (needs its own line) — stays enum text', () => {
    const ast = parseTemplate('{a|#set %x% = b}');
    expect(ast.setDefs).toEqual({});
    expect(ast.nodes).toEqual([
      {
        type: 'enumeration',
        options: [[lit('a')], [lit('#set '), v('x'), lit(' = b')]],
        raw: 'a|#set %x% = b',
      },
    ]);
  });

  test('malformed #set (no =) is not extracted — stays literal', () => {
    const ast = parseTemplate('#set %v% hello');
    expect(ast.setDefs).toEqual({});
    expect(ast.nodes).toEqual([lit('#set '), v('v'), lit(' hello')]);
  });

  test('#include stays literal (renderer resolves it as a post-tree pass)', () => {
    expect(nodes('#include "hero"')).toEqual([lit('#include "hero"')]);
  });

  test('CRLF: #set with a trailing \\r extracts cleanly', () => {
    const ast = parseTemplate('#set %g% = hi\r\n%g%');
    expect(ast.setDefs).toEqual({ g: 'hi' });
    expect(ast.nodes).toEqual([lit('\n'), v('g')]);
  });
});

describe('parseTemplate — which constructs keep `raw` for the textual re-read (#78, #80)', () => {
  const rawOf = (src: string): string | undefined => (nodes(src)[0] as { raw?: string }).raw;

  test('a reference anywhere in the <config> marks a permutation — size, unquoted or quoted separator', () => {
    expect(rawOf('[<minsize=%n%;maxsize=%n%>a|b|c]')).toBe('<minsize=%n%;maxsize=%n%>a|b|c');
    expect(rawOf('[<sep=%S%>a|b]')).toBe('<sep=%S%>a|b');
    expect(rawOf('[<sep="%S%">a|b]')).toBe('<sep="%S%">a|b');
    expect(rawOf('[<%S%>a|b]')).toBe('<%S%>a|b');
    expect(rawOf('[a <%S%>|b]')).toBe('a <%S%>|b');
  });

  test('a conditional in an option marks the construct, whatever its branches hold', () => {
    expect(rawOf('[{?f?a|b|x}|c]')).toBe('{?f?a|b|x}|c');
    expect(rawOf('[{?f?live}|slots|poker]')).toBe('{?f?live}|slots|poker');
    expect(rawOf('{c|{?f?a|b|x}}')).toBe('c|{?f?a|b|x}');
  });

  test('nothing to re-read keeps a construct unmarked', () => {
    expect(rawOf('[<minsize=2;sep=", ">a|b|c]')).toBeUndefined();
    expect(rawOf('{a|b}')).toBeUndefined();
    // A nested construct is not entered: the inner enumeration marks itself.
    expect(rawOf('[a|{b|%x%}]')).toBeUndefined();
    // A percent sign is not a reference, and an HTML head is element text rather than config.
    expect(rawOf('[<sep="50%">a|b]')).toBeUndefined();
    expect(rawOf('[<li class="x">a</li>|b]')).toBeUndefined();
  });
});

describe('parseTemplate — lenient on malformed markup', () => {
  test('unmatched opener is literal', () => {
    expect(nodes('{a|b')).toEqual([lit('{a|b')]);
  });

  test('stray closer is literal', () => {
    expect(nodes('a}')).toEqual([lit('a}')]);
  });
});

describe('parseTemplate — a tag-shaped config is scanned for its closing tag, never compiled', () => {
  const configOf = (src: string): unknown => (nodes(src)[0] as { config?: unknown }).config;

  test('a config name of any length parses', () => {
    // The closing tag was looked for with `</name\s*>` built from the name itself: V8 would not compile
    // that past about 7.8 KB and parse() threw SyntaxError — render() too, from 333 bytes of macros
    // spelling the name inside a re-read config. §9.2: the engine never throws on content.
    const name = 'a'.repeat(64_000);
    expect(configOf(`[<${name}>x|y]`)).toEqual({ minsize: null, maxsize: null, sep: name, lastsep: name });
    expect(configOf(`[<${name}>x|y</${name}>]`)).toEqual(DEF_CFG);
  });

  test('the closing tag matches as `iu` matched it — any case, and the two letters that fold into ASCII', () => {
    const LONG_S = String.fromCharCode(0x17f);
    const KELVIN = String.fromCharCode(0x212a);
    expect(configOf('[<Li>a|b</lI >]')).toEqual(DEF_CFG);
    expect(configOf(`[<sk>a|b</${LONG_S}${KELVIN}>]`)).toEqual(DEF_CFG);
    expect(configOf('[<li>a|b</lix>]')).toEqual({ minsize: null, maxsize: null, sep: 'li', lastsep: 'li' });
  });
});

describe('stripComments', () => {
  test('removes /# ... #/ across the run', () => {
    expect(stripComments('a/# note #/b')).toBe('ab');
    expect(stripComments('x/# multi\nline #/y')).toBe('xy');
  });

  test('a comment closes at the first #/ after its own /#, and an unclosed one stays text', () => {
    expect(stripComments('a/#/b')).toBe('a/#/b');
    expect(stripComments('a/#/#/b')).toBe('ab');
    expect(stripComments('a/# x #/ b /# y')).toBe('a b /# y');
  });
});

// Each shape took seconds to minutes when a scan per opener, or a lazy pattern per start, read to the end
// of the text — and the parser also reads the megabyte a few hundred bytes of macros spell inside a
// re-read construct. The rewrites are proven output-identical by a differential kept outside the repo;
// these pin that they stay linear. The bound is loose on purpose.
describe('parser — no scan restarts from every opener', () => {
  const N = 400_000;
  const within = (fn: () => void): void => {
    const started = Date.now();
    fn();
    expect(Date.now() - started).toBeLessThan(2_000);
  };

  test('openers that never close', () => {
    within(() => parseTemplate('[<'.repeat(N / 2)));
    within(() => parseTemplate('{plural 1:'.repeat(N / 10)));
    within(() => parseTemplate('{?a?'.repeat(N / 4)));
    within(() => parseTemplate('['.repeat(N)));
  });

  test('comments that never close, and a directive value with a long whitespace run inside', () => {
    within(() => parseTemplate('/#a'.repeat(N / 3)));
    within(() => parseTemplate(`#set %a% = x${' '.repeat(N)}y\n%a%`));
  });

  test('a tag-shaped config holding a quoted >', () => {
    within(() => parseTemplate(`[<a${' '.repeat(N)}">"b>x|y]`));
  });
});

describe('splitTopLevel', () => {
  test('splits on top-level pipes only', () => {
    expect(splitTopLevel('a|b|c')).toEqual(['a', 'b', 'c']);
    expect(splitTopLevel('a|{b|c}|d')).toEqual(['a', '{b|c}', 'd']);
    expect(splitTopLevel('a|[b|c]')).toEqual(['a', '[b|c]']);
    expect(splitTopLevel('')).toEqual(['']);
  });

  test('unmatched closer suppresses the split (signed dual-depth, like PHP)', () => {
    // `]` drives bracket depth to -1, so the following `|` is not both-zero.
    expect(splitTopLevel('a]|b')).toEqual(['a]|b']);
    expect(splitTopLevel('a}|b')).toEqual(['a}|b']);
  });
});

describe('parser — depth (#68)', () => {
  // The parser used to recurse once per level and threw `RangeError` at about 2000 —
  // a 3.9 KB template — while §9.2 promises the engine never throws on content. The
  // walk is a frame stack now, and since every construct is read as a span of one indexed
  // text, depth costs what the markup does: the per-level scans made 32 768 levels 31–40 s.
  const nested = (n: number): string => '{'.repeat(n) + 'x' + '}'.repeat(n);

  test('100 000 levels of every construct kind parse without paying for depth at every level', () => {
    // Each shape leans on a step that used to read the whole subtree once per level: the closer,
    // the top-level split, a conditional's pipe, a config's end, a closing tag, a trailing separator,
    // the plural prefix's colon. The bound is loose on purpose; the old parser took minutes.
    const n = 100_000;
    const shapes: [string, string, string][] = [
      ['{', 'x', '}'],
      ['{a|', 'x', '}'],
      ['[a|', 'x', ']'],
      ['{?f?a|', 'x', '}'],
      ['[<sep=", ">a|', 'x', ']'],
      ['[<li>a|', 'x', ']'],
      ['[a <,>|', 'x', ']'],
      ['{plural ', 'x', '}'],
      ['{a%u%|', 'x', '}'],
    ];
    for (const [open, mid, close] of shapes) {
      const started = Date.now();
      parseTemplate(open.repeat(n) + mid + close.repeat(n));
      expect(Date.now() - started, open).toBeLessThan(3_000);
    }
  });

  test('3000 levels parse instead of throwing', () => {
    const ast = parseTemplate(nested(3000));
    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0]?.type).toBe('enumeration');
  });

  test('the deep tree is still the right shape all the way down', () => {
    // A stack walk that loses a level, or hands a child to the wrong parent, still
    // parses — so the count is the assertion, not the fact that it returned.
    let node = parseTemplate(nested(300)).nodes[0] as Node;
    let levels = 0;
    while (node.type === 'enumeration') {
      levels += 1;
      node = node.options[0]?.[0] as Node;
    }
    expect(levels).toBe(300);
    expect(node).toEqual({ type: 'literal', value: 'x' });
  });
});
