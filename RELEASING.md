# Releasing `@spintax/core` (plus `n8n-nodes-spintax`, `@spintax/mcp` and `@spintax/authoring-prompt` — see the last three sections)

Releases publish from GitHub Actions (`.github/workflows/release.yml`) using npm
**Trusted Publishing (OIDC)** — no npm token is used for any established package (the one
exception is the first publish of a NEW package, which has no Trusted Publisher entry yet —
see the `@spintax/mcp` and `@spintax/authoring-prompt` sections), and every release
carries a **provenance** attestation linking the published tarball to the exact repo,
commit, and workflow run.

## One-time setup on npmjs.com (required before the first CI release)

Do this once, as a maintainer of the package:

1. Go to **npmjs.com → `@spintax/core` → Settings → Trusted Publisher**.
2. Choose **GitHub Actions** and fill in:
   - **Organization or user:** `investblog`
   - **Repository:** `spintax-js`
   - **Workflow filename:** `release.yml`
   - **Environment:** *(leave blank)*
3. Save. From now on the workflow can publish without a token, and npm will reject
   publishes that don't come from this exact repo + workflow.

> Trusted Publishing needs npm ≥ 11.5.1; the workflow upgrades npm before publishing.
> Provenance requires a **public** repo and package (both are public).

## Cutting a release

```sh
# 1. Bump the version (choose one)
npm version patch -w @spintax/core   # 0.1.0 -> 0.1.1
npm version minor -w @spintax/core   # 0.1.0 -> 0.2.0

# 2. Update packages/core/CHANGELOG.md with the new version + notes

# 3. Commit + tag (tag MUST match the new package version)
git add -A && git commit -m "release(core): @spintax/core X.Y.Z"
git tag -a vX.Y.Z -m "@spintax/core X.Y.Z"

# 4. Push the branch/commit and the tag
git push origin main
git push origin vX.Y.Z
```

Pushing the `vX.Y.Z` tag triggers `release.yml`, which builds, tests, verifies the tag
matches the package version, and publishes with provenance. You can also trigger it
manually from the Actions tab (**workflow_dispatch**) after tagging.

## Verifying a release

- The npm page shows a **“Provenance”** section with the source commit and build.
- `npm view @spintax/core` reflects the new version.
- `npm audit signatures` (in a project that installed it) verifies the attestation.

## Notes

- The engine ships zero runtime dependencies; the published tarball is `dist/` + docs
  (see `packages/core/package.json` `files`). `prepack`/`prepublishOnly` rebuild + test
  as a backstop even outside CI.
- `@spintax/*` is owned via the `spintax` npm account (username = scope). Every package needs
  its own Trusted Publisher entry pointing at its own publish workflow: `@spintax/core` and
  `@spintax/mcp` have theirs; `@spintax/authoring-prompt`'s is pending its first publish (see
  its section — do not remove `NPM_TOKEN` from its workflow before 0.1.0 is out); a further
  package (`@spintax/conformance`, `@spintax/cli`) would need one too.

## Releasing `n8n-nodes-spintax`

Same machinery, own workflow (`.github/workflows/release-n8n.yml`), own tag prefix —
`n8n-node-vX.Y.Z` — so it never collides with core's `v*` glob. Provenance is not
optional here: n8n requires GitHub-Actions provenance for community nodes published
after May 2026.

One-time setup (the `@spintax/core` entry does NOT cover this package):
**npmjs.com → `n8n-nodes-spintax` → Settings → Trusted Publisher → GitHub Actions**,
org `investblog`, repo `spintax-js`, workflow `release-n8n.yml`.

```sh
npm version patch -w n8n-nodes-spintax
git add -A && git commit -m "release(n8n-node): n8n-nodes-spintax X.Y.Z"
git tag -a n8n-node-vX.Y.Z -m "n8n-nodes-spintax X.Y.Z"
git push origin main && git push origin n8n-node-vX.Y.Z
```

After each publish, run the exact-version community scan (it needs the PUBLISHED
release — it verifies npm provenance, so it cannot run pre-publish or in CI) via the
**`Scan n8n package` workflow** (Actions → workflow_dispatch, input = version).
Not locally on Windows: the scanner's tar treats the `C:` drive prefix as a remote
host and dies on extraction — that cost a false red on 0.1.0. A green scan gates the
n8n verification submission (see `docs/spec-n8n-node.md` §4). Scanner facts learned
on 0.1.x: it lints BOTH the tarball and the attested source checkout with n8n's own
ruleset (stricter than `eslint-plugin-n8n-nodes-base` — e.g. `author` must be an
object with a non-empty `email`), and the first publish of a NEW package cannot use
Trusted Publishing (the entry requires an existing package) — bootstrap with a
granular token in the `NPM_TOKEN` repo secret, then flip to OIDC.

## Releasing `@spintax/mcp`

Same machinery, own workflow (`.github/workflows/release-mcp.yml`), own tag prefix —
`mcp-vX.Y.Z`.

**The version lives in two files.** `packages/mcp/src/version.ts` is a build-time
constant, deliberately not a runtime read of the manifest (that would drag `node:fs`
toward the entry the Cloudflare Function imports). `test/artifact.test.ts` asserts the
two agree, so forgetting one fails the suite rather than shipping a server that
misreports itself in `initialize` and in every result's `_meta`.

