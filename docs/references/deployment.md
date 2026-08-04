# Deployment & Publishing

> Part of the [Harness documentation system](../../CLAUDE.md). Edit this file for release workflow guidance.

## Branch Model

| Branch    | Purpose                             | Protection                                            | npm tag        |
| --------- | ----------------------------------- | ----------------------------------------------------- | -------------- |
| `master`  | Stable and rc releases only         | PR required, no force push, no deletion, admin bypass | `latest`, `rc` |
| `nightly` | Active development (default branch) | None                                                  | `nightly`      |

PRs target `nightly` by default. Stable releases are promoted from `nightly` to `master` via PR.

Every stable and rc tag needs a matching section in [`CHANGELOG.md`](../../CHANGELOG.md) before the tag is pushed — CI uses it as the GitHub Release body.

## Release Channels

| Trigger                       | Version shape | npm dist-tag | GitHub Release  |
| ----------------------------- | ------------- | ------------ | --------------- |
| `vX.Y.Z` tag on `master`      | `X.Y.Z`       | `latest`     | yes             |
| `vX.Y.Z-rc.N` tag on `master` | `X.Y.Z-rc.N`  | `rc`         | yes, prerelease |
| push to `nightly`             | stamped       | `nightly`    | no              |

The tag must equal `v` + the `package.json` version or CI aborts before publishing. Prerelease versions other than `-rc.N` have no lane and fail the classify step. The stable publish step re-checks the tag and the version independently and refuses to run if either contains a hyphen, so an rc can never take `@latest`.

## Install Channels

Relay hub and node roles use the same npm package and the same `relay-ide` binary. See [Relay Hub/Node Packaging Decision](../RELAY_HUB_NODE_PACKAGING.md) for the command contract.

```bash
# Stable (recommended)
npm install -g relay-ide
relay-ide hub

# Release candidate (stable-shaped, not yet promoted)
npm install -g relay-ide@rc
relay-ide hub

# Nightly (latest dev build)
npm install -g relay-ide@nightly
relay-ide hub
```

Nodes install the same package and use `relay-ide node ...`; there is no separate `relay-ide-node` package or npm tag.

## Release Paths

### 1. Normal Development (nightly)

Feature branches merge into `nightly`. Every push to `nightly` auto-publishes a nightly build.

```
feature-branch → PR → nightly → auto-publish as nightly
```

Nightly versions are stamped automatically: `3.18.1-nightly.20260328.42`

#### Nightly PR release gate

Before merging a `nightly` PR, verify that the latest PR head SHA matches the SHA tested by QA and approved by review. Treat bot comments that arrive after review as stale-evidence invalidators until they are triaged as blocker, follow-up, or noise.

For security/platform PRs, machine-resolvable valid bot blockers should create a fix lane and refreshed QA/review evidence before final merge. After merge to `nightly`, confirm the publish workflow succeeds and `relay-ide@nightly` resolves to the new prerelease version when the PR is expected to publish.

### 2. Stable Release

Version bump on nightly, PR to master, then tag. Direct pushes to master are
blocked — all commits must arrive via PR.

```bash
# 1. Bump version on nightly (no tag yet) and close the CHANGELOG section
git checkout nightly
npm version <patch|minor|major> --no-git-tag-version
# move [Unreleased] entries into a new ## [3.19.0] - YYYY-MM-DD section in CHANGELOG.md
git add package.json package-lock.json CHANGELOG.md
git commit -m "3.19.0" && git push origin nightly

# 2. Create and merge a release PR
gh pr create --base master --head nightly --title "v3.19.0"
gh pr merge --merge

# 3. Tag on master and push (tags bypass branch protection)
git checkout master && git pull
git tag v3.19.0
git push origin v3.19.0          # CI publishes to npm @latest

# 4. Sync master back to nightly
git checkout nightly && git merge master && git push origin nightly
```

### 3. Hotfix (skip nightly)

For critical bugfixes that need to ship immediately without going through nightly.

