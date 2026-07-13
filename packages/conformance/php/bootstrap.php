<?php
/**
 * Standalone (WordPress-free) bootstrap for the golden-corpus parity runner.
 *
 * The plugin's Core engine classes (Parser / Validator / Conditionals / Plurals)
 * are pure PHP — they only require the `defined('ABSPATH')` guard to be satisfied.
 * We autoload them straight from the plugin source (no wp-env / MySQL needed) and
 * drive the WP-free primitives directly (see tests/GoldenCorpusTest.php).
 *
 * @package Spintax\Conformance
 */

declare(strict_types=1);

// Engine files start with `defined('ABSPATH') || exit;` — satisfy it.
if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

require __DIR__ . '/vendor/autoload.php'; // PHPUnit

// Locate the plugin engine source: Spintax\ -> <src>. Override with SPINTAX_PLUGIN_SRC.
$src = getenv('SPINTAX_PLUGIN_SRC');
if ($src === false || $src === '') {
    $src = __DIR__ . '/../../../../spintax/plugin/src'; // default: sibling checkout ../spintax
}
$src = rtrim(str_replace('\\', '/', $src), '/');

if (!is_dir($src)) {
    fwrite(STDERR, "\nSpintax plugin source not found at:\n  {$src}\n"
        . "Set SPINTAX_PLUGIN_SRC to the plugin's `src` directory, e.g.\n"
        . "  SPINTAX_PLUGIN_SRC=/path/to/spintax/plugin/src vendor/bin/phpunit\n\n");
    exit(1);
}

// PSR-4, for either of the two PHP engines this runner can drive:
//
//   - the WordPress plugin maps `Spintax\` -> src/, so a class lands at src/Core/Engine/Parser.php
//     (this mirrors the plugin's own autoloader in spintax.php);
//   - the `spintax/core` Composer package maps `Spintax\Core\` -> src/, so the same class lands at
//     src/Engine/Parser.php.
//
// Trying both means one runner certifies both engines against the same corpus, which is the whole
// point of having a corpus.
spl_autoload_register(static function (string $class) use ($src): void {
    if (strncmp($class, 'Spintax\\', 8) !== 0) {
        return;
    }

    $candidates = [$src . '/' . str_replace('\\', '/', substr($class, 8)) . '.php'];

    if (strncmp($class, 'Spintax\\Core\\', 13) === 0) {
        $candidates[] = $src . '/' . str_replace('\\', '/', substr($class, 13)) . '.php';
    }

    foreach ($candidates as $file) {
        if (is_file($file)) {
            require $file;
            return;
        }
    }
});
