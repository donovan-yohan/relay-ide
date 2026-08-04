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

Nightly versions are stamped automatically: `0.1.0-nightly.20260803.794`

#### Nightly PR release gate

Before merging a `nightly` PR, verify that the latest PR head SHA matches the SHA tested by QA and approved by review. Treat bot comments that arrive after review as stale-evidence invalidators until they are triaged as blocker, follow-up, or noise.

For security/platform PRs, machine-resolvable valid bot blockers should create a fix lane and refreshed QA/review evidence before final merge. After merge to `nightly`, confirm the publish workflow succeeds and `relay-ide@nightly` resolves to the new prerelease version when the PR is expected to publish.

### 2. Release Candidate (soak before stable)

Same promotion path as a stable release, but the version carries an `-rc.N` prerelease and the tag publishes to `@rc`. Use it when a release needs real-install soak time before it becomes the default install. Anything larger than a one-line fix should go out as an rc first.

| Aspect         | Rule                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| Version shape  | `X.Y.Z-rc.N` — the target stable version plus the candidate number, starting at `1` |
| Tag            | `vX.Y.Z-rc.N`, on `master` like any stable tag                                      |
| npm dist-tag   | `rc`. `latest` is never touched                                                     |
| Changelog      | the `## [X.Y.Z]` section for the target stable version; there is no `-rc.N` section |
| GitHub Release | cut and marked prerelease                                                           |
| Next steps     | another `-rc.N+1` with fixes, or promote by bumping to plain `X.Y.Z`                |

```bash
# 1. Bump to the rc version on nightly and stage the CHANGELOG section
git checkout nightly
npm version 0.2.0-rc.1 --no-git-tag-version
# CHANGELOG.md keeps a ## [0.2.0] section; the rc release body reuses it
git add package.json package-lock.json CHANGELOG.md
git commit -m "0.2.0-rc.1" && git push origin nightly

# 2. Promote to master and tag
gh pr create --base master --head nightly --title "v0.2.0-rc.1"
gh pr merge --merge
git checkout master && git pull
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1      # CI publishes to npm @rc
```

#### Prerelease-never-latest guard

Three independent checks keep an rc off `@latest`, so no single mistake can promote one by accident:

1. The classify step aborts unless the tag equals `v` + the `package.json` version.
2. It then routes `-rc.N` to the `rc` lane and fails any other prerelease shape (`-beta.1`, `-next.1`, bare `-rc`) outright — those have no lane.
3. The stable publish step re-reads the tag and the version and refuses to run if either contains a hyphen, regardless of what classify decided.

The rc publish step passes `--tag rc` explicitly, so even a successful rc publish leaves `latest` where it was. Confirm this after every rc:

```bash
npm dist-tag ls relay-ide        # latest must still be the previous stable
```

If `latest` did move, re-point it before anything else: `npm dist-tag add relay-ide@<previous-stable> latest`.

#### Dogfood gate before stable

An rc is not promoted until it has run the prod hub (`relay-stable-hub.service`, port `3456`), which uses the bun global install.

```bash
bun add -g relay-ide@rc
node -p "require(process.env.HOME + '/.bun/install/global/node_modules/relay-ide/package.json').version"
systemctl --user restart relay-stable-hub.service
curl -s http://127.0.0.1:3456/healthz
```

Confirm the printed version is the rc before claiming the deploy landed — installing through the wrong package manager or prefix updates files the service does not run (see [`devbox-hub-deploy.md`](./devbox-hub-deploy.md)). Then use it for real work: a channel round trip with a streamed agent reply, a DM, a thread, search, and whatever the release's headline changelog entries claim. A hub that boots is not a hub that works.

Rollback is one command, because `latest` was never touched:

```bash
bun add -g relay-ide@latest
systemctl --user restart relay-stable-hub.service
```

Record the outcome, then cut `-rc.N+1` with the fixes or promote to stable.

### 3. Stable Release

Version bump on nightly, PR to master, then tag. Direct pushes to master are
blocked — all commits must arrive via PR.

```bash
# 1. Bump version on nightly (no tag yet) and close the CHANGELOG section
git checkout nightly
npm version <patch|minor|major> --no-git-tag-version
# move [Unreleased] entries into a new ## [0.2.0] - YYYY-MM-DD section in CHANGELOG.md
git add package.json package-lock.json CHANGELOG.md
git commit -m "0.2.0" && git push origin nightly

# 2. Create and merge a release PR
gh pr create --base master --head nightly --title "v0.2.0"
gh pr merge --merge

# 3. Tag on master and push (tags bypass branch protection)
git checkout master && git pull
git tag v0.2.0
git push origin v0.2.0           # CI publishes to npm @latest

# 4. Sync master back to nightly
git checkout nightly && git merge master && git push origin nightly
```

Pre-1.0 bump semantics: any `Added` or `Changed` entry means a minor bump, a release with only `Fixed`/`Security` entries is a patch, and breaking changes are absorbed by the minor bump. Leaving `0.x` is a product decision, not a mechanical one.

