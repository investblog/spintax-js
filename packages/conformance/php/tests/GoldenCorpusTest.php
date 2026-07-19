<?php
/**
 * Golden-corpus parity runner (PHP side).
 *
 * Runs the shared language-neutral fixtures (`packages/conformance/fixtures/*.json`,
 * the SAME files the TS `@spintax/core` suite consumes) through the PHP Spintax
 * plugin's WP-free Core engine, and asserts the fixtures' expected values. Green
 * here + green in TS = the deterministic parity contract is machine-verified in
 * BOTH engines, not just assumed from source-reading.
 *
 * The render path replicates the plugin `Renderer::process_template` stage order
 * (Renderer.php:240-331) using the WP-free primitives directly, so it can run
 * without WordPress AND honour the corpus's `postProcess:false` cases (the plugin's
 * own process_template always post-processes + always applies wp_kses_post, neither
 * of which is the parity target).
 *
 * @package Spintax\Conformance
 */

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Spintax\Core\Engine\Parser;
use Spintax\Core\Engine\Validator;
use Spintax\Core\Engine\Conditionals;
use Spintax\Core\Engine\Plurals;

final class GoldenCorpusTest extends TestCase
{
    /** @return array<string, array{0: array<string,mixed>}> */
    public static function corpusProvider(): array
    {
        $dir = getenv('SPINTAX_FIXTURES');
        if ($dir === false || $dir === '') {
            $dir = __DIR__ . '/../../fixtures';
        }
        $cases = [];
        foreach (glob(rtrim($dir, '/\\') . '/*.json') as $file) {
            $data = json_decode((string) file_get_contents($file), true);
            if (!is_array($data)) {
                continue;
            }
            foreach ($data as $case) {
                // `engines` absent => both engines; otherwise run only if 'php' is listed.
                $engines = $case['engines'] ?? null;
                if (is_array($engines) && !in_array('php', $engines, true)) {
                    continue;
                }
                $cases[$case['id']] = [$case];
            }
        }
        return $cases;
    }

    /**
     * @dataProvider corpusProvider
     * @param array<string,mixed> $c
     */
    public function test_corpus(array $c): void
    {
        switch ($c['op']) {
            case 'validate':
                $this->runValidate($c);
                break;
            case 'extract':
                $this->runExtract($c);
                break;
            case 'render':
                $this->runRender($c);
                break;
            case 'neutralize':
                // TS-specific: @spintax/core restores literal glyphs; the plugin
                // entity-encodes and never decodes (§6). Such fixtures are engines:["ts"].
                $this->markTestSkipped('neutralize is a TS-only divergence (entity vs glyph)');
                break;
            default:
                $this->markTestSkipped("unknown op: {$c['op']}");
        }
    }

    // ── validate ─────────────────────────────────────────────────────────────

    /** @param array<string,mixed> $c */
    private function runValidate(array $c): void
    {
        $result = (new Validator())->validate(
            $c['template'],
            $c['knownIncludes'] ?? [],
            $c['knownVariables'] ?? [], // global var names — suppress undefined warnings
            $c['locale'] ?? ''
        );
        $verdict = empty($result['errors']) ? 'valid' : 'invalid';

        // Verdict is the parity gate. Diagnostic `code`s are a TS-side surface — the
        // plugin's diagnostics carry human messages, not machine codes (§3.1) — so
        // the corpus's per-diagnostic codes are intentionally NOT asserted here.
        $this->assertSame($c['expect']['verdict'], $verdict, "verdict for {$c['id']}");
    }

    // ── extract ──────────────────────────────────────────────────────────────

