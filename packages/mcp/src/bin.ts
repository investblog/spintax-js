#!/usr/bin/env node
/**
 * `spintax-mcp` — the executable an MCP client starts.
 *
 * Everything that could write to stdout happens BEFORE the transport attaches a
 * stdin handler: `--help` and `--version` print and return, an unknown flag prints
 * to stderr and exits 2. Once serving begins, stdout carries protocol JSON and
 * nothing else (see stdio.ts).
 */

import type { IncludeSupport } from './call-tool';
import { createDispatcher } from './dispatch';
import { createIncludeRoot } from './include-root';
import { parseArgs } from './args';
import { serveStdio } from './stdio';
import { buildTools } from './tools';
import { VERSION } from './version';

const INSTRUCTIONS_BASE =
  'Spintax template tools backed by @spintax/core, the reference engine. ' +
  'validate_spintax returns diagnostics with line/column; render_spintax produces seeded ' +
  'variants; analyze_spintax reports variables, directives and construct counts. ';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), process.env, VERSION);
  if (parsed.kind === 'print') {
    process.stdout.write(`${parsed.text}\n`);
    return;
  }
  if (parsed.kind === 'fail') {
    process.stderr.write(`spintax-mcp: ${parsed.message}\n`);
    process.exitCode = 2;
    return;
  }
  const { args } = parsed;

  let include: IncludeSupport | undefined;
  if (args.includeRoot !== undefined) {
    const root = createIncludeRoot({
      root: args.includeRoot,
      maxIncludeBytes: args.maxIncludeBytes,
      maxDepth: args.maxDepth,
    });
    // Fail fast, before serving: an unusable root is a configuration mistake, and
    // discovering it on the first tools/call would look like a template problem.
    if (root.kind === 'fail') {
      process.stderr.write(`spintax-mcp: ${root.message}\n`);
      process.exitCode = 2;
      return;
    }
    include = root.support;
  }

  const dispatcher = createDispatcher({
    serverInfo: { name: 'spintax-local', title: 'spintax (local)', version: VERSION },
    instructions:
      INSTRUCTIONS_BASE +
      (include
        ? '#include resolves against the server\'s --include-root directory. '
        : '#include has no resolver here: an #include line is left in the output verbatim. ') +
      'Docs: https://spintax.net/llms.txt (Markdown mirrors of every page).',
    tools: buildTools({ maxVariants: args.maxVariants, include: include ? 'root' : 'disabled' }),
    limits: { maxVariants: args.maxVariants },
    ...(include ? { include } : {}),
    maxDepth: args.maxDepth,
  });

  const server = serveStdio(message => dispatcher.dispatch(message), {
    maxLineChars: args.maxMessageChars,
  });

  // EOF is the primary and only portable shutdown signal (the spec says so, and
  // Windows clients cannot deliver SIGTERM at all). These handlers are for a human
  // running the server in a terminal.
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const onSignal = (): void => server.stop();
  for (const signal of signals) process.on(signal, onSignal);

  // Set the code and return: letting Node exit on its own drains stdout, where
  // process.exit() would truncate the last response. Releasing the two handles that
  // outlive the loop — the signal listeners and the stdin reader — is what lets the
  // runtime reach that exit instead of idling with nothing left to do.
  process.exitCode = await server.done;
  for (const signal of signals) process.off(signal, onSignal);
  process.stdin.pause();
}

void main();
