---
type: decision
status: accepted
tags: [syntax, include, neutralize, render]
issues: ["#93"]
---

# 0002 — Where an `#include` line may come from

**Date:** 2026-10-19. **Status:** accepted by the owner 2026-10-19 — option B.

## Context

#93: a `#include` line is recognised **after** variable substitution, so a context value can complete a
directive the template only started:

```js
render('a\n#%v% "foo"\nb', { context: { v: neutralize('include') }, includeResolver: … })
// → "A\nINCLUDED\nB"   (the value is data; expected "A\n#include "foo"\nB")
```

`neutralize()` cannot help: the value carries only letters, and `neutralize()` shields structural
characters (`{ } [ ] % #`). It does shield `#`, so a neutralized value cannot **start** a directive on its
own — only complete one whose `#` the template wrote.

The decision recorded for this wave was the narrow one: *directive lines are decided from the source*;
#78 (a `%var%` directly inside `{…}`/`[…]` is spliced as text) stays.

### What reading the code changed

- `#set` and `#def` lines **are already** decided from the source: `extractDirectives` runs on the
  template text before any substitution. A value cannot create a definition.
- `#include` is different **on purpose.** It is resolved by a text pass over the rendered body
  (`resolveIncludes`, the plugin's Stage 9), so any line the body renders to can be an include line —
  whether it came from the template, a `#set` value, a `#def` value or an enumeration option.
- The **verdicts** are narrower than that behaviour: `validate/include-in-set-value-is-valid` accepts
  `#set %x% = #include "y"` + a line `%x%`, while `def.include-in-value` rejects the same through `#def`
  ("includes resolve after the value is frozen"). The render path is lenient and resolves both today
  (measured: `#def %x% = #include "y"⏎%x%` reaches the resolver). The corpus pins only the verdicts —
  it cannot pin an include render at all: the fixture schema has no include bodies (ADR 0001 adds
  `includes`).
- So "decide `#include` from the source, before substitution" **breaks the documented `#set` use** — it
  cannot be done as written.
- Related, unpinned: `#include "%slug%"` takes its **ref** from a value and works today; `extract()`
  reports the literal `%slug%`, so the two-phase prefetch (spec §4.1) cannot see it.

### Measured (2026-10-19)

Over 3 560 stored documents of the family's own products: **0** `#include` lines of any shape. `#%var%`
occurs 3 times, always mid-line (`license #%LicenseNumber%`), never at a line start.

## Options

**A. Origin tracking: a runtime value may not supply any part of the `#include` keyword.** Author text
(the template, `#set` and `#def` values, include bodies, enumeration options) can still compose include
lines, so the lenient render keeps resolving an all-author `#def` include — and the verdicts stay as they
are (`#set` valid, `#def` an error); a `context` value cannot. Correct, but the renderer loses a value's origin as soon as it is spliced, so every engine needs a
mark that survives the tree walk and is invisible to every pass that reads values — plural counts, the
#90 first-code-point read of a list element, the #78 splice, conditional truthiness — in six engines.
The largest change for the smallest measured exposure.

**B. Decline the engine change; document the limit.** State in spec §6 (the `neutralize()` contract) and
in the corpus README's limits: *`neutralize()` shields a value against starting a construct; it does not
stop a value from completing one the template started — a template that writes `#%v%` at a line start
hands the keyword to the value.* Pin the current behaviour with `includes` fixtures (ADR 0001's schema
extension), so a port that differs is visible — the whole keyword from a value (`#%v% "foo"`), part of it
(`#inc%v% "foo"` with `v = "lude"`), transitively (`#%outer% "foo"` through a `#set`), and the dynamic ref
that stays allowed (`#include "%slug%"`) — and close #93 with the measurement. Cost: one paragraph and
four fixtures.

**C. A validator warning** on a line that starts `#` + `%var%`. It fails this repo's lint-vs-verdict
boundary (*what belongs in the engine*): it has to guess what the author meant — `#%n%` at a line start
is also an ordinary heading-less list number. Lint at most, in a host.

## Recommendation

**B.** The exposure needs a template that writes a variable into the directive keyword, there is no such
template in the stored content, and A costs a cross-engine mechanism in exactly the places (counts,
separators, splice) where the family has paid for parity before. Keep `#include "%slug%"` working as it
does, and document in §4.1 that a ref built from a value is invisible to `extract().includes` — the host
prefetching includes must resolve such refs itself.

If the owner prefers A, it becomes its own ADR with a design for the mark, after #92 ships.
