import { parse } from '@spintax/core';

import { renderOp, type RenderOpOptions } from './render';

/**
 * Lint of RENDERED text — the defect class `validate()` structurally cannot see.
 *
 * `validate()` judges the template. A template can be flawless and still emit broken
 * text, because the defect lives in the *combination of choices*: two adjacent slots
 * happen to pick the same word, a noun from one slot meets a relative pronoun from
 * another and they disagree in gender, an unlucky join leaves a space before a comma.
 * None of it is visible in the source, and none of it survives a human reading of the
 * source — it only appears in some renders. A pool of a thousand documents cannot be
 * proofread, so the failure mode is not "we make mistakes" but "we cannot see them".
 *
 * Two boundaries, stated rather than hidden:
 *
 * - **Skip what cannot be judged.** Russian gender is guessed from the ending, and a
 *   soft sign is ambiguous (`путь` masculine, `тень` feminine) — those words are skipped
 *   instead of guessed. A wrong complaint teaches people to ignore the tool.
 * - **Case agreement inside a slot is not machine-checkable** and stays the author's job
 *   (grammar-safe synonymization). Lint removes the mechanical half, not the craft.
 */

export type LintCode =
  | 'repeat.word'
  | 'agreement.relative'
  | 'punctuation.double-space'
  | 'punctuation.space-before'
  | 'punctuation.duplicated'
  | 'punctuation.empty-pair';

export interface LintFinding {
  code: LintCode;
  /** Human-readable; NOT a contract — branch on `code`/`data`, never on this. */
  message: string;
  /** The offending text with a little context around it. */
  fragment: string;
  data?: Record<string, string | number>;
}

export interface LintOpOptions {
  /** BCP-47 tag. Only the language-neutral rules run for a locale with no rule table. */
  locale?: string;
  /**
   * WIDTH of the scanned word window, so 6 catches repeats up to 5 words apart. Six is
   * the number that worked on a real pool: at nine, 82% of the hits were ordinary
   * cohesion ("Обучение и стратегии" in a heading and "ветка стратегий" in the body is
   * not a defect); at six every hit was real.
   */
  window?: number;
}

export interface LintOpResult {
  clean: boolean;
  findings: LintFinding[];
  locale: string;
  window: number;
}

export const LINT_DEFAULT_WINDOW = 6;
export const LINT_SAMPLE_DEFAULT_COUNT = 50;
export const LINT_SAMPLE_MAX_COUNT = 500;

// ── Locale rule tables ───────────────────────────────────────────────────────

/**
 * Function words whose repetition is normal and says nothing about a defect. A locale
 * with no table falls back to the length filter alone, which is weaker but never
 * invents a rule for a language we have not looked at.
 */
const STOP_WORDS: Record<string, readonly string[]> = {
  ru: [
    'и', 'а', 'но', 'не', 'на', 'в', 'с', 'по', 'о', 'об', 'от', 'до', 'из', 'за', 'то',
    'как', 'что', 'чем', 'же', 'ли', 'бы', 'у', 'к', 'для', 'при', 'без', 'это', 'все',
    'уже', 'ещё', 'где', 'кто', 'так', 'там', 'тут', 'или', 'если', 'когда', 'чтобы',
  ],
  en: [
    'that', 'this', 'with', 'from', 'have', 'has', 'had', 'will', 'would', 'could',
    'should', 'they', 'them', 'their', 'there', 'these', 'those', 'your', 'yours',
    'about', 'which', 'when', 'what', 'were', 'been', 'into', 'than', 'then', 'some',
    'more', 'most', 'just', 'like', 'also', 'only', 'even', 'very', 'much', 'each',
    'over', 'after', 'before', 'while', 'because', 'here',
  ],
};

/** Forms of «который» by gender. Plural agreement is deliberately not checked. */
const RU_RELATIVE = new Map<string, Gender>([
  ['который', 'm'], ['котором', 'm'], ['которого', 'm'], ['которому', 'm'], ['которым', 'm'],
  ['которая', 'f'], ['которой', 'f'], ['которую', 'f'], ['которою', 'f'],
  ['которое', 'n'],
]);

type Gender = 'm' | 'f' | 'n';

