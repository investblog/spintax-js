/**
 * Rendered text that is assembled without being copied at every level.
 *
 * Every frame of the render walk used to join its pieces into a new string, so a construct nested N
 * deep copied its output N times: 32 768 levels, each adding a letter, cost half a second, and four
 * times that per doubling. A {@link Fragment} is a string, or a join of fragments, or a window onto
 * one; the text is materialized once, by {@link flatten}, where a caller needs a string.
 *
 * A permutation trims each element, so every join knows how many trim characters (PHP's six) sit at
 * each of its ends — computed from its pieces when it is made — and a trimmed element is a window,
 * not a copy.
 */
import { isPhpTrimChar } from './parser';

export type Fragment = string | Join | Window;

/** Pieces short enough together are joined on the spot: copying a few dozen characters a level is linear. */
const FLAT_BELOW = 128;

class Join {
  readonly length: number;
  readonly lead: number;
  readonly trail: number;
  constructor(readonly pieces: readonly Fragment[]) {
    let length = 0;
    for (const piece of pieces) length += lengthOf(piece);
    this.length = length;

    let lead = 0;
    for (const piece of pieces) {
      const pieceLead = leadOf(piece);
      lead += pieceLead;
      if (pieceLead < lengthOf(piece)) break;
    }
    this.lead = lead;

    let trail = 0;
    if (lead < length) {
      for (let k = pieces.length - 1; k >= 0; k -= 1) {
        const piece = pieces[k] as Fragment;
        const pieceTrail = trailOf(piece);
        trail += pieceTrail;
        if (pieceTrail < lengthOf(piece)) break;
      }
    } else {
      trail = length;
    }
    this.trail = trail;
  }
}

/** `base[from, to)`, with no trim characters at either end — the only windows made are trims. */
class Window {
  readonly length: number;
  readonly lead = 0;
  readonly trail = 0;
  constructor(
    readonly base: Join | Window,
    readonly from: number,
    readonly to: number,
  ) {
    this.length = to - from;
  }
}

export function lengthOf(fragment: Fragment): number {
  return fragment.length;
}

function leadOf(fragment: Fragment): number {
  if (typeof fragment !== 'string') return fragment.lead;
  let k = 0;
  while (k < fragment.length && isPhpTrimChar(fragment.charCodeAt(k))) k += 1;
  return k;
}

function trailOf(fragment: Fragment): number {
  if (typeof fragment !== 'string') return fragment.trail;
  let k = fragment.length;
  while (k > 0 && isPhpTrimChar(fragment.charCodeAt(k - 1))) k -= 1;
  return fragment.length - k;
}

/** The pieces, in order, as one fragment. */
export function joinFragments(pieces: readonly Fragment[]): Fragment {
  if (pieces.length === 0) return '';
  if (pieces.length === 1) return pieces[0] as Fragment;
  let total = 0;
  let flat = true;
  for (const piece of pieces) {
    total += lengthOf(piece);
    if (typeof piece !== 'string') flat = false;
  }
  if (flat && total < FLAT_BELOW) return (pieces as string[]).join('');
  return new Join(pieces);
}

/** PHP's `trim()` of a fragment, as a window where it is not a string. */
export function trimFragment(fragment: Fragment): Fragment {
  if (typeof fragment === 'string') {
    let start = 0;
    while (start < fragment.length && isPhpTrimChar(fragment.charCodeAt(start))) start += 1;
    let end = fragment.length;
    while (end > start && isPhpTrimChar(fragment.charCodeAt(end - 1))) end -= 1;
    return start === 0 && end === fragment.length ? fragment : fragment.slice(start, end);
  }
  if (fragment.lead === fragment.length) return '';
  if (fragment.lead === 0 && fragment.trail === 0) return fragment;
  return new Window(fragment, fragment.lead, fragment.length - fragment.trail);
}

/** The text of a fragment — one pass, no recursion, however deep the joins go. */
export function flatten(fragment: Fragment): string {
  if (typeof fragment === 'string') return fragment;
  const out: string[] = [];
  // Pieces still to emit, each with the window of it that is wanted; popped in order.
  const stack: [Fragment, number, number][] = [[fragment, 0, fragment.length]];
  while (stack.length > 0) {
    const [piece, from, to] = stack.pop() as [Fragment, number, number];
    if (from >= to) continue;
    if (typeof piece === 'string') {
      out.push(from === 0 && to === piece.length ? piece : piece.slice(from, to));
    } else if (piece instanceof Window) {
      stack.push([piece.base, piece.from + from, piece.from + to]);
    } else {
      const wanted: [Fragment, number, number][] = [];
      let offset = 0;
      for (const child of piece.pieces) {
        const length = lengthOf(child);
        const a = Math.max(from, offset);
        const b = Math.min(to, offset + length);
        if (a < b) wanted.push([child, a - offset, b - offset]);
        offset += length;
        if (offset >= to) break;
      }
      for (let k = wanted.length - 1; k >= 0; k -= 1) stack.push(wanted[k] as [Fragment, number, number]);
    }
  }
  return out.join('');
}
