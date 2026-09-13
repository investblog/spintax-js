/**
 * A map from variable name to value that answers only for the names put into it.
 *
 * Names come from the template and from the host, and a plain `{}` answers for two it was never
 * given: `map['constructor']` is `Object` and `map['__proto__']` is `Object.prototype`, while assigning
 * `__proto__` a string changes nothing at all. Both names match `\w+`, and every lookup lower-cases, so
 * `%CONSTRUCTOR%` reached them too. In 0.7.0 `%constructor%` threw `TypeError` out of `render()`,
 * `{?__proto__?yes|no}` took `yes`, `#set %__proto__% = x` was lost, and the validator counted plural
 * forms in Object's source text — where both PHP engines, reading arrays, see two ordinary names.
 *
 * With no prototype, a lookup finds only what was stored and `__proto__` is stored like any other key.
 * `{ ...a, ...b }` would build an ordinary object again, so maps are merged here, by a loop:
 * `Object.assign` into a map with no prototype took five times what the spread did, once per `#def`.
 */
export function nameMap(...sources: readonly Readonly<Record<string, string>>[]): Record<string, string> {
  const map = Object.create(null) as Record<string, string>;
  for (const source of sources) {
    for (const name of Object.keys(source)) map[name] = source[name] as string;
  }
  return map;
}
