# Releasing `@spintax/core`

Releases publish from GitHub Actions (`.github/workflows/release.yml`) using npm
**Trusted Publishing (OIDC)** — no npm tokens are stored anywhere, and every release
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
- `@spintax/*` is owned via the `spintax` npm account (username = scope). Additional
  packages (`@spintax/conformance`, `@spintax/cli`) would each need their own Trusted
  Publisher entry pointing at their publish workflow.
