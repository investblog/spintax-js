/**
 * Scaling benchmark for the post-process placeholder restore (spintax-js#52).
 *
 * The restore used to be one full text scan per placeholder — O(text × placeholders) — and
 * since URLs, URIs, emails, domains, decimals and abbreviations are all shielded, the
 * placeholder count grows with the text: the stage went quadratic and came to dominate the
 * whole render (39 s on a 950 KB render). This measures the scaling, so a regression shows up
 * as a curve rather than as a single number nobody can compare against.
 *
 * Not a CI gate — wall-clock on a shared runner is not an assertion. Run it by hand:
 *
 *   npm run build && npm run bench:postprocess
 *
 * Read the `on / off` column: it is the post-process overhead as a multiple of the render
 * itself, and it is the number that must stay flat as the input grows. Linear restore keeps it
 * within a small constant; a quadratic one makes it climb with every step.
 */
import { render } from '@spintax/core';

// One prose unit carrying every shieldable construct, so the placeholder count scales with
// the input instead of staying constant while the text grows.
const UNIT = [
  'Visit https://example.com/a?b=1 or ftp://files.example.org/x for the 2.5 release.',
  'Write mailto:contact@example.com or ring tel:+1-555-0100, e.g. before 3.14 p.m.',
  'See also example.net and shop.example.co.uk, т.д. Mr. Smith paid 1.99 руб.',
].join(' ');

const time = (fn) => {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e9;
};

const rows = [];
for (const reps of [50, 200, 800, 3200]) {
  const src = Array.from({ length: reps }, () => UNIT).join('\n');
  const kb = Math.round(Buffer.byteLength(src) / 1024);
  // One warm-up per size so the first row is not paying for a cold JIT.
  render(src, { postProcess: false });
  render(src);
  const off = time(() => render(src, { postProcess: false }));
  const on = time(() => render(src));
  rows.push({ size: `${kb} KB`, off: off.toFixed(3), on: on.toFixed(3), ratio: `${(on / off).toFixed(1)}×` });
}

console.log('post-process restore scaling — placeholder-heavy text\n');
console.log('| input  | postProcess: false | postProcess: true | on / off |');
console.log('|--------|--------------------|-------------------|----------|');
for (const r of rows) {
  console.log(`| ${r.size.padEnd(6)} | ${(r.off + ' s').padEnd(18)} | ${(r.on + ' s').padEnd(17)} | ${r.ratio.padEnd(8)} |`);
}