const GENDER_NAME: Record<Gender, string> = {
  m: 'masculine',
  f: 'feminine',
  n: 'neuter',
};

/**
 * Russian gender from the ending. A heuristic, but a deliberately incomplete one:
 * `-а/-я` feminine, `-о/-е` neuter, a consonant masculine — and a soft sign returns
 * NOTHING, because `путь` is masculine and `тень` is feminine and the ending cannot
 * tell them apart. Silence beats a wrong complaint.
 */
export function guessGenderRu(word: string): Gender | null {
  if (/[ая]$/u.test(word)) return 'f';
  if (/[ое]$/u.test(word)) return 'n';
  if (/ь$/u.test(word)) return null;
  if (/[бвгджзклмнпрстфхцчшщй]$/u.test(word)) return 'm';
  return null;
}

/** A shared prefix of sufficient length ⇒ almost certainly one word in two forms. */
export function sameRoot(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 6) return false;
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= Math.max(5, n - 3);
}

/** Tags out, punctuation to space, lowercase — hyphens survive as part of a word. */
export function lintWords(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function languageOf(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? '').toLowerCase();
}

// ── One document ─────────────────────────────────────────────────────────────

export function lintOp(text: string, opts: LintOpOptions = {}): LintOpResult {
  const locale = opts.locale ?? 'en';
  const language = languageOf(locale);
  const window = Math.max(2, Math.trunc(opts.window ?? LINT_DEFAULT_WINDOW));
  const stop = new Set(STOP_WORDS[language] ?? []);
  const words = lintWords(text);

  const findings: LintFinding[] = [];
  findings.push(...repeatFindings(words, window, stop));
  if (language === 'ru') findings.push(...relativeAgreementFindings(words, stop));
  findings.push(...punctuationFindings(text, language));

  return { clean: findings.length === 0, findings: dedupe(findings), locale, window };
}

/** Two slots landing on the same word — or the same word in two forms nearby. */
function repeatFindings(words: string[], window: number, stop: Set<string>): LintFinding[] {
  const out: LintFinding[] = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i]!;
    if (stop.has(first) || first.length < 4) continue;
    for (let k = i + 1; k < Math.min(words.length, i + window); k++) {
      const second = words[k]!;
      if (stop.has(second)) continue;
      if (!sameRoot(first, second)) continue;
      out.push({
        code: 'repeat.word',
        message: `"${first}" and "${second}" repeat ${k - i} words apart`,
        fragment: `…${words.slice(Math.max(0, i - 2), k + 3).join(' ')}…`,
        data: { first, second, distance: k - i },
      });
      break;
    }
  }
  return out;
}

/**
 * «сюжет, в которой…» — the noun and the relative pronoun disagree in gender.
 *
 * The class spintax produces especially readily: the noun comes from one slot and the
 * subordinate clause from another, and each option is correct on its own. Measured on a
 * live pool, `{тема|сюжет|материя}` next to `{где|в которой}` put "сюжет, в которой"
 * into 18% of the articles — caught by a human noticing a screenshot, because no check
 * existed. Only the nearest noun to the left is examined (one preposition may sit in
 * between), and an unjudgeable ending ends the search rather than widening it.
 */
function relativeAgreementFindings(words: string[], stop: Set<string>): LintFinding[] {
  const out: LintFinding[] = [];
  for (let i = 0; i < words.length; i++) {
    const pronounGender = RU_RELATIVE.get(words[i]!);
    if (!pronounGender) continue;
    for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
      const noun = words[k]!;
      if (stop.has(noun)) continue;
      const nounGender = guessGenderRu(noun);
      if (!nounGender) break;
      if (nounGender !== pronounGender) {
        out.push({
          code: 'agreement.relative',
          message: `"${noun} … ${words[i]}" — ${GENDER_NAME[nounGender]} noun with a ${GENDER_NAME[pronounGender]} relative pronoun`,
          fragment: `…${words.slice(Math.max(0, k - 1), i + 3).join(' ')}…`,
          data: {
            noun,
            pronoun: words[i]!,
            nounGender: GENDER_NAME[nounGender],
            pronounGender: GENDER_NAME[pronounGender],
          },
        });
      }
      break;
    }
  }
  return out;
}

