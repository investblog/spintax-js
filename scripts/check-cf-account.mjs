#!/usr/bin/env node
/**
 * Refuse to deploy a Worker to the wrong Cloudflare account.
 *
 * This exists because of a real incident (2026-07-20). `wrangler` was authenticated as one
 * account while both Workers actually live on another. `wrangler deploy` would not have failed
 * — it would have CREATED a second `spintax-bot` on the wrong account: no secrets, no webhook
 * pointing at it, therefore dead, while the live bot kept running the old code. The command
 * reports success, so nothing tells you the deploy went nowhere. Ten minutes of confusion later
 * the only clue was `versions list` saying the Worker did not exist.
 *
 * Pinning `account_id` in wrangler.toml is the primary guard — wrangler then errors on an
 * account the credentials cannot reach. This script is the readable half: it names the account
 * you are on, the account you need, and what to do about it, instead of a 10007 API error.
 *
 * Usage: node scripts/check-cf-account.mjs <dir-with-wrangler.toml>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-cf-account.mjs <dir-with-wrangler.toml>');
  process.exit(2);
}

const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
const expected = /^\s*account_id\s*=\s*"([0-9a-f]{32})"/mu.exec(toml)?.[1];
const worker = /^\s*name\s*=\s*"([^"]+)"/mu.exec(toml)?.[1] ?? dir;

if (!expected) {
  console.error(
    `✘ ${dir}/wrangler.toml has no account_id.\n` +
      '  Pin it — without it wrangler silently picks the only account the credentials can see,\n' +
      '  which is how a deploy lands on the wrong account and still reports success.',
  );
  process.exit(1);
}

let actual = '';
try {
  // `whoami` prints a table; the account id is the only 32-hex token in it.
  const out = execFileSync('npx', ['wrangler', 'whoami'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // npx is npx.cmd on native Windows
  });
  actual = /\b[0-9a-f]{32}\b/u.exec(out)?.[0] ?? '';
} catch {
  console.error(
    '✘ `wrangler whoami` failed — no credentials.\n' +
      '  Set CLOUDFLARE_API_TOKEN in this directory\'s .env (see DEPLOYING.md).\n' +
      '  Do NOT run `wrangler login` — it is global and would repoint every other project\n' +
      '  on this machine.',
  );
  process.exit(1);
}

if (actual !== expected) {
  console.error(
    `✘ Wrong Cloudflare account for ${worker}.\n` +
      `  authenticated as: ${actual || '(none)'}\n` +
      `  ${worker} lives on: ${expected}\n\n` +
      '  Deploying now would CREATE a second, secret-less copy on the wrong account and report\n' +
      '  success, while the live Worker kept serving the old code.\n\n' +
      '  Fix: set CLOUDFLARE_API_TOKEN for the owning account in this directory\'s .env.\n' +
      '  NOT `wrangler login` — that is global and would repoint every other project here.\n' +
      '  See DEPLOYING.md.',
  );
  process.exit(1);
}

console.log(`✓ ${worker} → account ${expected}`);
