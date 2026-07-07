/**
 * Tree-walk renderer (M2a scope: literal / variable / enumeration / permutation).
 * conditional / plural land in M2b; recursive %var% + #set collapse-once in M2b;
 * #include + post-process + neutralize later.
 *
 * RNG note: cross-engine RNG-sequence parity is a non-goal (§3.2). Enumerations
 * are rendered outer-first and LAZILY — only the picked branch's nested RNG is
 * consumed, whereas the plugin resolves innermost-out and eagerly (nested RNG in
 * UNPICKED branches too). So a nested enum can diverge from the plugin in both
 * RNG order AND call count. This is corpus-safe because deterministic nested-enum
 * cases use order-independent `rng` sequences (see the conformance README).
 * Permutation, by contrast, resolves all elements eagerly and follows the
 * plugin's exact pick→Fisher-Yates, so its rng-strategy cases are exact.
 */
import type { Node, PermutationNode } from './ast';
import { NotImplementedError } from './errors';
import type { Rng } from './rng';

export interface RenderInternalOptions {
  /** Variable map, keys LOWER-CASED by the caller (context wins over setDefs). */
  readonly context: Readonly<Record<string, string>>;
  /** Globally-extracted `#set` definitions (keys already lowercased). */
  readonly setDefs: Readonly<Record<string, string>>;
  readonly rng: Rng;
}

export function renderNodes(nodes: readonly Node[], opts: RenderInternalOptions): string {
  let out = '';
  for (const node of nodes) out += renderNode(node, opts);
  return out;
}

function renderNode(node: Node, opts: RenderInternalOptions): string {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'variable':
      return resolveVariable(node.name, opts);
    case 'enumeration':
      return renderEnumeration(node.options, opts);
    case 'permutation':
      return renderPermutation(node, opts);
    case 'conditional':
    case 'plural':
      throw new NotImplementedError(`render of '${node.type}'`); // M2b
  }
}

/** `min === max` short-circuits WITHOUT consuming the RNG (plugin `random_int`). */
function randomInt(rng: Rng, min: number, max: number): number {
  return min === max ? min : rng(min, max);
}

/** M2a: plain lookup (recursive expansion / collapse-once land in M2b). */
function resolveVariable(name: string, opts: RenderInternalOptions): string {
  const key = name.toLowerCase();
  const value = opts.context[key] ?? opts.setDefs[key];
  return value ?? `%${name}%`; // unresolved ⇒ left verbatim
}

/** Pick one option (outer-first) and render it. */
function renderEnumeration(options: readonly (readonly Node[])[], opts: RenderInternalOptions): string {
  if (options.length === 0) return '';
  const picked = options[randomInt(opts.rng, 0, options.length - 1)];
  return picked ? renderNodes(picked, opts) : '';
}

interface Element {
  text: string;
  sep: string | null;
}

function renderPermutation(node: PermutationNode, opts: RenderInternalOptions): string {
  // Resolve every element's text first (nested RNG consumed here), then pick+shuffle.
  const elements: Element[] = node.options.map((o) => ({
    text: renderNodes(o.nodes, opts),
    sep: o.separator,
  }));
  const total = elements.length;
  if (total === 0) return '';

  const { config } = node;
  const hasMin = config.minsize !== null;
  const hasMax = config.maxsize !== null;
  let min: number;
  let max: number;
  if (hasMin && hasMax) {
    min = config.minsize as number;
    max = config.maxsize as number;
  } else if (hasMin) {
    min = config.minsize as number;
    max = total;
  } else if (hasMax) {
    min = 1;
    max = config.maxsize as number;
  } else {
    min = total;
    max = total;
  }
  min = Math.max(1, Math.min(min, total));
  max = Math.max(min, Math.min(max, total));

  const pick = randomInt(opts.rng, min, max);
  shuffle(elements, opts.rng);
  const selected = elements.slice(0, pick);
  return joinWithSeparators(selected, config.sep, config.lastsep ?? config.sep);
}

/** Fisher-Yates, matching the plugin: i = n-1 … 1, j = randomInt(0, i), swap. */
function shuffle(arr: Element[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, 0, i);
    const tmp = arr[i] as Element;
    arr[i] = arr[j] as Element;
    arr[j] = tmp;
  }
}

function joinWithSeparators(elements: readonly Element[], globalSep: string, globalLastsep: string): string {
  const count = elements.length;
  if (count === 0) return '';
  if (count === 1) return (elements[0] as Element).text;

  let out = (elements[0] as Element).text;
  for (let i = 1; i < count; i += 1) {
    const el = elements[i] as Element;
    const sep = el.sep ?? (i === count - 1 ? globalLastsep : globalSep);
    out += padSeparator(sep) + el.text;
  }
  return out;
}

/** Purely-alphabetic separators get space-padded; others pass through (plugin). */
function padSeparator(sep: string): string {
  const trimmed = phpTrim(sep);
  if (trimmed === '') return sep;
  if (/^\p{L}+$/u.test(trimmed)) return ` ${trimmed} `;
  return sep;
}

const PHP_LTRIM_RE = /^[ \t\n\r\0\x0B]+/u;
const PHP_RTRIM_RE = /[ \t\n\r\0\x0B]+$/u;
function phpTrim(s: string): string {
  return s.replace(PHP_LTRIM_RE, '').replace(PHP_RTRIM_RE, '');
}