/** Debris an unlucky join leaves behind. Checked on the text, tags removed. */
function punctuationFindings(text: string, language: string): LintFinding[] {
  const plain = text.replace(/<[^>]+>/g, '');
  const out: LintFinding[] = [];

  const add = (code: LintCode, message: string, match: RegExpMatchArray | null): void => {
    if (!match) return;
    out.push({ code, message, fragment: context(plain, match.index ?? 0, match[0].length) });
  };

  add('punctuation.double-space', 'two or more spaces in a row', plain.match(/ {2,}/u));
  // French typography puts a (narrow no-break) space before ; : ! ? — flagging it there
  // would be complaining about correct text, so only , and . are checked for fr.
  const beforeClass = language === 'fr' ? /\s[,.]/u : /\s[,.;:]/u;
  add('punctuation.space-before', 'space before punctuation', plain.match(beforeClass));
  // `,,` is always debris; `...` is an ellipsis an author may well have meant, so only
  // a broken run of dots (two, or four and up) counts.
  add(
    'punctuation.duplicated',
    'punctuation repeated by an unlucky join',
    plain.match(/([,;:])\1|(?<!\.)\.{2}(?!\.)|\.{4,}/u),
  );
  add('punctuation.empty-pair', 'empty brackets or quotes', plain.match(/\(\s*\)|«\s*»|“\s*”/u));

  return out;
}

function context(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 20);
  const to = Math.min(text.length, index + length + 20);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

function dedupe(findings: LintFinding[]): LintFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.code} ${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── A sample of renders from one template ────────────────────────────────────

export interface LintSampleOptions extends LintOpOptions, Omit<RenderOpOptions, 'seed' | 'locale'> {
  /** Renders to draw and lint. Clamped to 1–500. */
  count?: number;
  /** Attempt *i* renders with seed `${baseSeed}:${i}` — the Render Many derivation. */
  baseSeed?: number | string;
}

export interface LintIssueTally {
  code: LintCode;
  /** Documents (of `checked`) this exact finding appeared in. */
  count: number;
  sample: LintFinding;
}

export interface LintSampleResult {
  checked: number;
  /** Documents with no findings at all. */
  cleanCount: number;
  /** `cleanCount / checked`, rounded to four decimals — the number that moves as you fix slots. */
  cleanRatio: number;
  issues: LintIssueTally[];
  locale: string;
  window: number;
}

/**
 * Render N documents from one template and tally what the lint finds. This is the
 * authoring-time loop: a real template scored 2% clean over 200 renders on its first
 * pass, and 100% after the slots the lint pointed at were fixed.
 */
export function lintSampleOp(template: string, opts: LintSampleOptions = {}): LintSampleResult {
  const checked = clamp(
    Math.trunc(opts.count ?? LINT_SAMPLE_DEFAULT_COUNT),
    1,
    LINT_SAMPLE_MAX_COUNT,
  );
  const ast = parse(template);
  const lintOptions: LintOpOptions = {
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(opts.window !== undefined ? { window: opts.window } : {}),
  };

  const tally = new Map<string, LintIssueTally>();
  let cleanCount = 0;
  let locale = opts.locale ?? 'en';
  let window = LINT_DEFAULT_WINDOW;

  for (let i = 0; i < checked; i++) {
    const rendered = renderOp(ast, {
      ...(opts.context !== undefined ? { context: opts.context } : {}),
      ...(opts.baseSeed !== undefined ? { seed: `${opts.baseSeed}:${i}` } : {}),
      ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
      ...(opts.postProcess !== undefined ? { postProcess: opts.postProcess } : {}),
    });
    const result = lintOp(rendered, lintOptions);
    locale = result.locale;
    window = result.window;
    if (result.clean) {
      cleanCount++;
      continue;
    }
    for (const finding of result.findings) {
      const key = `${finding.code} ${finding.message}`;
      const existing = tally.get(key);
      if (existing) existing.count++;
      else tally.set(key, { code: finding.code, count: 1, sample: finding });
    }
  }

  return {
    checked,
    cleanCount,
    cleanRatio: Math.round((cleanCount / checked) * 10000) / 10000,
    issues: [...tally.values()].sort((a, b) => b.count - a.count),
    locale,
    window,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
