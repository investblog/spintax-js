export const BRACE_OPEN = 0x7b;
export const BRACE_CLOSE = 0x7d;
export const BRACKET_OPEN = 0x5b;
export const BRACKET_CLOSE = 0x5d;

/**
 * For every `open` in `text`, the index of the `close` that matches it — counting depth of this one
 * bracket pair only — or -1 when it is never closed.
 *
 * One pass with a stack. The closer that pops an opener is exactly where a depth count started at
 * that opener first returns to zero, so this answers what a count per opener answers — and a count per
 * opener is quadratic, because one that never closes runs to the end of the text. Paid for in the
 * renderer's conditional pass first (an unbalanced plural count slot, legal because only the whole
 * block has to balance: 3 s at 78 KB), then in the parser and the plural scan.
 */
export function matchPairs(text: string, open: number, close: number): Int32Array {
  const pairs = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === open) {
      stack.push(i);
    } else if (code === close) {
      const opener = stack.pop();
      if (opener !== undefined) pairs[opener] = i;
    }
  }
  return pairs;
}

/**
 * The same, with `{` and `[` on one stack and either closer popping it — the pairing behind a single
 * depth counter clamped at zero, the one a conditional's branch split keeps. A closer with nothing open
 * is ignored, as the clamp ignores it.
 */
export function matchAnyPairs(text: string): Int32Array {
  const pairs = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === BRACE_OPEN || code === BRACKET_OPEN) {
      stack.push(i);
    } else if (code === BRACE_CLOSE || code === BRACKET_CLOSE) {
      const opener = stack.pop();
      if (opener !== undefined) pairs[opener] = i;
    }
  }
  return pairs;
}