    /** @param array<string,mixed> $c */
    private function runExtract(array $c): void
    {
        $parser = new Parser();
        $expect = $c['expect'];
        $asserted = false;

        if (array_key_exists('sets', $expect)) {
            $sets = array_keys($parser->extract_set_directives($c['template'])['variables']);
            $this->assertSameSet($expect['sets'], $sets, "sets for {$c['id']}");
            $asserted = true;
        }
        if (array_key_exists('includes', $expect)) {
            $includes = array_map(
                static fn(array $d): string => $d['slug'],
                $parser->find_include_directives($c['template'])
            );
            $this->assertSameSet($expect['includes'], $includes, "includes for {$c['id']}");
            $asserted = true;
        }
        if (array_key_exists('refs', $expect)) {
            // Refs aren't a public engine API; replicate the Validator regexes
            // (%(\w+)% + {?[!]VAR?}) over the #set-stripped body.
            $body = $parser->extract_set_directives($c['template'])['body'];
            $this->assertSameSet($expect['refs'], $this->extractRefs($body), "refs for {$c['id']}");
            $asserted = true;
        }
        if (!$asserted) {
            $this->markTestSkipped("no PHP-checkable extract expectation for {$c['id']}");
        }
    }

    /** @return string[] */
    private function extractRefs(string $text): array
    {
        $refs = [];
        if (preg_match_all('/%(\w+)%/', $text, $m)) {
            foreach ($m[1] as $r) {
                $refs[strtolower($r)] = true;
            }
        }
        if (preg_match_all('/\{\?!?([A-Za-z_]\w*)\?/', $text, $m)) {
            foreach ($m[1] as $r) {
                $refs[strtolower($r)] = true;
            }
        }
        return array_keys($refs);
    }

    // ── render (replicates Renderer::process_template, WP-free) ───────────────

    /** @param array<string,mixed> $c */
    private function runRender(array $c): void
    {
        $isRng = ($c['kind'] ?? 'deterministic') === 'rng';
        // Deterministic cases inject the fixture's rng strategy for an exact output.
        // rng-kind cases assert structural invariants only (cross-engine RNG-sequence
        // parity is a non-goal, §3.2), so a fixed 'first' selection is enough.
        $strategy = $isRng ? 'first' : ($c['rng'] ?? 'first');
        $out = $this->renderPipeline(
            $c['template'],
            $c['context'] ?? [],
            $c['locale'] ?? '',
            $this->rng($strategy),
            $c['postProcess'] ?? true
        );

        if (!$isRng) {
            $this->assertSame($c['expect']['output'], $out, "render {$c['id']}");
            return;
        }

        $e = $c['expect'];
        if (isset($e['oneOf'])) {
            $this->assertContains($out, $e['oneOf'], "oneOf for {$c['id']}");
        }
        if (isset($e['subsetOf']) || isset($e['sizeRange'])) {
            $sep = $e['separator'] ?? ' ';
            $tokens = $out === '' ? [] : explode($sep, $out);
            if (isset($e['subsetOf'])) {
                foreach ($tokens as $t) {
                    $this->assertContains($t, $e['subsetOf'], "subsetOf for {$c['id']}");
                }
                // Permutations draw without replacement ⇒ distinct tokens.
                $this->assertSame(count($tokens), count(array_unique($tokens)), "distinct for {$c['id']}");
            }
            if (isset($e['sizeRange'])) {
                $this->assertGreaterThanOrEqual($e['sizeRange'][0], count($tokens), "sizeRange min {$c['id']}");
                $this->assertLessThanOrEqual($e['sizeRange'][1], count($tokens), "sizeRange max {$c['id']}");
            }
        }
    }