### 4. Hotfix (skip nightly)

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
git commit -m "0.2.1" && git push origin hotfix/bump-version
gh pr create --base master --title "v0.2.1"
gh pr merge --merge

# 3. Tag and push
git checkout master && git pull
git tag v0.2.1
git push origin v0.2.1           # CI publishes to npm @latest

# 4. Sync the fix back to nightly
git checkout nightly && git pull
git merge master && git push origin nightly
```

## Changelog

[`CHANGELOG.md`](../../CHANGELOG.md) is the release-note source of truth, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form.

- Every user-visible PR adds one entry to `[Unreleased]`. A PR with nothing user-visible states that in its description instead — internal refactors, test-only work, docs, and CI plumbing do not get entries.
- `[Unreleased]` accumulates flat `### Added` / `### Changed` / `### Fixed` / `### Security` lists in user-visible voice, each line ending with its PR ref. See the `/changelog` skill for wording and category rules.
- The release skill (`/release`) drains `[Unreleased]` at bump time: it renames the section to `## [X.Y.Z] - YYYY-MM-DD`, opens a fresh empty `[Unreleased]`, and updates the compare links. Bump and drain travel in the same commit — CI publishes that dated section verbatim as the GitHub Release body, so a bump without a drain ships an empty release note.
- A release candidate reuses the target stable version's section. There is no `[X.Y.Z-rc.N]` heading; CI falls back from the rc version to its base version when it extracts the body.
- Never edit an already-released section. It is the published body of a GitHub Release and the two would disagree.

## What CI Does

Stable, rc, and nightly publishing are handled by a single workflow (`.github/workflows/publish.yml`), triggered by either a `v*` tag push or a push to `nightly`. It runs in the `release` environment with `id-token: write` (npm trusted publishing) and `contents: write` (GitHub Releases).

**On `v*` tag push (stable or rc):**

1. Checks out the tagged commit with full history
2. Verifies the tagged SHA is reachable from `origin/master` and fails otherwise — this is why the release PR is merged, not squashed
3. Verifies the tag equals `v` + the `package.json` version, then classifies it: no suffix means `latest`, `-rc.N` means `rc`, any other prerelease shape fails with no lane
4. Builds and runs tests against the tagged tree
5. Publishes with `npm publish --provenance --access public`, adding `--tag rc` on the rc lane. The stable step independently re-reads the tag and the version and refuses either one hyphenated, so a prerelease cannot reach `@latest`
6. Creates a GitHub Release (marked prerelease for rc) whose body is the matching `CHANGELOG.md` section, extracted by version heading. An rc falls back to its base version's section, then to a one-line placeholder if neither exists

**On push to `nightly`:**

1. Checks out the commit
2. Stamps a prerelease version: `<base>-nightly.YYYYMMDD.<run>`
3. Builds and runs tests
4. Publishes with `npm publish --provenance --access public --tag nightly`
5. Cuts no GitHub Release and touches no changelog — nightly builds are not release-noted

Occasionally a `nightly` merge does not trigger the workflow, so the `@nightly` channel lags git head; the next merge self-heals it. Check `npm view relay-ide@nightly version` before deploying a nightly rather than assuming it advanced.

### CI Setup (one-time)

1. Create a GitHub environment called `release` in the repo (Settings > Environments)
2. On npmjs.com, configure **trusted publishing** for `relay-ide` with:
   - Workflow filename: `publish.yml`
   - Environment name: `release`

## Pre-Release Checklist (stable and rc)

The `/release` skill (`.chalk/skills/release/SKILL.md`) is the executable form of this list.

1. Latest CI run on the current `origin/nightly` SHA is green
2. All tests pass: `npm test`
3. Build succeeds: `npm run build`
4. Type/lint clean: `npm run check`
5. No uncommitted changes: `git status` is clean
6. No open `p1-urgent`/`p2-high` issue on the release milestone
7. `CHANGELOG.md` has a dated section for the release version, and `[Unreleased]` is drained
8. Version bumped on `nightly` with `npm version --no-git-tag-version`, in the same commit as the drain
9. PR from `nightly` to `master` created and merged with `--merge`
10. Tag created on `master` and pushed, matching `v` + the `package.json` version (triggers CI publish)
11. For a stable promotion: the rc for this version passed the dogfood gate
12. `master` merged back into `nightly` to sync

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
npm dist-tag ls relay-ide                     # check all dist-tags (latest, rc, nightly)
gh release view v0.2.0                        # confirm the release body matches CHANGELOG.md
```

Install smoke in a throwaway prefix, so verifying a release cannot disturb a running hub:

```bash
SMOKE=$(mktemp -d)
npm install --prefix "$SMOKE" relay-ide@rc    # or @latest / @nightly
"$SMOKE/node_modules/.bin/relay-ide" --version
"$SMOKE/node_modules/.bin/relay-ide" manifest >/dev/null && echo "manifest ok"
rm -rf "$SMOKE"
```

After an rc soak, confirm `npm dist-tag ls relay-ide` still shows the previous stable under `latest` — the rc lane must never move it.
