# Deployment & Publishing

> Part of the [Harness documentation system](../../CLAUDE.md). Edit this file for release workflow guidance.

## Branch Model

| Branch | Purpose | Protection | npm tag |
|--------|---------|------------|---------|
| `master` | Stable releases only | PR required, no force push, no deletion, admin bypass | `latest` |
| `nightly` | Active development (default branch) | None | `nightly` |

PRs target `nightly` by default. Stable releases are promoted from `nightly` to `master` via PR.

## Install Channels

```bash
# Stable (recommended)
npm install -g claude-remote-cli

# Nightly (latest dev build)
npm install -g claude-remote-cli@nightly
```

## Three Release Paths

### 1. Normal Development (nightly)

Feature branches merge into `nightly`. Every push to `nightly` auto-publishes a nightly build.

```
feature-branch → PR → nightly → auto-publish as nightly
```

Nightly versions are stamped automatically: `3.18.1-nightly.20260328.42`

### 2. Stable Release

Version bump on nightly, PR to master, then tag. Direct pushes to master are
blocked — all commits must arrive via PR.

```bash
# 1. Bump version on nightly (no tag yet)
git checkout nightly
npm version <patch|minor|major> --no-git-tag-version
git add package.json package-lock.json
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

## What CI Does

Both stable and nightly publishing are handled by a single workflow (`publish.yml`), triggered by either a `v*` tag push or a push to `nightly`.

**On `v*` tag push (stable):**

1. Checks out the tagged commit
2. Verifies tag is on `master` branch (fails otherwise)
3. Builds and runs tests
4. Publishes with `npm publish --provenance --access public` (tag: `latest`)

**On push to `nightly`:**

1. Checks out the commit
2. Stamps a prerelease version: `<base>-nightly.YYYYMMDD.<run>`
3. Builds and runs tests
4. Publishes with `npm publish --provenance --access public --tag nightly`

### CI Setup (one-time)

1. Create a GitHub environment called `release` in the repo (Settings > Environments)
2. On npmjs.com, configure **trusted publishing** for `claude-remote-cli` with:
   - Workflow filename: `publish.yml`
   - Environment name: `release`

## Pre-Release Checklist (stable only)

1. All tests pass: `npm test`
2. Build succeeds: `npm run build`
3. No uncommitted changes: `git status` is clean
4. Version bumped on `nightly` with `npm version --no-git-tag-version`
5. PR from `nightly` to `master` created and merged
6. Tag created on `master` and pushed (triggers CI publish)
7. `master` merged back into `nightly` to sync

## What Gets Published

Controlled by the `files` field in `package.json`:

- `dist/bin/` -- Compiled CLI entry point
- `dist/server/` -- Compiled server modules
- `dist/frontend/` -- Frontend SPA

TypeScript source, test files, docs, and local config are excluded from the published package.

## Verifying a Release

```bash
npm pack --dry-run                            # preview what will be included
npm info claude-remote-cli                    # check stable version
npm info claude-remote-cli dist-tags          # check all dist-tags (latest, nightly)
npm install -g claude-remote-cli@nightly      # test nightly install
```
