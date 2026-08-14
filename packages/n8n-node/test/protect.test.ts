import { describe, expect, it } from 'vitest';
import { render } from '@spintax/core';

import { protectOp, restoreOp } from '../src/ops/protect';

/** A GSA-shaped macro: brackets AND punctuation parameters, the two hard cases at once. */
const FILE_LINKS = String.raw`#file_links[D:\path,1,S]#`;

describe('the damage this operation prevents (measured against the real engine)', () => {
  it('an unprotected foreign macro loses its brackets and has its parameters edited', () => {
    const rendered = render(`Read more: ${FILE_LINKS} and [URL='%url%']click[/URL].`, {
      seed: '1',
    });
    // Brackets are permutation syntax, so they are consumed…
    expect(rendered).not.toContain('[');
    // …and the cosmetic pass edits `D:` and `,1,S` inside what should be opaque.
    expect(rendered).toContain('D: ');
    expect(rendered).toContain(',1, S');
  });

  it('a lowercase token does NOT survive the typographer — which is why the grammar is uppercase', () => {
    expect(render('Sentence one. spxtoken0 stays?', { seed: '1' })).toContain('Spxtoken0');
    expect(render('Sentence one. SPXTOKEN0 stays?', { seed: '1' })).toContain('SPXTOKEN0');
  });
});

describe('protectOp → render → restoreOp', () => {
  it('round-trips a bracketed macro byte-exact through a cosmetic render', () => {
    const template = `Read more: ${FILE_LINKS} — {enjoy|have fun}!`;
    const protectedResult = protectOp(template, [{ value: FILE_LINKS }]);
    expect(protectedResult.ok).toBe(true);
    expect(protectedResult.protectedTemplate).toContain('SPXTOKEN0');
    expect(protectedResult.replaced[FILE_LINKS]).toBe(1);

    const rendered = render(protectedResult.protectedTemplate, { seed: '7' });
    const restored = restoreOp(rendered, protectedResult.map);

    expect(restored.ok).toBe(true);
    expect(restored.text).toContain(FILE_LINKS);
    expect(restored.replaced['SPXTOKEN0']).toBe(1);
    expect(restored.problems).toEqual([]);
  });

  it('restores a token glued to a following word — where a boundary-based replace misses', () => {
    // `[URL='…']` sits directly against the anchor text, so the token comes out as
    // `SPXTOKEN0click`. A `\b`-anchored restore would skip it AND report no residual.
    const template = `[URL='%u%']click[/URL]`;
    const result = protectOp(template, [{ value: "[URL='%u%']" }, { value: '[/URL]' }]);
    const rendered = render(result.protectedTemplate, { seed: '1' });
    expect(rendered).toContain('SPXTOKEN0click');

    const restored = restoreOp(rendered, result.map);
    expect(restored.text).toBe("[URL='%u%']click[/URL]");
    expect(restored.ok).toBe(true);
  });

  it('substitutes the longest placeholder first, so a nested one cannot eat it', () => {
    const result = protectOp("before [URL='%url%'] after", [
      { value: '%url%' },
      { value: "[URL='%url%']" },
    ]);
    expect(result.protectedTemplate).toBe('before SPXTOKEN1 after');
    expect(result.unused).toEqual(['%url%']);
  });

  it('reports a listed placeholder the template never uses, without calling it a problem', () => {
    const result = protectOp('plain copy', [{ value: '*|FNAME|*' }]);
    expect(result.unused).toEqual(['*|FNAME|*']);
    expect(result.ok).toBe(true);
  });
});

