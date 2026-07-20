import { describe, test, expect } from 'vitest';
import worker from '../src/index';

const post = (path: string, body: unknown): Promise<Response> =>
  worker.fetch(
    new Request(`https://w.dev${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = async (res: Response): Promise<any> => res.json();

describe('worker — routing & guards', () => {
  test('GET ⇒ 405', async () => {
    expect((await worker.fetch(new Request('https://w.dev/preview-render'))).status).toBe(405);
  });
  test('unknown path ⇒ 404', async () => {
    expect((await post('/nope', { template: 'x' })).status).toBe(404);
  });
  test('invalid JSON ⇒ 400', async () => {
    const res = await worker.fetch(new Request('https://w.dev/preview-render', { method: 'POST', body: '{oops' }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe('invalid_json');
  });
  test('missing template ⇒ 400', async () => {
    const res = await post('/preview-render', { seed: 1 });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe('template_required');
  });
});

describe('worker — endpoints map to the §9.2 surface', () => {
  test('validate-template ⇒ verdict + diagnostics', async () => {
    expect((await bodyOf(await post('/validate-template', { template: '{a|b}' }))).valid).toBe(true);
    const bad = await bodyOf(await post('/validate-template', { template: '{a|b' }));
    expect(bad.valid).toBe(false);
    expect(bad.diagnostics.some((d: { severity: string }) => d.severity === 'error')).toBe(true);
  });

  test('extract-variables ⇒ refs/sets/includes', async () => {
    const r = await bodyOf(await post('/extract-variables', { template: '#set %s% = x\n%s% %t%' }));
    expect(r.sets).toEqual(['s']);
    expect([...r.refs].sort()).toEqual(['s', 't']);
  });

  test('analyze-template ⇒ census + diagnostics', async () => {
    const r = await bodyOf(await post('/analyze-template', { template: '{a|b} %v%' }));
    expect(r.constructs.enumeration).toBe(1);
    expect(r.constructs.variable).toBe(1);
    expect(Array.isArray(r.diagnostics)).toBe(true);
  });

  test('preview-render ⇒ seeded, post-processed by default', async () => {
    const r = await bodyOf(await post('/preview-render', { template: 'hello {a|a}', seed: 1 }));
    expect(r.output).toBe('Hello a');
  });

  test('render-batch ⇒ parse once, N seeded variants', async () => {
    const r = await bodyOf(await post('/render-batch', { template: '[a|b|c]', count: 5, seed: 10, postProcess: false }));
    expect(r.variants).toHaveLength(5);
    for (const v of r.variants) expect([...v.split(' ')].sort().join('')).toBe('abc');
  });
});

describe('worker — owns non-engine concerns (§8)', () => {
  test('T2: caller-supplied context is shielded (data cannot inject markup)', async () => {
    const r = await bodyOf(
      await post('/preview-render', { template: '%bio%', context: { bio: 'Save {50|60}% now' }, postProcess: false }),
    );
    expect(r.output).toBe('Save {50|60}% now'); // braces stay literal, not a random pick
  });

  test('two-phase #include: caller passes resolved bodies for extracted refs', async () => {
    const r = await bodyOf(
      await post('/preview-render', { template: '#include "hero"', includes: { hero: 'Welcome' }, postProcess: false }),
    );
    expect(r.output).toBe('Welcome');
  });
});

// The deployed Worker sat on a pre-0.3.0 build for eleven days and answered with pre-0.3.0
// semantics: `#def` unrecognised, no `defs` in extract, and a `#set` plural counter pronounced
// valid. Nothing at the HTTP surface pinned any of it — the endpoints just pass the engine's
// result through, so a stale build is invisible until someone diffs a live response by hand.
describe('worker — the 0.3.0 directive contract, pinned at the HTTP surface', () => {
  test('/extract-variables reports defs, and a #def name is not a runtime ref', async () => {
    const body = await bodyOf(
      await post('/extract-variables', { template: '#def %a% = {x|y}\n#set %b% = z\n%a% %b% %c%' }),
    );
    expect(body.defs).toEqual(['a']);
    expect(body.sets).toEqual(['b']);
    // `a` and `b` are defined by the template; only `c` is the host's to supply.
    expect(body.refs).toContain('c');
  });

  test('/validate-template accepts #def without calling it an undefined variable', async () => {
    const body = await bodyOf(
      await post('/validate-template', {
        template: '#def %p% = {course|training}\nThe %p% is a %p%.',
      }),
    );
    expect(body.valid).toBe(true);
    expect(body.diagnostics.map((d: { code: string }) => d.code)).not.toContain(
      'variable.undefined',
    );
  });

  test('/validate-template rejects a #set plural counter — the 0.3.0 verdict', async () => {
    const body = await bodyOf(
      await post('/validate-template', {
        template: '#set %n% = {1|4}\n{plural %n%: item|items}',
        locale: 'en',
      }),
    );
    expect(body.valid).toBe(false);
    expect(body.diagnostics.map((d: { code: string }) => d.code)).toContain('plural.count-macro');
  });

  test('/analyze-template carries defs too', async () => {
    const body = await bodyOf(await post('/analyze-template', { template: '#def %a% = {x|y}\n%a%' }));
    expect(body.defs).toEqual(['a']);
  });
});
