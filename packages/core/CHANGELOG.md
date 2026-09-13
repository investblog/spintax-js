# Changelog

All notable changes to `@spintax/core` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.8.0 — 2026-09-13

Two defects found by the ports while they mirrored 0.7.0, both places where this engine read a
template differently from the PHP engines — and both measured on those engines before anything
changed: the character classes of the post-process, and the key that decides which constructs are
re-read as text (#80).

**The post-process reads characters the way PHP does.** PHP compiles every pattern of the cosmetic
stage with `/u`, and `/u` turns on PCRE2_UCP: `\s`, `\d`, `\w` and `\b` are Unicode classes there.
This engine took them for ASCII — the belief was written into its own comments ("no PCRE_UCP") — and
the three ports that copied the classes did the same. Measured on both PHP engines:

| input | 0.7.0 | both PHP engines, and now this one |
|---|---|---|
| `и т.д. и т.п. всё` | `И т. Д. И т. П. Всё` | `И т.д. и т.п. всё` |
| `открой пример.рф сегодня` | `Открой пример. Рф сегодня` | `Открой пример.рф сегодня` |
| `пишите на info@сайт.рф` | `Пишите на info@сайт. Рф` | `Пишите на info@сайт.рф` |
| `end.<NBSP>next` | `End. <NBSP>next` | `End.<NBSP>Next` |
| `в 5<NBSP>тыс.<NBSP>руб.` | `В 5<NBSP>тыс. <NBSP>руб.` | `В 5<NBSP>тыс.<NBSP>руб.` |

**A conditional or a config reference inside `{…}`/`[…]` is text before the split, too (#80).** 0.7.0
re-read a construct as text when a `%var%` sat directly in it, and decided that from a key narrower
than its own rule:

| template | 0.7.0 | both PHP engines, and now this one |
|---|---|---|
| `[<minsize=%n%;maxsize=%n%>a\|b\|c]`, `n=1` | all three elements | one element |
| `[<sep=%S%>a\|b]`, `S=", "` | `b a` | `b, a` |
| `[{?f?a\|b\|x}\|c]` | `c b\|x` — a raw pipe | three elements |
| `[<sep=", ";lastsep=" and ">{?f?live casino}\|slots\|poker]` | `slots, poker and ` | `poker and slots` |
| `[<sep=", ">slots\|{live casino\|}\|poker]`, the empty option picked | `slots, , poker` | `slots, poker` |

Minor rather than patch: rendered text changes for every template of these shapes, and
`AST_VERSION` moves to 4.

### Fixed

- **The post-process classes are PHP's UCP classes** (`internal/charclass.ts`). Whitespace is PCRE2's
  `\s` — NBSP, the thin spaces, NEL — and not JavaScript's, which adds U+FEFF and misses U+0085 and
  U+180E. `\b` counts a letter of any script as a word character. The digit in the two spacing
  lookaheads is any `\p{Nd}`. The decimal shield stays ASCII: PHP writes that one pattern without `/u`.
- **Conditional truthiness uses the same whitespace.** A value of U+FEFF alone is truthy (it was blank
  here); a value of U+0085 alone is blank (it was truthy).
- **The permutation-config patterns go the other way.** PHP writes them without `/u`, so their `\s` is
  ASCII, while JavaScript's `\s` is Unicode on any flags. A no-break space around `=` is no longer
  config whitespace — `[<minsize<NBSP>=<NBSP>1>a|b|c]` is one separator, as in PHP — and the validator
  agrees: `[<foo<NBSP>=1>a|b]` is valid, `[<minsize=2<NBSP>>a|b]` is `permutation.minsize-not-integer`.
- **A reference anywhere in a permutation's `<config>` marks it for the re-read** (#80). 0.7.0 tested
  the PARSED `sep` and `lastsep`, where a size reference never arrives (a size that is not digits
  parses to nothing) and neither does an unquoted separator (it parses to the default). The raw
  header is tested now, so `minsize=%n%`, `maxsize=%n%` and `sep=%S%` take their values from the
  context, as they always have in PHP. So does a whole `{?…}` there or in a per-element separator —
  `[<lastsep="{?en? and | и }">a|b|c]` printed the raw conditional unless a neighbour happened to
  trigger the re-read (found in review). A bare `{?` does not mark: the first cut of that check made
  every level of `[<{?}>a|[<{?}>a|…]]` rescan its body for a conditional that was not there, twice
  0.7.0's time on deep nesting (found by the Codex gate).
- **A `{?…}` conditional directly in `{…}`/`[…]` marks the construct** (#80), whatever its branches
  hold — 0.7.0 marked it only when a `%var%` sat in a branch. The plugin resolves conditionals at
  Stage 6a, before any bracket is read, so a taken branch's `|` separates options, an empty branch
  leaves an empty permutation element that is dropped, and whitespace at a branch's edge is the
  element's edge. 0.7.0's notes kept the empty element on purpose as a pathological divergence; a
  list item gated by a flag is an ordinary template, and in one it rendered `Есть покер, слоты и.`.
- **A permutation element is its rendered text, trimmed, and one that renders empty is dropped** (#80).
  The plugin resolves every nested enumeration before it splits a permutation, so an optional item
  written `{live casino|}` that picks its empty option leaves `slots||poker` there — two elements —
  while this engine kept a blank third and printed `slots, , poker`; `[<minsize=3;maxsize=3>a|{b|}|c]`
  counted three and printed `a  c`. The conditional fix above did not reach it: the re-read drops a
  part that is empty as TEXT, and `{b|}` is not empty until it is rendered. Found by the differential
  below after the conditional half was in; the size pick and the shuffle count the elements that
  remain, and an element that is neither empty nor padded draws as before.
- **`AST_VERSION` 3 → 4.** The node shape is 3's, but an `Ast` cached by 0.7.0 lacks `raw` exactly
  where the wider key puts it and would render the old output; the guard turns that into
  `AstVersionError`. Nothing persists a handle across versions.
- **Three patterns no longer scan a long run once per character** (found in review). Trimming each
  assembled element with `/[…]+$/` retried from every position of a whitespace run inside the text —
  the first cut of the element fix made `[a%v%y|z]` over 51 000 spaces take 3 s, and 13 s from a
  362-byte macro template; the PHP trims are loops now, in the parser as well, where the same regex
  already cost seconds on a re-read. And two post-process patterns that were quadratic IN 0.7.0 got
  new triggers from the wider whitespace class: removing whitespace before punctuation rescanned a run
  with no punctuation after it (100 000 form feeds: 10 s in 0.7.0; a macro of NBSP or U+3000: 10–31 s
  on the first cut), and capitalizing after a line break rescanned a run of breaks and spaces with no
  letter after it (20 000 of `\n` plus a space: 4 s in 0.7.0). Each now starts a match only where the
  run starts — the same matches, checked over 500 000 generated strings — and all of these take
  milliseconds.
- **`parse()` and `render()` no longer throw on a long tag-shaped permutation config.** Whether
  `[<name>…]` opens with an HTML tag was decided by compiling `</name\s*>` from the name itself, and V8
  will not compile that past about 7.8 KB of name: `SyntaxError: Invalid regular expression … Stack
  overflow`, straight out of `parse()`. A 7.8 KB source was enough — under the reference Worker's 8 KB
  cap — and so were 333 bytes of `#set` doubling a letter inside a re-read config, which spell the name
  at render time. §9.2 says the engine never throws on content; 0.7.0 threw on both.
  The closing tag is found by a scan now, matching exactly what the pattern matched: any case, and the
  two non-ASCII letters `iu` folds into ASCII (U+017F, U+212A). Found by the scaling probe behind the
  note on template scans below.
- **`constructor` and `__proto__` are ordinary variable names.** The variable and definition maps were
  plain JavaScript objects, so both names found `Object`'s own members, and assigning `__proto__` stored
  nothing. `render('a %constructor% b')` threw `TypeError` — §9.2 lets `render()` throw only on a resolver
  or a foreign `Ast` — while `validate()` called the name merely undefined, so nothing could screen it out.
  `%__proto__%` rendered as nothing, `{?constructor?…}` and `{?__proto__?…}` took the then-branch, a
  `#set`, a `#def` or a context value under `__proto__` was lost, a runtime list under it spliced
  `[object Object]`, and the validator withheld `plural.arity`, `plural.count-macro` and
  `plural.nested-brackets` for a `#set` of either name — valid where both PHP validators say invalid.
  Both PHP engines read variables from arrays and always treated them as ordinary names. The maps have
  no prototype now (`internal/name-map.ts`). Found by the Codex gate on the nesting rewrite, where
  `%__proto__%` had left the expansion budget `NaN`.

### Changed, visibly

- A no-break space behaves like a space around punctuation: removed before `,.;:!?`, no second space
  inserted after one, and the next sentence capitalized through it. French typography with U+202F
  before `!` or `?` loses it — as a plain `bonjour !` always has, in every engine.
- A glued Cyrillic sentence stays glued: `конец.Начало` matches the bare-domain shield in PHP and now
  here, exactly as `compact.Game` always has in ASCII. Whether the shield should take a capitalized
  TLD at all is #79.

### Corpus

Twenty fixtures, every expectation taken from BOTH PHP engines (docker, real code): fifteen in
`render-postprocess.json` — Cyrillic multi-dot abbreviations, an IDN domain, email and TLD, NBSP before
and after punctuation and after a whitelisted abbreviation, a URL that ends at NBSP, an Arabic-Indic
digit, NEL as whitespace and U+FEFF as not, a glued Cyrillic sentence, `_` before an abbreviation — plus
`conditional/bom-only-is-truthy`, `conditional/nel-only-is-falsy`,
`perm/config-nbsp-is-not-config-whitespace` and its two `validate/*` twins. Nineteen fail on 0.7.0; the
twentieth is a negative guard. No earlier fixture put a non-ASCII character next to a boundary or a
whitespace class — every domain, email and multi-dot case was Latin — which is how a premise stated in
a comment stayed green for two months. `postprocess.test.ts` had pinned the mangled `т.д.` "in both
engines", with an assertion that passed on the capital letter alone.

Seven more `splice/*` fixtures for #80, again from both PHP engines: a size and an unquoted separator
taken from a variable, a taken branch carrying a pipe in `[…]` and in `{…}`, a flag-gated list item,
a branch trimmed at an element's edge — six fail on 0.7.0 — and the negative
`splice/conditional-without-pipes-keeps-draws`, which pins that a conditional changing nothing
structural draws exactly where 0.7.0 drew. Three `perm/*` fixtures for an element that renders empty or
padded: `perm/nested-empty-option-drops-element`, `perm/nested-option-edge-whitespace-trimmed` and
`perm/dropped-element-narrows-the-size-range`, all failing on 0.7.0. Four from the review, all failing on
0.7.0: `splice/conditional-in-per-element-separator`, `splice/conditional-in-config-lastsep`, and the
separator of a dropped element — `perm/dropped-element-takes-its-separator` (`[a<1>|{x|}|b]` is `a b`)
and `perm/dropped-element-passes-on-its-trailing-separator` (`[a<1>|{x|}<2>|b]` is `a2b`).

**The corpus can pin how many** (#74). `validate` cases take an optional `diagnosticCount` — the exact
number of diagnostics per code — where the subset match used to be the only assertion, and that
subset match is what passed two million circular-reference diagnostics for eleven days (#59). Two
cases carry it: `validate/cycle-diamond-terminates` (22, one per name) and the new
`validate/plural-count-macro-per-reference`, which records #73's decision: `plural.count-macro` once
per tainted reference in the count slot, as this engine, `spintax-core` and both PHP validators already
emit it. No engine output changed for either.

Twelve fixtures for the prototype names, every expectation taken from both PHP engines: eight in
`render-semantics.json` — undefined references, conditionals, a `#set` of each name, context keys, a
`#def` rolled once, a `#def` naming them undefined, a runtime list spliced into a permutation, a form
slot — and four in `validate.json`: the three withheld plural verdicts and the negative
`validate/prototype-names-defined-and-undefined`. Eleven fail on 0.7.0. A JSON-decoded context carries
`__proto__` as an ordinary key in every engine's harness; a JavaScript object literal would not.

### Notes

**Cost.** Against 0.7.0, the post-process of this whole batch is faster on prose and on HTML blocks and
about a third slower on shield-heavy text — V8 runs a Unicode-class lookbehind more slowly than its ASCII
`\b`, and every shield pattern carries one now. Per 1 000 calls, the four builds side by side:

| input | 0.7.0 | the classes alone (regexes) | first linear scanners | now |
|---|---|---|---|---|
| prose, 857 characters | 34 ms | 32 ms | 108 ms | 19 ms |
| HTML blocks, about 700 characters | 33 ms | 31 ms | 86 ms | 27 ms |
| a URL, email, domain, decimal and abbreviation line, 237 characters | 36 ms | 46 ms | 70 ms | 49 ms |
| the same line ×3 200, 756 KB, once | 113 ms | 151 ms | 223 ms | 158 ms |

**The post-process is linear — and was a live denial of service in every release before this.** Eight
of its passes were global regex replaces that a long run made retry from every start inside it: the
email shield (one long word), the bare-domain shield (a dotted chain in any script), the
trailing-punctuation cut of a URL, the space after a run of sentence marks, and the three capitalizers
after a sentence end, a block tag and a line break (an unclosed `<`, a run of `<p>`). None of those
runs needs a long template: 336 bytes of `#set` doubling one letter expand to 131 000 characters, whose
post-process took 25 s, and the dotted, mark and tag units ran longer — so any host rendering untrusted
templates with post-process on, the reference Worker and the hosted MCP server among them, could be held
for as long as its CPU limit allowed. The expansion budget bounded the size of that text, never the time
to post-process it. One more stage was quadratic on its own terms (found by the Codex gate): the restore
of a text that carries U+0000, where #54 keeps the reference loop's reading — one `split`/`join` per
placeholder — so a few hundred bytes doubling a NUL and a decimal took 2.1 s at 16 000 decimals, four
times that per doubling.

The shields and the capitalizers are scanners now. They run the plugin's own patterns at the same starts,
in the same order, and skip only starts that provably fail. Every start inside one run of email-local
characters meets the same `@` or none, so the email shield works back from each `@` — a text without one
costs nothing. An attempt that fails at the start of a chain of labels fails at every later start in that
chain, because the chain's own labels prefix any match further in, so the domain shield is one regex that
matches at the starts it tries and consumes the chain when there is no domain — and is skipped when no dot
in the text is followed by a label's first character. A lead has exactly one tokenization — a tag ends at
the first `>` — so the capitalizers find their boundaries natively, walk a short lead, and build an index of
where each lead ends, from the right, only when a lead holds a tag or runs past 32 characters; one index
serves all three passes unless a capital grew the text (`ß` → `SS`). The URL cut is a loop, and the
sentence-mark space starts a match only where its run starts. Output is byte-identical: 7.9 million strings
against the regex implementation — exhaustive over small alphabets aimed at each pass, plus random soup — and
5.8 million more aimed at the final form of each scanner, with every real control mutation caught, and the
20 000-input post-process differential against both PHP engines unchanged at zero. Those macro templates now
render half a megabyte to a megabyte in 0.1–0.2 s.

The first cut of these scanners paid for linearity on every call: a regex call per word, a JavaScript step
per character, three times — 3.4 times the regex passes on a short paragraph (the table above). The scaling
bench, one large text, could not show that, and this note first said the bench was no slower on prose. The
shapes above are what came after measuring a thousand short renders instead.

The NUL-path restore computes the loop's result in one pass. An occurrence of a key is always a stretch
of the original text between two `\x00`s — no stored value holds a `\x00`, and no whole stored value
fits inside a key name — so the only way one replacement touches another is by taking a delimiter they
share, and visiting the candidates in the loop's key order, each only while both its delimiters survive,
is the loop. 1.9 million NUL-carrying strings come out identical, three control mutations were caught,
and the 16 000-decimal case takes 130 ms.

**The template scans are linear too — and part of that was live the same way.** They had the
post-process's flaw. The parser matched each `{` and `[` by counting forward to its closer, which
for an opener that never closes is the end of the text, from every such opener; the plural scan did the
same for `{plural …}`, and the validator ran `/\[<([^>]*?)>/` from every `[<`. Lazy or overlapping
patterns restarted from every character of a run in four more places: a `/# … #/` comment that never
closes, a `#set`/`#def` value with a long whitespace run inside, a tag-shaped config holding a quoted
`>`, and the validator's config-key test on a long word. The re-read of a construct hands the parser
whatever its macros spell, so the parser's half was reachable from a few hundred bytes:

| input (Node 22) | 0.7.0 | now |
|---|---|---|
| 333–341 bytes of `#set` spelling `[<`, `{?a?`, `[<li>`, `[<sep="` or `{plural 1:` inside `{…}` — render | 1.3–6.2 s, ×4 per doubling | 63–117 ms |
| 387 bytes spelling form feeds into a tag-shaped config that holds a quoted `>` — render | 8.6 s, ×4 per doubling | 117 ms |
| `[<` repeated, 32 KB — render / validate | 1.4 s / 0.27 s | 29 ms / 23 ms |
| `{plural 1:` repeated, 32 KB — render / validate | 0.32 s / 0.20 s | 41 ms / 17 ms |
| `/#a` repeated, 32 KB — parse / validate | 0.14 s / 0.14 s | 10 ms / 12 ms |
| a `#set` value holding 32 KB of spaces — parse / validate | 2.8 s / 11.8 s | 4 ms / 14 ms |
| `[<a`, 32 KB of spaces, a quoted `>` — parse | 2.0 s | 10 ms |
| `[<` and a 32 KB word `>` — validate | 0.9 s | 10 ms |

Brackets are paired once for the whole text, and the plural scan and the renderer's conditional pass use
the same tables — the deep-nesting note below says how a construct is read now. The comment strip and the
config scan are `indexOf` loops. The directive value ends at its last non-blank character instead of
growing lazily, the tag pattern takes one whitespace character where two runs used to trade them, and a
config key starts only where a word does — each matching exactly what it matched before. Output is
byte-identical to the code before: 4.3 million generated strings through `parse`, `render` (three rng
strategies, with and without post-process), `validate`, `analyze`, `extract` and the plural scan —
exhaustive over alphabets aimed at each rewritten scan, plus random soup — with all twelve control
mutations caught first.

**Deep nesting no longer costs its depth again at every level — and the re-read had made that a live denial
of service.** #68 kept nesting super-linear on the ground that depth costs source: at the hosted 8 KB cap,
4 000 levels answered in about a second. 0.7.0's re-read took that ground away, because a construct re-read
as text hands the parser whatever its macros spell (found by the Codex gate):

| input (Node 22, the two measured side by side) | 0.7.0 | now |
|---|---|---|
| 705 bytes: `{%o15%x%c15%\|y}` over fifteen `#set` doublings of `{` and of `}` — render | 40 s | 0.14 s |
| a `#def` rolling those 32 768 levels, referenced once — render | 40 s | 0.28 s |
| `{a…x…b}` 16 384 levels deep, every level adding text — render | 19 s | 0.14 s |
| `[a\|…x…]` 16 384 levels deep — render | 20 s | 0.24 s |
| `{a%u%…x…}` 8 192 levels, each marked for the re-read by an undefined reference — render | 20 s | 0.10 s |
| 20 000 nested conditionals naming a `#def` of 2^17 form feeds — render | 13 s | 0.30 s |
| `{` 100 000 levels deep — parse | > 90 s | 0.21 s |

Four costs were paid once per level, and each is gone:

- **The parser read every construct's content in full** — to find its closer, to split it on top-level
  pipes, to find a conditional's pipe, a config's end, a closing tag, a trailing separator — and handed its
  children copies. A construct's children are spans of one text now, and every one of those questions is
  answered for a span from tables built once over the text (`internal/text-index.ts`): bracket pairs; the
  top-level pipes grouped by the brace and bracket totals in front of them, since `split_top_level`'s two
  signed counters split exactly where both totals equal the ones at the span's start; a conditional's pipe
  by jumping each opener to where one stack of both bracket kinds closes it, which is what the clamped
  counter counts; the quote parity of every `>`; every closing tag by name; every `<` and `>`. Most of those
  answers are a binary search in a sorted list of positions, so a template of n characters parses in
  O(n log n) at worst rather than O(n) — the logarithm shows on many small siblings: 200 000 `{a|b}` parse in
  150 ms against 0.7.0's 137, 100 000 `[<sep=",">a|b]` in 208 against 161 (found by the Codex gate).
- **The walk joined each frame's output into a new string**, copying a construct's text once for every
  level above it. Frames hand fragments up instead — joins, and windows for a trimmed permutation element,
  every join knowing how many PHP trim characters sit at its ends — and the text is made once.
- **A construct marked for the re-read ran both conditional passes and the fixpoint over its body to find
  nothing to change**, once per marked level. The index answers first: the body can change only if it holds
  a conditional the pass would resolve — a well-formed head whose brace closes inside it — or a reference
  expansion would substitute, a name the variable map defines while the budget lasts. When neither, the
  splice returns what it always returned. The conditional pass finds its heads once, too, instead of
  searching the text again from the start of every span.
- **Truthiness scanned a value's leading whitespace at every conditional**; it is computed once per
  variable map.

Output is byte-identical to the code before this change: the 4.3 million alphabet strings above again, and
20 000 generated documents — long outputs, padded and empty elements, constructs marked for the re-read
with defined, undefined and budget-starved references, conditionals in bodies, count slots and `#def`
rolls, nests up to 300 deep — through eight probes each (`parse`, `validate`, `analyze`, four rng
strategies with and without post-process, and a pre-parsed `Ast`), with the control mutations caught first:
a join that stops counting trim characters after its first piece, one that never counts them at its end, a
trim window a character late, a re-read check that forgets conditionals or inverted heads or compares names
case-sensitively, one truthiness cache for every map, a conditional pass that skips a head at a span's start,
top-level pipes grouped by one depth, a flipped quote parity, a closing tag on the span's end counted
outside it. The PHP engines are no linear reference here: both resolve innermost-first with a
full-text pass per level and stop at 10 000 levels with an exception — in `spintax/core`, 8 192 nested
permutations took 5.9 s and 32 768 nested enumerations threw. Real templates did not pay for any of this —
the render cost note below has the numbers. An `Ast` copied out of the process (it is not a serialization
format) loses the side table the index lives in, and renders the same text by reading bodies as before.

**Two costs bounded by the source, recorded rather than changed.** The same gate found `validate()`
formatting a large definition cycle in quadratic time — each name walks the cycle to count what its
printed route leaves out: 8 000 names 6.5 s, the 320 that fit in 8 KB 23 ms — and `render()` ordering
`#def`s in quadratic-to-cubic time: 1 600 in a chain 2 s, 400 in 90 ms. A macro cannot spell either,
both were so in 0.7.0, and the hosted surfaces cap a source at 8 KB.

**Two PHP builds differ at the margin.** PCRE2 10.43 made non-spacing marks and connector punctuation
word characters, so PHP 8.3 sees a boundary between `x` and U+0301 that PHP 8.4 does not. The corpus
runs PHP 8.4 and this engine follows it; recorded in the conformance README.

**What the wider re-read does not move.** A construct re-read because it holds a conditional draws
exactly as the tree did whenever the taken branch changes nothing structural — measured on 0.7.0
before the change, 500 seeds over five shapes (a permutation with separators, one with a size range,
an enumeration, a nested permutation in a branch, an else branch): identical renders. What changes is
the three kinds of text the plugin always produced here — a pipe in a branch, an empty element, a
trimmed edge — and only in the renders where one occurs: a permutation whose elements all render
non-empty and unpadded picks and shuffles exactly as before. `validate()` still reports `minsize=%n%`
as `permutation.minsize-not-integer`, as both PHP validators do: a verdict about the template as
written, unchanged.

**Verified against PHP, not only against 0.7.0.** A generator of construct-heavy templates —
conditionals with empty, piped and padded branches, references in configs and elements, macros
carrying conditionals, per-element separators — 3 000 renders with `rng: first` and `last` through
both PHP engines: 0.7.0 differed on 416, this engine on 0. The first cut of #80 still differed on
147, every one an element that rendered empty through a nested construct; that is how the trim-and-drop
above was found. And 20 000 generated post-process inputs (Latin, Cyrillic, marks, every space the two
dialects disagree on, shield triggers): 0.7.0 differed on 6 229, this engine on none but the recorded
final `trim`, which accounts for all 3 689 of its edge-only differences. A zero holds for what those
generators can build, and is stated here as that.

**On a production host's templates.** 2 522 template-and-flag combinations taken from a live
deployment's migrations, 15 132 renders against 0.7.0: 30 change, and `validate`/`analyze`/`extract`
change on none. They are the two defects, in real copy: Russian brand articles stop printing
`Т. Е. Каждый перевод…` and `…х5, х7 и т. Д.`, and a payment FAQ whose list gates one item behind
`{?CasinoHasCrypto?…|}` stops printing `…are offered.. Traditional methods…` for a casino without
crypto — the blank element and its `. ` separator, which post-process had turned into a double stop.
The same generated documents without any of the changed shapes — 600 of them, 3 600 renders plus
`validate`/`analyze`/`extract` — are byte-identical, and the harness caught all three deliberate control
mutations first.

**Render cost.** A construct re-read because it holds a conditional is parsed again on every render, so
the payment FAQ whose list gates one item behind a flag is the one real template that got slower: 1 000
renders take 120 ms against 0.7.0's 86. Everything else measured got faster once the index answered most
re-reads without reading, the walk stopped copying and the post-process lost its per-call overhead: the FAQ
with a providers gate four times over, 513 ms against 1 322; plain prose, 145 against 198; all 1 262
construct-bearing literals of the production host's migrations, rendered once each, 178 ms against 262.

**The prototype names, verified against a renamed oracle.** 0.7.0's output under those names was the
defect, so the fixed build is compared with the build before it on each document with `__proto__` and
`constructor` renamed to ordinary names of the same length, renamed back in the output: 20 000 generated
documents, 19 875 carrying one of the names in a reference, a conditional, a `#set`, a `#def`, a plural
slot or a context key, through `parse`, `validate`, `analyze` and five renders — no difference, with three
control mutations caught first (an unrelated truthiness change, and the alias map or the `#def` map left a
plain object). The 449 009 alphabet strings, which name neither, are unchanged. The maps are merged by a
loop: `Object.assign` into a map with no prototype took five times the spread it replaced, once per
`#def` — 1 000 renders of a template with 60 context variables and 20 definitions went from 920 ms to
1 336 — and the loop brings that to 968. The production templates, the FAQ and prose measure as before.

**Recorded, not closed** — in the conformance README, under the known divergences. A value carrying an
unbalanced bracket (`[a|{%L%}]` with `L = "x}|y"`) re-cuts the enclosing construct in PHP and only its
own here. Four shapes of the same family, where a nested pick leaves markup the permutation's reader
sees in PHP and a tree parsed before the pick: a leading element that renders empty exposes its
`<…>` as the permutation's config, a pick ending in `<…>` becomes a per-element separator, a
construct inside the config is resolved first, and a nested permutation joined by `|` re-splits the
outer one (`[[<|>a|b]|c]`). All four were already so in 0.7.0. A generated differential aimed at exactly these meets
the first twice in 3 000 renders. And the Unicode tables: Node 22's are 17.0, PCRE2 10.44's are 15.0,
so a character assigned since then can sit on the other side of a boundary.

## 0.7.0 — 2026-09-12

**A `%variable%` written directly inside `{…}` or `[…]` is now spliced as TEXT before the construct
is split** — so a pipe-joined value is a list of options or elements, as it has always been in the
PHP engines. Reported from production: a brand preset
`[<minsize=5;maxsize=7;sep=", ";lastsep=" and ">%CasinoProvidersList%]` over a 57-name runtime
list rendered all 57 names joined with `|` — no size pick, no shuffle, no separators — in 131
published rows across 15 tenants. Minor rather than patch: rendered text changes for every template
of that shape, and `AST_VERSION` moves.

### Fixed

- **The defect.** The tree is built before any value exists, so `[<…>%list%]` was ONE element
  holding a variable node; `resolveVariable` handed a construct-free value back as finished text,
  and the `|` that separates elements in every PHP engine — whose `expand_variables` runs over the
  whole text before any bracket is read — was never seen. Same for `{%list%}`, for `[a|%list%|b]`,
  and for a `#set` or `#def` wrapping the construct.
- **The rule, restated for a tree walk.** The parser keeps a construct's raw body when it holds a
  *direct* reference — at the top level of an option, inside a conditional's branches (the plugin
  resolves `{?…}` before it expands, Stage 6a), or in a separator string (`<sep="%S%">`,
  `a <%S%> |`). At render time such a construct is re-read from its expanded text in the plugin's
  own order: conditionals → expansion → conditionals → parse. Every other construct keeps the tree
  it was parsed into, and with it the RNG order the corpus pins; a spliced value with no structural
  characters re-reads to the same tree, so those renders are unchanged too.
- **The hop budget inside a bracket equals the one outside.** The textual fixpoint runs the
  plugin's own `<= MAX_VARIABLE_DEPTH` — 51 passes, minus the hops a macro re-parse already spent —
  and whatever it leaves is frozen for the whole subtree, so the plugin's 51 hops hold in every
  shape: the mutual cycle leaves `%b%`, `#set %b% = x%b%y` leaves 51 pairs, a 51-deep chain into
  `x|y` reaches the body as text and is split — inside `{…}` as at top level (#57's pins, moved
  inside). **The plural slots now use the same arithmetic.** They ran a flat 50 passes and rendered
  the picked form unfrozen, so a 51-deep alias chain in the count slot erased a block the plugin
  renders, and a 52-deep chain in a form resolved to its end where the plugin leaves `%a52%`.
  Pre-existing, found by the review gate, closed here.

### Changed

- `AST_VERSION` 2 → 3: `EnumerationNode` and `PermutationNode` gained `raw`. A handle from an
  older parser would render the old, wrong output, so the version guard turns it into
  `AstVersionError` — the same reason `#def` bumped it. Nothing persists a handle across versions.
- **Every substitution now charges the expansion budget (#69), as it does in PHP.**
  `resolveVariable` used to charge only construct-bearing values — harmless while a plain value
  could only be a leaf, and the one door left open once a re-read construct could hand it
  references its own fixpoint had cut off: 2^12 references to a 1 KiB value produced 4 MiB out of
  a 1 MiB allowance, and 2^20 is an out-of-memory abort. Found by the review gate before release.
  A template referencing a 65 KB plain list sixteen times now reaches the budget, as it already
  did in PHP; the references past it stay literal.
- **The truncated shape of an expansion bomb is half what it was.** The substitution at the depth
  cap is charged like every other now (it was free), so the 62-character bomb renders 0.57 MB where it
  rendered 1.14 MB. Not parity-gated — the conformance README says what a truncated explosion looks
  like is engine-specific — and the contract holds unchanged: terminates, never throws, bounded output,
  unaffordable references left literal. The hosted MCP server's output cap now stops that bomb at
  variant 4 rather than 2 (its test moved with it).
- `neutralize()` docs: the pipe is deliberately not shielded. A neutralized value the author places
  inside `{…}`/`[…]` is split on its `|` in every engine — this one was immune only by the defect.

### Corpus

Nineteen `splice/*` fixtures in `render-semantics.json`, expected outputs taken from BOTH PHP
engines (docker, real code): the inline permutation, the `#set` wrapper over a runtime list,
literals around the variable, `{%L%}`, a conditional branch carrying the list, a `#def` wrapper
(rolled once, then spliced), `<sep="%S%">`, `lastsep="%S%"` and a per-element `<%S%>`, a macro
value with brackets AND a pipe, three hop-budget pins (a 50-alias chain into `x|y` split on the 51st
hop inside `{…}`, the same chain reaching its number in a plural count slot, a 51-alias chain left
literal in a form), the production
preset shape — and three negatives: a top-level reference is NOT split, an undefined name stays one
literal element, a nested construct splits at its own level only. No prior fixture had a variable
inside a construct, which is how this hid in four tree-walk engines (TS, Python, Object Pascal,
.NET) while the PHP engines were right all along. The siblings fail the new cases until they mirror
the rule.

### Notes

**What stays as it was, on purpose.** Two pre-existing tree-walk divergences in the *non-triggered*
path are unchanged: an element that renders to empty (a nested conditional yielding `''`) is kept
here and dropped by PHP, and PHP's top-level scan splits the fullwidth plural fallback on its pipes.
Both pathological, neither reported. A *triggered* construct drops the empty element as PHP does,
because the text is what PHP sees — and trims a conditional's taken branch at an element's edge,
as the plugin trims after Stage 6a. The fullwidth fallback is the exception in BOTH paths: the plugin
resolves plurals before it reads a bracket, so a fallback's ASCII pipes reach the enclosing construct
there, while here the re-read makes the plural a node again and it renders whole. Only a template
`validate()` already rejects (`plural.arity`, `plural.nested-brackets`) can reach it; recorded in the
conformance README under the known divergences rather than closed (review finding, kept open on
purpose).

**The hop budget, corrected in review.** The first cut gave the fixpoint 50 passes and rendered the
leftover at the depth cap, which spliced it once more as finished text: a 52nd hop when reached through
a macro, and one that hid a structural terminal value from the split (a 51-deep chain into `x|y`
inside `{…}` rendered `x|y`, where the plugin's 51st pass yields `{x|y}` and picks). Now the fixpoint
runs the plugin's own `<= MAX_VARIABLE_DEPTH` — 51 passes, minus the hops a macro re-parse already
spent — and whatever is left is frozen for the whole subtree.

**Verified.** The 0.6.1 build against this one over generated documents (seeded LCG, every
construct, `render` in both post-process modes, `analyze`, `extract`) — the harness first shown to
catch two deliberate control mutations. Documents with no direct reference anywhere: byte-identical,
and `analyze`/`extract` identical on every document. Documents whose constructs DO carry a direct
reference, with plain values and no conditional: byte-identical over 1 788 renders and three seeds —
that is the claim that a spliced value with no structural characters re-reads to the same tree. With
conditionals and construct-bearing definition values allowed, 159 of 922 triggered renders differ, in
exactly the three ways the PHP text has always differed from the old tree: whitespace only (a taken
branch trimmed at an element's edge), an element that became empty dropped before the shuffle (so
every later draw shifts), or a `|` carried in by a rolled `#def`.

## 0.6.1 — 2026-08-19

**The engine no longer throws on deeply nested content** (issue #68). `parse()`, `render()` and
`analyze()` raised `RangeError: Maximum call stack size exceeded` at about 2000 levels of nesting —
a **3.9 KB** template — while §9.2 promises a bad construct comes back as text with fullwidth
braces, never as an exception. No other engine in the family threw.

### Fixed

Three walks recursed once per level of nesting, and each is a frame stack now:

- `parseSequence` — a construct returns a *plan* (its child texts, and how to assemble the node)
  and a stack drives it. The shape mirrors the Python port's `_plan_*` functions, written that way
  from the start for this reason.
- `renderNodes` — the same. **The RNG order is contract and did not move**: an enumeration picks
  before descending, so an unpicked branch never consumes RNG; a permutation renders every element
  first and consumes its own picks after. Seeded renders are reproducible within the engine (§3.2)
  and corpus fixtures pin exact picks with `rng: { sequence }`.
- `walk` (`ast.ts`) — pre-order, children in source order, because `analyze`'s `constructs` counts
  and `refs` order come out of it.

Fixing only the parser would have moved the wall rather than removed it: with parsing iterative,
`render` and `analyze` still threw at ~5000. All three now return at 2 000, 9 000 and 50 000 levels.

`validate()` and `extract()` never threw, which made this worse than it looked — a caller could not
pre-screen for it by validating first.

### Notes

**Output is byte-identical.** 400 generated documents covering every construct, dumped across
parse / extract / validate×2 / analyze / render×2 / neutralize before and after — no difference.
The harness itself was corrected first: of three deliberate control mutations it caught two and
missed one, because the generator never emitted the per-element `[a < or > | b]` separator — which
is precisely the code this release moved. A green that cannot see the changed line is not evidence.

**Deep nesting is still super-linear**, in this engine and in the family: 9 000 levels cost seconds
here where the PHP engine costs 382 ms, because `findMatchingClose`, the inner slice and
`splitTopLevel` each rescan a construct's content once per level. Removing that means threading
spans through five helpers whose separator rules deliberately differ from one another, so it is
recorded rather than guessed at — the same call as #71. Bounding input remains a host job (§9.3);
the reference Worker caps a source at 8192 characters.

`AST_VERSION` is unchanged — the node shape did not move.

## 0.6.0 — 2026-08-18

**`validate()` now emits ONE `variable.circular-reference` per NAME that takes part in, or leads
to, a cycle** — it used to emit one per PATH (issue #59). Minor rather than patch: diagnostic
output visibly changes, though no verdict moves and no API does.

### Fixed

Per-path emission is exponential on a converging diamond, because the number of routes into a
cycle is exponential in the diamond's depth:

| shape | template | before | after |
|---|---|---|---|
| 20 definitions, each referencing the previous one twice, feeding a 2-cycle | **507 B** | **2 097 152 diagnostics, 5.9 s** | **22 diagnostics, 6 ms** |
| the same at depth 200 | 5 KB | (never finished) | 202 diagnostics, ms |
| live `POST /validate-template` | **547 B** | **HTTP 503** | 200, with a verdict |

The second half of the same issue: one cycle of N names printed an N-name route in each of N
messages. A 43 KB template of one giant cycle carried **29 MB of message text**; the route is now
capped at 8 names and becomes a count — `n0 → n1 → … → n7 → … (1992 more)` — which brings that to
200 KB. A real cycle is two to five names and reads exactly as it did.

**Messages are unchanged for every shape a human writes.** The colour walk that already existed as
a prune now also records one witness edge per name, and following those edges reproduces the route
the per-path walk used to print: `a → b → a`, `d0 → c1 → c2 → c1`. Only the duplicates are gone.
`Diagnostic.data` carries `{ name }` so a consumer can group without parsing the message.

### Notes

This reverses a deliberate decision, which is why it is recorded rather than quietly shipped. The
per-path shape was pinned on purpose in three engines' own suites — "an implementation that
deduplicates repeated edges, memoizes per root, or reorders roots goes red here, not silently
green" — and `spintax-win` aligned to it on 2026-08-07. It could not be kept and bounded: re-walking
every route *is* the emission. `spintax-core` (Python) already emitted per name and was the one
engine immune; the rest followed it, and its counts are now the reference — verified by diffing 400
generated definition graphs against it, and against `spintax/core`, with zero mismatches.

Mirrored into `spintax/core` 0.8.0 and the WordPress plugin. The corpus gains a fixture for the
diamond whose real assertion is that the engine *answers*; it cannot gate the count, because
diagnostics are asserted as a subset — and `packages/conformance/README.md` now says that
multiplicity is deliberately not part of the contract.

## 0.5.3 — 2026-08-18

The expansion budget added in 0.5.2 was created per rendered AST, and an `#include` renders one
— so every include handed the bomb a fresh allowance. Fifty `#include` lines over a single
62-character body turned **690 bytes into 57 MB**, growing linearly with the include count: the
bound held for each subtree and bounded nothing overall.

### Fixed

The budget now belongs to the `render()` call and travels on the render context, includes and
all. Measured after: 200 includes over the same body produce 1.14 MB, flat, in about 210 ms —
the same figure one include produces.

A host may cap the number of include resolutions (the reference Worker does), but the engine
must not need it to.

### Notes

Worth stating plainly, since it decides who is exposed: **this needs an untrusted template
author, not untrusted data.** The bomb is built from `#set` definitions, and definitions live in
the template — T1, author-trusted in the §6 model. A context value is T2, and `neutralize()`
strips `%` from it (`%b% %b%` becomes `b b`), so shielded data cannot carry a reference at all.
A host that renders its own templates against user data is not reachable; a host that renders
templates its users write is.

## 0.5.2 — 2026-08-18

**`render()` no longer dies on a 62-character template** (issue #69). Not a regression — the
published 0.3.4 does the same, and so did every engine in the family. Live, this was HTTP 503
from the reference Worker.

### Fixed

```
#set %a% = %b% %b%
#set %b% = %a% %a%
%a%
```

Each expansion replaces one reference with two, so the 50-level depth cap allows 2^50 and the
process ends: an out-of-memory abort here and in the Python port, a memory fatal in both PHP
engines. Acyclic doubling definitions do it too, so the cycle guard never fires. **Any**
reference to such a value reaches it — plain text, a plural slot, an enumeration, a
permutation. Defining the pair is harmless, and a conditional testing one is harmless, because
neither expands the value.

A render may now expand at most 1 MB of `%variable%` text. Past that a reference is left
literal — exactly what an undefined name already does, so no new output shape appears, render
stays lenient (§9.2), and a plural whose count did not resolve erases as it always has. The
ceiling is far above any real document; the point is to end an explosion, not to ration output.

### Notes

**What a truncated explosion looks like is deliberately NOT parity-gated,** and the conformance
README now says so. The engines expand by different mechanisms — a per-reference tree walk here
and in Python, a whole-text fixpoint in both PHP engines — so they stop in different places and
produce different byte counts for the same bomb (1 198 223 against 599 191, measured). What is
contract, and what each engine pins in its own suite, is that render terminates, does not
throw, bounds its output, and leaves what it could not afford as literal `%name%`. Making the
byte counts agree would mean rewriting one engine's expansion to match another's traversal, for
input no author writes.

This is the render-side twin of the counting bomb fixed in 0.5.1; that one bounds `validate()`.

## 0.5.1 — 2026-08-18

Two crashes in the 0.5.0 form-counting path, both reachable from template text, both found by
review rather than by a failing test. **Upgrade from 0.5.0.**

### Fixed

- **A 62-character template could take `validate()` out with an out-of-memory crash.**

  ```
  #set %a% = %b% %b%
  #set %b% = %a% %a%
  {plural 2: one|%a%}
  ```

  Counting plural forms expands definitions, and the expansion was bounded by 51 *passes* with
  nothing bounding the *size*. That template doubles the text on every pass, so 51 passes is 2^51.
  Every engine in the family died on it — this one and the Python port with an out-of-memory
  crash, both PHP engines with a memory fatal. A non-cyclic doubling chain does the same, so the
  circular-reference guard never got a chance.

  The expansion now stops at 64 KB and reports the count as unknowable, which is the same silence
  this validator already uses for every input it cannot pin down. A form list is a handful of
  plural forms; nothing legitimate approaches the ceiling.

  `validate` is exposed by public HTTP surfaces — this was a remote denial of service, not a
  local footgun.

- **`validate()` threw `RangeError` on a long `#set` chain.** The macro walk added in 0.5.0 was
  recursive: roughly 9000 links (a 205 KB template) exhausted the call stack, while the Python
  port gave up at ~1000 links (20 KB) and both PHP engines answered normally — one input, three
  behaviours. The walk is iterative now.

  It is a pre-order depth-first walk in source order, and it has to stay one: the first non-clean
  answer wins, so a graph holding both an opaque macro and a brackety one gives different
  diagnostics depending on which is met first. Checked by leaving the PHP engine recursive and
  diffing 300 generated macro graphs against it — no mismatches.

### Notes

No API change and no verdict change for any template that was not crashing. Both fixes are
mirrored into `spintax/core`, `spintax-core` and the WordPress plugin, and pinned by two corpus
fixtures whose real assertion is that the engine answers at all — a runner that hangs fails them.

## 0.5.0 — 2026-08-18

Two plural fixes, both cross-engine, both found by measuring one engine against another rather
than by a failing test. Minor rather than patch: validation output and render output both change.

### Fixed

- **`validate` counted plural forms before `%variable%` expansion; `render` counts them after**
  (issue #66, found by the Object Pascal port and confirmed in all five engines).

  `#def %tail% = few|many` with `{plural 2: one|%tail%}` under `ru` renders correctly as three
  forms, and every validator reported `plural.arity` for the two it could see in the source. The
  count now substitutes definition values first — every reference per pass, as the renderer does —
  and splits the result.

  Only where the count is **provably invariant**. A value carrying any bracket — all four, and
  conditionals too — suppresses the count-based verdicts rather than guessing: `{a|b}` really does
  always freeze to one form, but `{?flag?a|b|c}` freezes as `a` or as `b|c` and the two cannot be
  told apart without evaluating the construct. Predicting the roll was tried first and produced a
  fresh crop of false errors. Silence on an unknowable input is the trade.

  One case is not a prediction: a `#set` named **directly** in the form slot is substituted
  verbatim and is still spintax when the plural is decided, so its brackets keep earning
  `plural.nested-brackets` — through a `#def` it is rolled first and earns nothing.

- **A conditional in the plural COUNT slot deleted the block, silently.**

  ```
  #set %flag% =
  #set %n% = {?flag?1|2}
  start {plural %n%: one|two} end
  ```

  rendered `start end` — no fallback braces, no diagnostic, `validate` returning `[]`. Both PHP
  engines have always rendered `start two end`: they run the conditional stage over the whole text
  before plurals, so a plain number reaches the slot. This engine expanded variables into the raw
  slot and left constructs literal, so the conditional failed the numeric test and the block was
  erased. `plural.count-macro` exempts conditionals *because* they resolve before plurals — the
  validator was written to a renderer behaviour that was not implemented here.

  The branch is substituted, never rendered: enumerations resolve AFTER plurals, so a branch
  yielding `{a|b}` still reaches the numeric test intact and still erases the block, exactly as the
  plugin does. Rendering it would invent a count no engine has.

  The **form** slot is deliberately untouched. There the engines genuinely disagree — both PHP
  renderers resolve a conditional that expansion introduces inside a form list, this engine and the
  Python one do not — and picking a side is issue #67, not a bug fix.

### Performance

- The count-slot pass is linear and iterative. Written recursively it made `render()` throw
  `RangeError` at ~9000 levels of nesting, breaking the §9.2 promise that render never throws on
  content; matching braces per `{?` made it quadratic, and an unbalanced count slot is legal input
  (only the whole `{plural …}` block has to balance, and the slot is cut at the first `:`), so a
  78 KB template cost 3 seconds. Both were reachable from template text through a public endpoint.
  78 KB now costs 42 ms and 1 MB costs 372 ms.

  Deep *balanced* nesting is still super-linear, in every engine of the family — the reference
  implementation scans the body per level too. Bounding input size is a host job (§9.3); the
  reference Worker now refuses a template over 8192 characters with 413, the same cap the hosted
  MCP server has always applied.

### Notes

Mirrored where each engine needed it: the counting fix into `spintax/core`, the WordPress plugin
and `spintax-core` (Python); the count-slot fix into the Python engine only, the PHP engines
having been right all along. Pinned by 20 new corpus fixtures — 12 for the counting rule, 8 for the
count slot, of which 4 are negative controls — taking the corpus from 235 to 255, green in
TypeScript, Python and both PHP engines.

## 0.4.0 — 2026-08-17

### Added

- **`plural.locale-missing` — a warning where `validate` used to be silent** (issue #65, reported
  from a pipeline rendering ~1000 articles per campaign).

  `validate` files no arity *verdict* without a locale, and that stays: the template may well be
  correct for the locale the host will render with, so failing it here would fail a good template
  for a fact the caller never claimed. But `render` has no such luxury — it resolves against the
  2-form default — so a `{plural …}` block with any other form count reached finished text as the
  fullwidth-brace fallback `｛plural …｝`, with nothing said upfront. Downstream checks that scan
  for `{`/`}` do not see those braces.

  The warning fires only where the risk is: **no locale normalized, and the form count is not the
  render default**. A 2-form block stays silent, because the default resolves it. `valid` is
  unchanged in every case (`valid ⇔ no error-severity diagnostic`), and supplying any locale
  replaces the warning with the real verdict — nothing for `ru`, `plural.arity` for `en`.

  Carries `data: { got, defaultArity }`. The default arity is derived from the same table `render`
  uses rather than written as a literal, so the two cannot come to disagree.

  Mirrored into `spintax/core`, the WordPress plugin and `spintax-core` (Python) in the same
  change, and pinned by a corpus fixture. Note the gate's shape: the shared corpus asserts
  diagnostics as a SUBSET, so it can pin that the warning IS emitted but not that it is absent on
  a 2-form block — that negative control lives in each engine's own suite.

## 0.3.4 — 2026-08-08

Docs-only release — no engine changes; every byte of `dist/` behavior is 0.3.3's.

### Changed

- **README catches up with the ecosystem.** The parity paragraph now states the real contract —
  one syntax surface across five independent engines (npm / Packagist / PyPI / Object Pascal /
  the WordPress plugin) held by the shared 234-fixture corpus — instead of the original
  two-engine wording. New "Using it without writing code" section and refreshed links:
  the [`n8n-nodes-spintax`](https://www.npmjs.com/package/n8n-nodes-spintax) community node
  (released 2026-08-07), the spintax.net playground, the Telegram bot, and Spintax Studio.
  Internal spec-section references dropped from public copy.
- **`package.json`**: description mentions the n8n node; `n8n` added to keywords.

## 0.3.3 — 2026-08-07

`validate()` scales. No output changes anywhere: a 464-document differential over every
definition-graph, diagnostic-position and fuzz shape is byte-identical before and after, and
three deliberate mutations (drop the prune, shift a column, freeze the line counter) each
turn it red — the harness can see what it guards.

### Fixed

- **`validate()` is no longer super-linear on definition graphs — and no longer hangs.** Four
  independent costs, each measured before and after (Node 22, same machine):

  | shape | 0.3.2 | 0.3.3 |
  |---|---|---|
  | chain of 1600 `#set`s | 13.1 s | 18 ms |
  | converging diamond, 20 levels (~1 KB) | 4.8 s | <1 ms |
  | converging diamond, 26+ levels | **never returns** | <1 ms (2000 levels: 22 ms) |
  | one cycle of 1600 | 55.6 s | 0.8 s |
  | 6400 duplicate definitions | 9.3 s | 29 ms |
  | 6400 undefined references | 2.9 s | 11 ms |

  The circular-reference walk re-parsed every value's references at every visit, tested the
  path with an array `includes`, copied the path at every step, and restarted from every
  definition with no memory of silent subtrees — on a converging diamond that re-explored
  shared subgraphs exponentially, so a one-kilobyte template could pin a CPU forever (the
  validator is exposed by hosts; that is a denial-of-service shape, not just a slow one).
  References are now parsed once, the path is a Set plus a shared push/pop array, the walk is
  iterative (a chain as deep as the document cannot overflow the call stack), and one colour
  walk computes up front which names can reach a cycle — a subtree that cannot reach one
  cannot report, so skipping it is output-neutral by construction. Emission order, count and
  messages are exactly the old walk's, duplicated edges and all.

  The taint sweep behind `plural.count-macro` was a fixpoint that re-read every macro once per
  newly tainted name; it is now a reverse-edge worklist computing the same closure. Diagnostic
  positions were each computed by scanning from offset 0; a line-start index built once per
  call now answers them by binary search. And `extractDirectives` counted the line of each
  occurrence from the start of the text — quadratic on directive-heavy documents, and on the
  **render** path too, since the renderer extracts directives the same way; a resuming counter
  fixes both surfaces.

  Two boundaries stay as they are, deliberately. A giant single cycle still costs seconds at
  6400 definitions because the output itself is quadratic — every diagnostic's message carries
  the full cycle path, so ~300 MB of message text is the answer, not the overhead. And a
  converging diamond that FEEDS a cycle still emits one diagnostic per path — exponentially
  many — because that is the reference emission the corpus family just aligned on
  (spintax-win, 2026-08-07); whether that emission should be bounded is a family question, not
  a patch.

Post-process robustness and scaling: `postProcess()` no longer emits its own U+0000 sentinel, and
the placeholder restore is linear instead of quadratic. Output is unchanged on ordinary text; the
two behaviour changes are on shapes that previously produced invalid output (a raw U+0000).

### Fixed

- **`postProcess()` no longer emits a raw U+0000** into the returned text — on input carrying
  none. A URI body runs to the first delimiter, so the URL rule and the `mailto:`/`tel:` rule
  overlap whenever one URI carries the other's scheme, and shielding them in two passes let the
  second run into a placeholder the first had minted:

  ```js
  render('mailto:sales@example.com?body=see%20https://shop.example.com/cart');
  // 'mailto:sales@example.com?body=see%20\x00URL_0\x00'  ← before this release
  ```

  The swallowed key never restored, so the engine returned its own placeholder delimiter: illegal
  in an XML document, replaced with U+FFFD by an HTML parser, rejected by PostgreSQL in
  `text`/`varchar` — and a live key again as soon as an edit detaches it from the `mailto:` prefix
  that was shielding it, at which point the next render substitutes an unrelated URL into the
  contact link. It also silently disabled the linear restore below, whose guard is
  `input.includes('\x00')`.

  The two rules are now **one alternation**, so the leftmost match takes the whole token whichever
  scheme it is. Reordering the passes was the other candidate and is not equivalent: it moves the
  damage onto a URL whose path carries a `mailto:`, where the leading half then loses its trailing
  dot to the punctuation pass. Both directions are fixtures now, the second one negative. U+0000 is
  also excluded from the URI body class, for a caller-supplied one.

  Mirrored into the WordPress plugin engine, and gated by three golden-corpus fixtures — the
  cross-engine contract, so `spintax-php`, `spintax-py` and `spintax-win` inherit the gate.
  ([#53](https://github.com/investblog/spintax-js/issues/53))

### Performance

- **Post-process no longer goes quadratic on shield-heavy text.** The restore step replaced each
  shielded placeholder across the whole text one key at a time — O(text × placeholders) — and
  since URLs, `mailto:`/`tel:` URIs, emails, domains, decimals and abbreviations are all shielded,
  the placeholder count grows with the input. The stage came to dominate the render:

  | input  | `postProcess: false` | before     | after   |
  |--------|----------------------|------------|---------|
  | 47 KB  | 0.007 s              | 0.18 s     | 0.014 s |
  | 189 KB | 0.006 s              | 3.06 s     | 0.057 s |
  | 756 KB | 0.081 s              | **43.9 s** | 0.25 s  |

  A single left-to-right pass replaces the loop, behind a guard on the input. The two are not the
  same function: the loop is a repeated *substring* substitution, so it rewrites every occurrence
  of a key rather than the one the shield placed. Most of the disagreement needs a literal `\x00`
  from the caller, and the guard sends that input to the original loop.

  **One shape survives the guard**, and on it the behaviour changed deliberately: two adjacent
  placeholders can sandwich caller text that spells a key, so one token's closing delimiter, that
  text, and the next token's opening delimiter form a third occurrence of a real key. Rendering
  `https://a.io e.g. URL_0mailto:x@y.io` — no `\x00` anywhere in it — the loop substituted the
  forgery, destroyed two real tokens and returned raw `\x00` bytes; the single pass returns the
  text intact. Measured over 456 976 probes, 12 `\x00`-free inputs distinguish the two restores and
  the loop emits a raw `\x00` on all 12. A corpus fixture now pins the surviving answer, since the
  engines disagreed on it. `npm run bench:postprocess` records the scaling.
  ([#52](https://github.com/investblog/spintax-js/issues/52),
  [#54](https://github.com/investblog/spintax-js/issues/54))

## 0.3.1 — 2026-07-21

Author markup is sanitised in one place, so a handle renders exactly like its source.

### Fixed

- **`render(parse(src))` no longer diverges from `render(src)`** when the template contains an
  author-typed engine sentinel (the reserved range U+E000–U+E005). The strip that keeps stray
  sentinels out of a tree lived at the render entry points, so `parse()` and `analyze(str)` — two
  of the three doors into the parser — skipped it, and the mandatory safety-restore then rewrote
  the author's character into a structural glyph they never wrote:

  ```js
  const src = `a${String.fromCharCode(0xe000)}b`;
  render(src, { postProcess: false }); // "ab"
  render(parse(src), { postProcess: false }); // "a{b"  ← before this release
  ```

  The strip now lives in `parseTemplate`, the single door from author source into an AST, so all
  three entry points agree. `parseSequence` is deliberately **not** sanitised — it re-parses a
  variable's *value*, where sentinels a host `neutralize()`d are legitimate and must survive to the
  restore — and `ParsedAst.source` still keeps the original bytes so diagnostics point at what was
  typed. ([#51](https://github.com/investblog/spintax-js/issues/51))

  Templates that contain no reserved-range characters are unaffected: the strip is a no-op on them.
  The Python port fixed the same defect the same way; the PHP engines never had it (no `parse()`
  handle, no PUA sentinels).

## 0.3.0 — 2026-07-19

`#set` goes back to being a macro and a new `#def` carries roll-once. Breaking: it changes what
existing templates mean. Ships in lockstep with the WordPress plugin 3.0.0, `spintax/core` and the
OpenCart port; the corpus landed last, after both PHP engines.

### Changed

- **`#set` is a macro.** The value is substituted at every `%var%` reference and whatever brackets
  it holds resolve independently each time. Until now an enumeration-valued `#set` collapsed once at
  set-time; that behaviour moved to `#def`.

  Worth recording *why* the revert, because the reasoning is not recoverable from the diff:
  collapse-once was the newcomer. It shipped in the plugin on 2026-07-04, was announced in one
  changelog line, and contradicted the project's published documentation from the day it landed.
  Macro expansion is what the engine did before that and what consumers written against those docs
  assume.

- **`AST_VERSION` 1 → 2.** `ParsedAst` gained `defDefs`. An `Ast` cached by an older version carries
  no definition map, so rendering it would silently drop every `#def`; the version guard turns that
  into an `AstVersionError` instead.

- **`extract()` reports `defs`** alongside `sets`. Additive for readers, but a consumer building a
  variable list from `sets` alone will now miss `#def` names.

- **`plural.nested-brackets` advice.** "Extract via `#set` first" was correct under collapse-once and
  is wrong under a macro — the value is substituted verbatim and puts the brackets straight back into
  the form slot, raising the very error it was meant to avoid. It now says `#def`.

### Added

- **`#def %var% = value` — roll-once.** The value is rendered once per render, as if it were a
  miniature body, and the result is held for every reference. It covers enumerations *and*
  permutations, resolves **after** the merged context exists (so it can read globals and runtime
  variables; a runtime variable of the same name outranks it), and resolves in dependency order —
  an order that follows aliases **through** macro values, since a `#def` can reach another `#def` by
  way of a `#set` expanded only at reference time.

  This is where a plural counter now lives: `#def %n% = {1|4|9}` then `{plural %n%: …}` prints and
  agrees the same number. Under `#set` the two disagree and the block is dropped.

- **Four diagnostics**: `def.malformed`, `definition.duplicate-name` (a name belongs to one
  directive, once — this also closes silently-last-wins duplicate `#set`s), `def.include-in-value`
  (includes resolve after a value is frozen; legal inside a `#set`), and `plural.count-macro`.

  `plural.count-macro` is decided by **stage order, not bracket type**: conditionals resolve before
  plurals and are exempt, enumerations and permutations resolve after and are not, and a nested
  `{plural …}` resolves in the *same* pass so it is not exempt either. Taint propagates through
  `#set` → `#set` references to a fixpoint.

### Corpus

The difference between the directives is a difference in how many RNG draws a render consumes, so
seeded-sequence fixtures pin it exactly and cross-engine — `set/macro-re-rolls-at-every-reference`
and `def/rolled-once-and-held` share a template and a sequence and differ only in whether the second
draw is reached. The corpus grew 138 → 160 cases, green against this engine, the WordPress plugin
and `spintax/core`.

The previous rule here said collapse could only be pinned with RNG-free values, and the consequence
was that **nothing pinned it at all**: the semantics flipped in the plugin without a single fixture
noticing. All-identical alternatives are not sufficient either — they render the same under both
semantics and would pass against an engine implementing `#def` as an alias of `#set`.

### Migration

A `#set` whose value is an enumeration or permutation *and* which is referenced more than once for
consistency — a plural counter, a brand name that must not vary mid-sentence — becomes `#def`. One
line per definition; references are untouched.

## 0.2.0 — 2026-07-18

Serbian, Croatian and Bosnian join the 3-form plural family; the plural error model and the
locale helpers that go with it land in the same release. Minor, not patch: the BCS change
below alters a **validation verdict**, which §0.1 classes as breaking.

Nothing here shipped separately — 0.2.0 was never published, so these additions fold into it
rather than minting a version between them. That matters for `@spintax/authoring-prompt`,
whose peer range `>=0.2.0` would otherwise be satisfiable by a 0.2.0 without the exports it
now imports at runtime.

### Added

- **`pluralArity(locale?)` and `normalizeBaseLang(locale?)` are public.** Exported so a
  consumer that must AGREE with the engine about plurals can ask it instead of keeping a copy
  of the table. The copy is not hypothetical: this repo's own authoring prompt kept one and it
  drifted twice — once in content (a locale added here and not there) and once in shape
  (`locale.slice(0, 2)`, which disagrees with this normalization on any 3-letter tag).

  `pluralArity` takes a RAW locale and normalizes internally, unlike the internal helper of the
  same name — a public function answering 2 for `sr-Latn` would be a trap. Both accept an absent
  locale, matching `RenderOptions.locale?` / `ValidateOptions.locale?`, so the same optional
  value can be threaded straight through.

  Note one asymmetry: an absent locale makes `validate()` skip the arity check entirely, while
  `pluralArity` answers the 2-form default `render()` would apply. It tells you what render will
  do, not what validate will enforce.

  `findPluralBlocks` is deliberately NOT exported alongside them — it returns byte offsets into
  the source, and publishing it would freeze a parser internal and invite consumers onto the
  parse layer, the same reason `Ast` is opaque.

- **`RenderOptions.onPluralError` — an observer for unresolvable `{plural …}` blocks.**
  The port of the plugin's `on_error` callable, and the missing half of its error model:
  this engine already behaved exactly like the plugin's *lenient* mode (arity mismatch and
  nested-bracket errors degrade to fullwidth-brace verbatim, an unresolved count erases the
  block), but there was no way to learn that it had happened.

  Observation only. Output is byte-identical with and without the callback, and `render()`
  still never throws on template content (§9.3) — the host decides whether a report is
  fatal. A report carries the diagnostic `code`, the construct **as the renderer saw it**
  (after variable expansion), the normalized `locale`, and `expected`/`got` for arity.

  The `plural.count` code has no `validate()` counterpart on purpose: an unresolved count is
  a runtime-value fact that static analysis cannot see. It is also the case that most needs
  the seam — erasing leaves no trace, so a host persisting a render otherwise cannot tell an
  unsubstituted `%Var%` from copy that was meant to be empty.

- **BCS plural buckets — `sr`, `hr`, `bs`.** On integers, BCS shares the East-Slavic rule
  character for character (`mod10===1 && mod100!==11` → one; `mod10∈[2,4] && mod100∉[12,14]`
  → few; else → many), so it reuses that branch rather than getting its own. CLDR names the
  third bucket `other` rather than `many` — positionally the same slot. The genuine
  BCS/East-Slavic divergence is fractional-only and unreachable here, since a non-numeric
  count slot is erased to `''` before the bucket math (§3.1).

  **Script and region subtags carry no plural grammar.** `sr-Latn`, `sr-Cyrl` and `sr_RS` all
  normalise to `sr` and pick identical buckets; the script lives only in the author's form text.
  Corpus fixtures pin each form, and the arity fixtures pin that a script subtag does not rescue
  a 2-form template. The ladder runs past two digits, where `mod100` has to beat `mod10`: 101 is
  `one`, 111 is not.

  Render fixtures probe with `sat` (1 sat / 2 sata / 5 sati) because all three buckets differ
  there. The tempting `bonus|bonusa|bonusa` collapses few and other, so it would pass against a
  broken rule.

  Landed in all three engines at once — `@spintax/core`, the WordPress plugin 2.5.0, and
  `spintax/core` 0.2.0 — because plural buckets are a parity-required item and the golden
  corpus gates every engine.

### Changed

- **BREAKING (verdict): `{plural 2: one|many}` under `sr`/`hr`/`bs` is now `plural.arity`.**
  Previously these locales fell through to the EN-style 2-form default, so a 2-form BCS
  template validated clean and rendered from the wrong bucket set. Any existing BCS template
  must grow a third form. No other locale changes behaviour.
- The LLM authoring prompt (`@spintax/authoring-prompt`) now emits a BCS grammar block —
  agreement rules, the 3-bucket warning, and a "do not mix Latin and Cyrillic inside one
  template" rule. Without it a model writes 2-form BCS that the validator then rejects.

## 0.1.6 — 2026-07-13

Two post-process fixes. **Supersedes 0.1.5** — upgrade straight past it. No API change.

### Fixed

- **A run of sentence punctuation is no longer split from the inside.** This is not a Spanish issue
  and it predates the 0.1.5 work: the "space after `.!?`" rule looked exactly one character ahead
  and never at the rest of the run, so it fired *between* the marks.

  ```
  wait... what?   →  Wait. . . What?      (0.1.5 and earlier)
  wow!!!          →  Wow! ! !
  really?!        →  Really? !
  ```

  The ASCII ellipsis is the common casualty — and the Unicode `…` is *not* in the `[.!?]` class,
  which is exactly why the corpus's existing ellipsis fixture never caught it. A run is now matched
  whole and required to be complete: `([.!?]+)(?![.!?])`. The guard is load-bearing — a greedy `+`
  alone gives ground back *into* the run to satisfy the lookaheads and yields `Wow!! !`.

- **`¡¿Qué haces?!` keeps its capital.** The 0.1.5 opener rule allowed exactly *one* opener, so the
  RAE form for a sentence that is both a question and an exclamation — the most Spanish sentence
  there is — still lost its capital. An opener followed by markup (`¿<strong>cómo</strong> estás?`,
  `<p>¿<a href="/ayuda">necesitas ayuda</a>?</p>`) failed for the same reason: the old lead only
  allowed `tags → opener → letter`, never `opener → tags → letter`.

  The lead is now any run of tags, sentence openers and whitespace, in any order. The opener set
  stays deliberately **narrow** — quotes and brackets are still not openers, and the fixtures added
  in 0.1.5 keep guarding that.

### Notes

- Mirrored into the PHP plugin engine (released there as 2.3.3). Verified against the shared golden
  corpus in both engines: TS 243 tests; the conformance runner against the real plugin engine 107
  tests / 120 assertions. No performance regression — the pathological-input cost is unchanged from
  0.1.5 and comes from the URL/domain shields, not from these rules.

## 0.1.5 — 2026-07-13

Spanish post-process fix. No API change.

### Fixed

- **`postProcess` no longer strips the capital from every Spanish sentence.** Spanish is the only
  European language whose punctuation *opens* a sentence, and the capitalization passes upper-cased
  the first **character** after a sentence boundary — which, for `¿cómo estás?`, is `¿`. An inverted
  mark has no uppercase form, so the pass was a no-op and the real first letter stayed lowercase.
  The spacing pass had the mirror-image gap: it knew "no space *before* closing punctuation" but had
  no rule for an opener, so `¿ qué tal ?` only half-collapsed.

  ```
  hola. ¿cómo estás? ¡genial!   →  Hola. ¿Cómo estás? ¡Genial!
  Hola. ¿ qué tal ?             →  Hola. ¿Qué tal?
  ```

  A new `SENTENCE_OPENERS = '¿¡'` concept drives both: an opener binds to the word it opens (before
  capitalization, deliberately), and the four capitalization sites — start of text, after `.!?…`,
  after a block-level tag, and after a newline — allow an optional opener between the boundary and
  the letter. HTML paragraphs and multi-line templates were broken exactly like the bare `. ¿` case.

  The opener set is deliberately **narrow**: quotes and brackets both open *and* close, so
  capitalizing after them would mangle list markers (`Elige una. (a) primero`). Golden-corpus
  fixtures guard both the fix and its narrowness, in **both** engines.

### Notes

- Mirrored into the PHP plugin engine to hold the post-process parity contract. Verified against the
  shared golden corpus in both engines: TS 230 tests; the conformance runner against the real plugin
  engine 99 tests / 112 assertions; the plugin's own suite 578 tests, no regressions.
- The plugin carries the same fix but ships it in a later release, so for a short window a published
  plugin and this package can differ on Spanish output. The parity *contract* holds — the engines'
  behavior agrees and the corpus proves it — only the release timing differs.

## 0.1.4 — 2026-07-13

A post-process bug fix (hit in production) plus docs. No API change.

### Fixed

- **`postProcess` no longer mangles `mailto:` / `tel:` URIs.** They carry no `//` authority,
  so the URL shield missed them; the email shield then carved the address out from under the
  prefix, and the "space after a colon" rule split the leftover into a malformed
  `mailto: contact@example.com` href. They are now shielded as whole tokens (with the same
  trailing-punctuation handling as URLs) before the email/domain passes. Mirrored into the PHP
  engine and covered by 4 golden-corpus fixtures, so the post-process parity contract holds
  in both engines. Reported in [#41](https://github.com/investblog/spintax-js/issues/41).

### Changed

- Docs: a **Use Cases** section (cold email, notifications, chatbots, A/B copy, programmatic
  SEO, spinning LLM-drafted templates locally) and the N-variants recipe — call `render` N
  times with different seeds — with the caveat that distinct seeds are *independent draws, not
  distinct results*, so a low-cardinality template will repeat. Batching stays a host concern.
- npm keywords broadened (`text-spinner`, `email-template`, `placeholders`, `variables`,
  `conditionals`) to match how people actually search for this.

## 0.1.3 — 2026-07-08

Precise diagnostic positions. Backward-compatible — `validate()` verdicts (pass/fail),
codes, and severities are unchanged (still not parity-gated per §3.1); only the
best-effort position fields are improved. No render/parse behavior change.

### Added

- **`validate()` diagnostics now carry accurate `line`/`column` for every code**, not just
  brackets. Previously `plural.*`, `permutation.*`, `set.malformed`, and `include.*` reported
  a line with `column: 1`, and `variable.*` had no position at all (defaulted to `1:1`). All
  now point at the offending token.
- **`endLine`/`endColumn`** are populated so a consumer can underline the exact span (e.g. the
  whole `%name%` reference or `{plural …}` block).
- **Structured `data`** on diagnostics: `variable.undefined` → `{ name }`; `plural.arity` →
  `{ expected, got }`; `permutation.*` → `{ key }` / `{ value }`; `bracket.*` → `{ bracket }` /
  `{ open, close }`; `include.unknown-target` → `{ target }`. Lets a bot/editor build UI without
  parsing the (non-parity-gated) `message`.
- `PluralBlock.end` (internal) — exclusive end offset, so validation can span the full block.

### Notes

- `variable.undefined` still reports **once per unique name**, now anchored at its first
  occurrence. Consumers that want to highlight every occurrence can expand via `data.name`.

## 0.1.2 — 2026-07-08

Docs. No engine or API changes.

### Changed

- **Cross-engine parity is now machine-verified.** The shared golden corpus was executed against
  the actual PHP Spintax plugin engine (via the new `packages/conformance/php` runner) — 88 cases,
  no divergence. Upgraded the README claim from "TS side; PHP execution pending" to parity-verified
  against both engines.

## 0.1.1 — 2026-07-08

Docs + metadata. First release published from CI with **provenance** (npm Trusted Publishing).
No engine or API changes.

### Changed

- npm `keywords` + `description` reworked for discoverability — spintax / text-spinning /
  LLM-authoring workflow; dropped the obscure `gtw` tag.
- README: badges, npm + [301.st](https://301.st) links, and LLM-pairing positioning (draft a
  template with a model once, generate unlimited deterministic variations on-device).

## 0.1.0 — 2026-07-07

First public release. Feature-complete engine; the TS suite passes the full **deterministic**
golden corpus that encodes the Spintax WordPress plugin's behavior contract (validation verdicts,
plural buckets, conditional truthiness, `#set` collapse, post-process output, enum/perm selection).
Cross-engine execution of that corpus by the PHP plugin is the remaining verification gate (see Notes).

### Added

- `parse(input)` — opaque, versioned AST for reuse.
- `render(input, opts)` — seeded, lenient rendering: enumerations, permutations (config +
  per-element separators), variables (recursive), `#set` (collapse-once), conditionals, plurals
  (locale buckets), `#include` (host-injected resolver, scope isolation, circular guard), and the
  12-step cosmetic post-process (URL/email/domain/abbreviation shielding, spacing, capitalization).
  Post-process defaults on; `postProcess: false` yields the raw pick.
- `validate(input, opts)` — diagnostics with a parity-gated verdict (valid ⇔ no `error`);
  `knownIncludes` / `knownVariables` options.
- `extract(input)` — `{ refs, sets, includes }`.
- `analyze(input, opts)` — extract + validate + a best-effort construct census.
- `neutralize(value)` — text-safe shielding of data-derived input, with a mandatory safety-restore.

### Notes

- `render()` is lenient on depth: a circular / too-deep `#include` resolves to `''` (there is
  **no** `MaxDepthExceededError`), matching the plugin. It throws only on a resolver that itself
  throws (`IncludeResolverError`) or a foreign `Ast` (`AstVersionError`) — revised after the
  reference-Worker dogfood surfaced the phantom error export.
- Zero runtime dependencies; ESM-first with dual CJS. Node 18+, Cloudflare Workers, browser.
- Cross-engine RNG-sequence parity with the PHP plugin is a non-goal; only deterministic behavior
  is parity-gated. The PHP-side corpus runner is the remaining cross-engine verification gate.