    /**
     * Replicates `Renderer::process_template` (Renderer.php:240-331) on the WP-free
     * primitives, stopping at (or before) post_process — never wp_kses_post (§2.2).
     *
     * @param array<string,string> $context
     */
    private function renderPipeline(string $template, array $context, string $locale, callable $rng, bool $postProcess): string
    {
        $parser = new Parser($rng);
        $conditionals = new Conditionals();
        $plurals = new Plurals();

        // Stage 3: strip comments (:240)
        $text = $parser->strip_comments($template);

        // Stage 4: extract #set and #def directives.
        $extracted = $parser->extract_directives($text);
        $text = $extracted['body'];
        $setVars = $extracted['set']; // names already lowercased

        // Stage 4c: merge — runtime context overlays local #set (runtime wins), keys lowercased.
        $runtime = [];
        foreach ($context as $k => $v) {
            $runtime[strtolower((string) $k)] = $v;
        }
        $vars = array_merge($setVars, $runtime);

        // Stage 5b: roll #def values ONCE, against the merged context. A #set value is left raw —
        // it is a macro, substituted at every reference, and its brackets re-roll each time.
        //
        // This is a REIMPLEMENTATION, not a call: the engines' roll lives in a private method of a
        // host-bound class (the plugin's Renderer needs get_locale/wp_kses_post), which is exactly
        // why this file drives the WP-free primitives. That makes it a third place the stage order
        // is written down — keep it in step with both engines when the order changes.
        $vars = array_merge($vars, $this->rollDefinitions($extracted, $vars, $runtime, $locale, $parser, $conditionals, $plurals));

        // Stage 6a: conditionals, pre variable-expansion (:291)
        $text = $conditionals->apply($text, $vars);
        // Stage 6b: expand variables (:294)
        $text = $parser->expand_variables($text, $vars);
        // Stage 6c: conditionals, post variable-expansion (:299)
        $text = $conditionals->apply($text, $vars);
        // Stage 6d: plurals, lenient (:307-310)
        $text = $plurals->apply($text, $locale, ['lenient' => true]);
        // Stage 7: enumerations (:313)
        $text = $parser->resolve_enumerations($text);
        // Stage 8: permutations (:316)
        $text = $parser->resolve_permutations($text);
        // Stage 9: #include / [spintax] (:328) — host-injected; the corpus render cases
        //          don't require WP template lookups, so this stage is skipped.
        // Stage 10: post_process (:331) — the parity target, unless postProcess:false.
        if ($postProcess) {
            $text = $parser->post_process($text);
        }
        // Stage 11: wp_kses_post (:334) — a WP sink concern (§2.2), deliberately NOT applied.
        return $text;
    }

    /**
     * Render each `#def` value once, in dependency order, and return the frozen results.
     *
     * Mirrors `Renderer::roll_definitions()` / `render_definition_value()`. Ordering comes from
     * the engine's own `Parser::order_definitions()` rather than a fourth copy of that logic —
     * the alias map is every macro value a definition can see, minus the definitions that will
     * actually be rolled (a runtime-outranked one is left in, because the runtime value is what
     * really gets substituted).
     *
     * @param array<string,mixed>  $extracted `extract_directives()` output.
     * @param array<string,string> $vars      Merged context.
     * @param array<string,string> $runtime   Runtime context, which outranks every local.
     * @return array<string,string>
     */
    private function rollDefinitions(
        array $extracted,
        array $vars,
        array $runtime,
        string $locale,
        Parser $parser,
        Conditionals $conditionals,
        Plurals $plurals
    ): array {
        $definitions = $extracted['def'];
        if ($definitions === []) {
            return [];
        }

        $aliases = array_diff_key($vars, array_diff_key($definitions, $runtime));
        $rolled = [];

        foreach ($parser->order_definitions($definitions, $aliases) as $name) {
            if (array_key_exists($name, $runtime)) {
                continue;
            }

            $visible = array_merge($vars, $rolled);
            $value = $conditionals->apply($definitions[$name], $visible);
            $value = $parser->expand_variables($value, $visible);
            $value = $conditionals->apply($value, $visible);
            $value = $plurals->apply($value, $locale, ['lenient' => true]);
            $value = $parser->resolve_enumerations($value);
            $rolled[$name] = $parser->resolve_permutations($value);
        }

        return $rolled;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Deterministic RNG matching the plugin's make_first / make_last / make_sequence. */
    private function rng($strategy): callable
    {
        if ($strategy === 'last') {
            return static fn(int $min, int $max): int => $max;
        }
        if (is_array($strategy) && isset($strategy['sequence'])) {
            $seq = $strategy['sequence'];
            $i = 0;
            return static function (int $min, int $max) use ($seq, &$i): int {
                $last = count($seq) - 1;
                $value = $seq[min($i, $last)] ?? $min;
                ++$i;
                return max($min, min($max, (int) $value));
            };
        }
        // 'first' (and default)
        return static fn(int $min, int $max): int => $min;
    }

    /**
     * @param string[] $expected
     * @param string[] $actual
     */
    private function assertSameSet(array $expected, array $actual, string $message): void
    {
        sort($expected);
        sort($actual);
        $this->assertSame($expected, $actual, $message);
    }
}