describe('protectOp — refusing loudly', () => {
  it('rejects a token the typographer would mangle', () => {
    const result = protectOp('x', [{ value: '*|FNAME|*', token: 'fname' }]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/breaks the grammar/);
  });

  it('rejects a token that already occurs in the template prose', () => {
    const result = protectOp('BUY NOW at our SHOP', [{ value: '*|X|*', token: 'SHOP' }]);
    expect(result.problems.join(' ')).toMatch(/already occurs in the template/);
  });

  it('rejects a marker the RENDER could create out of prose by capitalizing it', () => {
    // "i agree" contains no `I` as written; the cosmetic pass makes one, and a
    // case-sensitive check would have let the restore rewrite a word of real copy.
    const template = 'i agree. *|FNAME|*';
    expect(render(template, { seed: '1' })).toContain('I agree');
    const result = protectOp(template, [{ value: '*|FNAME|*', token: 'I' }]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/in some casing/);
  });

  it('rejects a marker that matches a VALUE the render will substitute', () => {
    // The marker is nowhere in the template; it arrives with the data, and the restore
    // would then rewrite the data as if it were a marker.
    const result = protectOp('%segment% *|CODE|*', [{ value: '*|CODE|*', token: 'VIP' }], {
      contextValues: ['VIP'],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/occurs in a value the render will substitute/);
  });

  it('does not let a placeholder value rewrite a marker it just wrote', () => {
    // `[LONG]` becomes SPXTOKEN0; a sequential pass would then let the `SPX`
    // placeholder eat the marker it had just inserted.
    const result = protectOp('a [LONG] b SPX c', [{ value: '[LONG]' }, { value: 'SPX' }]);
    expect(result.protectedTemplate).toBe('a SPXTOKEN0 b SPXTOKEN1 c');
    expect(result.ok).toBe(true);
  });

  it('rejects the same token used twice', () => {
    const result = protectOp('a b', [
      { value: '*|A|*', token: 'T' },
      { value: '*|B|*', token: 'T' },
    ]);
    expect(result.problems.join(' ')).toMatch(/used twice/);
  });

  it('catches a variable that hijacks a foreign macro — case-insensitively, both ways', () => {
    // Our engine resolves `%link%` case-INsensitively, the recipient treats case as
    // meaning, so `#set %Link%` swallows every casing of the recipient's `%link%`.
    const template = '#set %Link% = {a|b}\nSee %link% now';
    const result = protectOp(template, [{ value: '%LINK%' }]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/both a foreign placeholder and a variable/);
  });

  it('checks host-supplied context keys the same way as declared variables', () => {
    const result = protectOp('Hi %name%', [{ value: '%Name%' }], { contextKeys: ['name'] });
    expect(result.ok).toBe(false);
  });

  it('a template too malformed to extract is Validate\u2019s problem, not this one\u2019s', () => {
    const result = protectOp('{unclosed %x%', [{ value: '*|A|*' }]);
    expect(result.problems).toEqual([]);
  });
});

describe('restoreOp — verification', () => {
  const map = { SPXTOKEN0: FILE_LINKS };

  it('restores overlapping markers in one pass, longest first', () => {
    // A sequential per-marker replace turns "TAG TAG1" into "*|A|* *|A|*1" and reports
    // success, because no WHOLE marker is left to flag as residual.
    const restored = restoreOp('TAG TAG1', { TAG: '*|A|*', TAG1: '*|B|*' });
    expect(restored.text).toBe('*|A|* *|B|*');
    expect(restored.replaced).toEqual({ TAG: 1, TAG1: 1 });
    expect(restored.ok).toBe(true);
  });

  it('never rescans a value it just substituted, and does not call it a leftover', () => {
    // The `B` inside the restored value of `A` is not a marker the pass missed. A
    // scan run after the fact would report it and fail a restore that was correct.
    const restored = restoreOp('A B', { A: 'contains B literally', B: 'second' });
    expect(restored.text).toBe('contains B literally second');
    expect(restored.replaced).toEqual({ A: 1, B: 1 });
    expect(restored.ok).toBe(true);
  });

  it('an empty key in the map cannot rewrite the whole document', () => {
    // An empty alternative matches between every pair of characters. The map is item
    // data, so this is a guard against input rather than a hypothetical.
    const restored = restoreOp('abc', { '': 'X' });
    expect(restored.text).toBe('abc');
  });

  it('does not call a restored value an orphan just because it is marker-shaped', () => {
    // The orphan scan reads the ORIGINAL text; reading the restored text would fail a
    // correct restore whose value happens to look like an auto-assigned marker.
    const restored = restoreOp('TAG', { TAG: 'SPXTOKEN0' });
    expect(restored.text).toBe('SPXTOKEN0');
    expect(restored.ok).toBe(true);
  });

  it('refuses a document whose auto-assigned markers have no map entry', () => {
    // The Protect step's map did not reach here — without this check the operation
    // would report ok on a document full of raw markers.
    const restored = restoreOp('go SPXTOKEN0 now', {});
    expect(restored.ok).toBe(false);
    expect(restored.problems.join(' ')).toMatch(/not in the placeholder map/);
  });

  it('flags the fullwidth braces the engine emits for markup it could not parse', () => {
    expect(restoreOp('copy with ｛a|b｝ left', {}).problems.join(' ')).toMatch(
      /leftover brace/,
    );
  });

  it('reports a token the typographer altered, instead of shipping it raw', () => {
    const rendered = render('Sentence one. spxtoken0 follows.', { seed: '1' });
    const restored = restoreOp(rendered, { spxtoken0: FILE_LINKS });
    expect(restored.mangled).toContain('Spxtoken0');
    expect(restored.ok).toBe(false);
    expect(restored.problems.join(' ')).toMatch(/altered case/);
  });

  it('detects a restored macro the cosmetic pass edited', () => {
    // The text already contains a damaged copy — exactly what shipping without the
    // protection produces.
    const restored = restoreOp(String.raw`Read more: #file_links[D: \path,1, S]# done`, map);
    expect(restored.problems.join(' ')).toMatch(/damaged by the typographer/);
  });

  it('flags a leftover brace the recipient would re-spin', () => {
    expect(restoreOp('copy with {a|b} left', {}).problems.join(' ')).toMatch(/leftover brace/);
  });

  it('flags a stray %…% that is neither restored nor allow-listed', () => {
    const restored = restoreOp('Hello %first_name%, see %anchor_text%', {}, {
      allowed: ['%anchor_text%'],
    });
    expect(restored.problems.join(' ')).toMatch(/stray %first_name%/);
    expect(restored.problems.join(' ')).not.toMatch(/anchor_text/);
  });

  it('does not complain about a macro\u2019s own %…% content', () => {
    // `[URL='%url%']` legitimately contains a `%…%` of the recipient's, and the scan
    // must cut the known macros out before looking for strays.
    const restored = restoreOp('go SPXTOKEN0 now', { SPXTOKEN0: "[URL='%url%']" });
    expect(restored.ok).toBe(true);
  });
});
