/**
 * Character classes, written out so they match what the PHP engines' patterns match.
 *
 * PHP compiles a pattern that carries `/u` with PCRE2_UCP, which turns `\s`, `\d`, `\w` and `\b`
 * into Unicode classes (measured, #55; again on PHP 8.4.23 / PCRE2 10.44). A pattern WITHOUT `/u`
 * runs in byte mode, where the same shorthands are ASCII. JavaScript has neither dialect: its `\s`
 * is a third set — it takes U+FEFF and misses U+0085 and U+180E — and its `\b`, `\d` and `\w` stay
 * ASCII even under `u`. So a pattern ported from PHP asks one question — does the PHP pattern carry
 * `/u`? — and takes its class from here when it does, or the ASCII set `[ \t\n\x0B\f\r]` when not.
 *
 * The post-process was once written on the opposite belief ("no PCRE_UCP"), and that is how
 * `и т.д.` rendered `и т. Д.` and `пример.рф` rendered `пример. Рф` in every tree-walk engine
 * while both PHP engines kept them intact.
 */

/**
 * PCRE2 UCP `\s` — `\p{Z}` plus `\h` and `\v`: U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680,
 * U+180E, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. A fragment for inside `[…]`.
 */
export const UCP_SPACE =
  '\\t\\n\\x0B\\f\\r \\x85\\xA0\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';

/**
 * PCRE2 UCP `\w` — letters, numbers, non-spacing marks and connector punctuation, `_` among them.
 * PCRE2 before 10.43 leaves out the marks and every connector but `_`, so a PHP host on an older
 * library differs next to one of those; the corpus measures PHP 8.4 (10.44) and this follows it.
 * A fragment for inside `[…]`.
 */
export const UCP_WORD = '\\p{L}\\p{N}\\p{Mn}\\p{Pc}';