```sh
npm version patch -w @spintax/mcp   # then edit packages/mcp/src/version.ts to match
# update packages/mcp/CHANGELOG.md
git add -A && git commit -m "release(mcp): @spintax/mcp X.Y.Z"
git tag -a mcp-vX.Y.Z -m "@spintax/mcp X.Y.Z"
git push origin main && git push origin mcp-vX.Y.Z
```

The Trusted Publisher entry is **in place since 2026-08-17** (npmjs.com →
`@spintax/mcp` → Settings → Trusted Publisher → GitHub Actions, org `investblog`, repo
`spintax-js`, workflow `release-mcp.yml`), so releases from `0.1.1` on need no token.

**`0.1.0` was the exception, and it is the same trap the n8n node hit:** a Trusted
Publisher entry cannot precede the first publish — there is no package to attach it to
— so it went out on the `NPM_TOKEN` repo secret, with provenance coming from
`id-token: write` + `--provenance` rather than from trusted publishing. The two
follow-up steps (create the entry, then delete the `env: NODE_AUTH_TOKEN` block from
the publish step) are **done**. Keep this paragraph for the next new package: the
sequence is publish-then-connect, never the other way round.

Verify with the client, not just the registry: the tarball smoke
(`npm run smoke:pack:mcp`) installs the package and drives the real `bin` over stdio,
which is the only check that covers the shebang, the `bin` field, the exports map and
resolution of `@spintax/core` as a dependency from the built artifact — the four
things a first-`bin` package actually breaks on.

**When the engine moves, bump `dependencies["@spintax/core"]` in the same wave.** The range
is a real dependency, not a bundle, so leaving it on the previous major-zero range does not
merely lag — npm installs that older engine *underneath* `packages/mcp`, and the package is
then tested against an engine nobody is shipping. `test/artifact.test.ts` fails on exactly
that, and it is there because it happened. The smoke packs `@spintax/core` locally rather
than pulling it from the registry, so a range naming an unpublished version is not a
chicken-and-egg problem: release core first, and this gate is green the whole way through.

## Releasing `@spintax/authoring-prompt`

Same machinery, own workflow (`.github/workflows/release-prompt.yml`), own tag prefix —
`prompt-vX.Y.Z`. First release: 0.1.0 (2026-08-21,
[#75](https://github.com/investblog/spintax-js/issues/75)), so a pipeline can import the
prompt instead of copying its text.

**Two version numbers, deliberately.** The package version is semver over the exported API.
`PROMPT_VERSION` (`src/index.ts`) is the version of the prompt TEXT — bump it when a wording
change can change model output, because consumers assert it and conformance reports are
filed under it (`conformance/reports/`). A wording change is therefore two bumps; an API
change that leaves the text alone is one. No test ties them together, on purpose.

```sh
npm version patch -w @spintax/authoring-prompt   # NOT for 0.1.0 — see below
# update packages/authoring-prompt/CHANGELOG.md (and PROMPT_VERSION if the text moved)
git add -A && git commit -m "release(authoring-prompt): @spintax/authoring-prompt X.Y.Z"
git tag -a prompt-vX.Y.Z -m "@spintax/authoring-prompt X.Y.Z"
git push origin main && git push origin prompt-vX.Y.Z
```

**The bootstrap release skips the bump.** The manifest already says `0.1.0` and its CHANGELOG
entry is written; the first release is only `git tag -a prompt-v0.1.0` on that commit and a
push of the tag. Running `npm version patch` first would produce `0.1.1`, the workflow would
accept `prompt-v0.1.1` perfectly happily, and 0.1.0 would never exist.

**Trusted Publisher status: pending the first publish.** `0.1.0` goes out on the `NPM_TOKEN`
repo secret, exactly as `@spintax/mcp` 0.1.0 did (see above: publish-then-connect, never
the other way round). Provenance still applies. The follow-up, once `npm view
@spintax/authoring-prompt version` answers:

- [ ] npmjs.com → `@spintax/authoring-prompt` → Settings → Trusted Publisher → GitHub
      Actions, org `investblog`, repo `spintax-js`, workflow `release-prompt.yml`;
- [ ] delete the `env: NODE_AUTH_TOKEN` block from the publish step in
      `release-prompt.yml` and tick these boxes.

Verify with a consumer, not just the registry: the tarball smoke
(`npm run smoke:pack:prompt`) installs the package next to a locally packed
`@spintax/core`, builds a real prompt, validates every example the prompt teaches from
under a 3-form locale, and asserts the engine it resolved is the one packed — the one
thing a peer-dependency package breaks on that build and test cannot see.

**`@spintax/core` is a PEER, and the range (`>=0.2.0`) is open above on purpose.** The
prompt reads two things from the engine — `pluralArity` and `normalizeBaseLang` — and
must agree with the engine the host validates with, which a peer guarantees and a nested
dependency would not. When a core release changes what those two answer (a locale added
to the 3-form table, a normalization rule), cut a prompt release in the same wave and say
so in its CHANGELOG; the smoke packs core locally, so the pair is provable before either
is on npm.