```bash
# 1. Branch off master, fix, and PR
git checkout master && git pull
git checkout -b hotfix/fix-description
# ... make fix, commit ...
gh pr create --base master
gh pr merge --merge

# 2. Bump version on master via another PR
git checkout master && git pull
git checkout -b hotfix/bump-version
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "3.19.1" && git push origin hotfix/bump-version
gh pr create --base master --title "v3.19.1"
gh pr merge --merge

# 3. Tag and push
git checkout master && git pull
git tag v3.19.1
git push origin v3.19.1          # CI publishes to npm @latest

# 4. Sync the fix back to nightly
git checkout nightly && git pull
git merge master && git push origin nightly
```

### 4. Release Candidate (soak before stable)

Same promotion path as a stable release, but the version carries an `-rc.N` prerelease and the tag publishes to `@rc`. Use it when a release needs real-install soak time before it becomes the default install.

```bash
# 1. Bump to the rc version on nightly and stage the CHANGELOG section
git checkout nightly
npm version 3.20.0-rc.1 --no-git-tag-version
# CHANGELOG.md keeps a ## [3.20.0] section; the rc release body reuses it
git add package.json package-lock.json CHANGELOG.md
git commit -m "3.20.0-rc.1" && git push origin nightly

# 2. Promote to master and tag
gh pr create --base master --head nightly --title "v3.20.0-rc.1"
gh pr merge --merge
git checkout master && git pull
git tag v3.20.0-rc.1
git push origin v3.20.0-rc.1     # CI publishes to npm @rc

# 3. Soak, then promote: bump to 3.20.0 and follow the Stable Release path.
#    Further candidates are -rc.2, -rc.3, ... on the same base version.
```

The rc tag must be on `master` like any stable tag, and `@latest` is never touched by an rc.

## What CI Does

Stable, rc, and nightly publishing are handled by a single workflow (`publish.yml`), triggered by either a `v*` tag push or a push to `nightly`.

**On `v*` tag push (stable or rc):**

1. Checks out the tagged commit
2. Verifies tag is on `master` branch (fails otherwise)
3. Verifies the tag equals `v` + the `package.json` version, then classifies it: no suffix means `latest`, `-rc.N` means `rc`, any other prerelease shape fails
4. Builds and runs tests
5. Publishes with `npm publish --provenance --access public`, adding `--tag rc` on the rc lane. The stable step independently refuses any hyphenated tag or version, so a prerelease cannot reach `@latest`
6. Creates a GitHub Release (marked prerelease for rc) with the matching `CHANGELOG.md` section as the body

**On push to `nightly`:**

1. Checks out the commit
2. Stamps a prerelease version: `<base>-nightly.YYYYMMDD.<run>`
3. Builds and runs tests
4. Publishes with `npm publish --provenance --access public --tag nightly`

### CI Setup (one-time)

1. Create a GitHub environment called `release` in the repo (Settings > Environments)
2. On npmjs.com, configure **trusted publishing** for `relay-ide` with:
   - Workflow filename: `publish.yml`
   - Environment name: `release`

## Pre-Release Checklist (stable and rc)

1. All tests pass: `npm test`
2. Build succeeds: `npm run build`
3. No uncommitted changes: `git status` is clean
4. `CHANGELOG.md` has a dated section for the release version, and `[Unreleased]` is drained
5. Version bumped on `nightly` with `npm version --no-git-tag-version`
6. PR from `nightly` to `master` created and merged
7. Tag created on `master` and pushed, matching `v` + the `package.json` version (triggers CI publish)
8. `master` merged back into `nightly` to sync

## What Gets Published

Controlled by the `files` field in `package.json`:

- `dist/bin/` -- Compiled CLI entry point, including `relay-ide hub` and `relay-ide node` subcommands behind the single `relay-ide` npm binary
- `dist/server/` -- Compiled server modules
- `dist/frontend/` -- Frontend SPA

TypeScript source, test files, docs, and local config are excluded from the published package.

## Verifying a Release

```bash
npm pack --dry-run                            # preview what will be included
npm info relay-ide                            # check stable version
npm info relay-ide dist-tags                  # check all dist-tags (latest, rc, nightly)
npm install -g relay-ide@rc                   # test rc install
npm install -g relay-ide@nightly              # test nightly install
gh release view v3.20.0                       # confirm the release body matches CHANGELOG.md
```

After an rc soak, confirm `npm info relay-ide dist-tags` still shows the previous stable under `latest` — the rc lane must never move it.
