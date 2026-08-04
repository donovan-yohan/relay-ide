---
name: release
description: >
  Cut a relay-ide release: preflight the nightly head, bump the version, drain
  CHANGELOG [Unreleased], promote nightly to master, tag, verify the npm dist-tag
  and GitHub Release, dogfood a release candidate on the prod hub, and sync master
  back. Use when the user says "release", "cut a release", "ship a version",
  "publish stable", "cut an rc", "tag v0.2.0", or "promote the rc".
---

# /release -- Cut a relay-ide release

Drive a release of `donovan-yohan/relay-ide` from the `nightly` head to an npm
dist-tag. The workflow is `.github/workflows/publish.yml`; the branch and channel
contract lives in `docs/references/deployment.md`.
This skill is the operator sequence around them.

ARGUMENTS: the release shape, e.g. `/release minor`, `/release patch`,
`/release rc` (next candidate on the pending version), `/release promote`
(promote a soaked rc to stable). With no argument, infer from `[Unreleased]`
using the bump table below and confirm with the user before touching anything.

Never push directly to `master`. Never publish from a laptop with `npm publish`;
CI is the only publisher. Stop at the first failing gate and report — a
half-cut release with a pushed tag is more expensive than a delayed one.

## Channels

| Trigger                       | Version shape | npm dist-tag | GitHub Release  |
| ----------------------------- | ------------- | ------------ | --------------- |
| `vX.Y.Z` tag on `master`      | `X.Y.Z`       | `latest`     | yes             |
| `vX.Y.Z-rc.N` tag on `master` | `X.Y.Z-rc.N`  | `rc`         | yes, prerelease |
| push to `nightly`             | stamped       | `nightly`    | no              |

## Step 1: Preflight

All three gates must pass before any version bump. Report the actual output of
each; do not summarize a gate you did not run.

**1a. `nightly` is green.** The tagged tree is what CI publishes, so the head
you are about to promote must already be passing.

```bash
gh run list --repo donovan-yohan/relay-ide --branch nightly --limit 5 \
  --json headSha,name,conclusion,createdAt
git -C . fetch origin && git log --oneline -1 origin/nightly
```

The newest run on the current `origin/nightly` SHA must be `success`. A run
against an older SHA is not evidence for this head. If the publish workflow was
skipped for the head commit, see the npm publish lag note in
`docs/references/devbox-hub-deploy.md`.

Also run the local gates from a clean checkout of that SHA:

```bash
git status --short          # must be empty
npm run check               # 0 errors
npm test
npm run build
```

**1b. No open blocker on the release milestone.** The repo's P0/P1 equivalents
are the `p1-urgent` and `p2-high` labels.

```bash
gh issue list --repo donovan-yohan/relay-ide --state open \
  --label p1-urgent --json number,title,milestone
gh issue list --repo donovan-yohan/relay-ide --state open \
  --label p2-high --json number,title,milestone
```

Anything open on the milestone you are releasing blocks the release. Either fix
it, or have the user explicitly move it off the milestone — do not silently
decide it is not a blocker.

**1c. `CHANGELOG.md` `[Unreleased]` is non-empty.**

```bash
awk '/^## \[Unreleased\]/{f=1;next} f && /^## \[/{exit} f' CHANGELOG.md
```

Empty output means either nothing user-visible landed (in which case there is
nothing to release — say so) or PRs skipped their entries (in which case
reconstruct them from the merge log before continuing):

```bash
git log --oneline --first-parent v<LAST>..origin/nightly
```

Use `/changelog` for entry wording and category rules.

## Step 2: Choose the version

Pre-1.0 semantics — the current line is `0.y.z`:

| `[Unreleased]` contains           | Bump  | Example                                                                |
| --------------------------------- | ----- | ---------------------------------------------------------------------- |
| Any `Added` or `Changed` entry    | minor | 0.1.0 -> 0.2.0                                                         |
| Only `Fixed` / `Security` entries | patch | 0.1.0 -> 0.1.1                                                         |
| Breaking change                   | minor | pre-1.0 absorbs breaks in minor; call it out at the top of the section |

Never bump to `1.0.0` from this skill. Leaving 0.x is a product decision and
needs an explicit operator call.

Release candidates carry the target stable version plus `-rc.N`: the first
candidate for `0.2.0` is `0.2.0-rc.1`, the next is `0.2.0-rc.2`. `-rc.N` is the
only prerelease shape with a publish lane; any other suffix fails CI's classify
step.

## Step 3: Bump and drain the changelog on `nightly`

One commit carries the version bump and the changelog drain. Never bump without
draining — CI uses the dated section as the GitHub Release body, so a missing
section ships an empty release note.

```bash
git checkout nightly && git pull --ff-only
npm version <X.Y.Z|X.Y.Z-rc.N> --no-git-tag-version
```

Then edit `CHANGELOG.md`:

- Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today, UTC).
- Add a fresh empty `## [Unreleased]` above it.
- Update the link refs at the bottom: point `[Unreleased]` at
  `compare/vX.Y.Z...nightly` and add `[X.Y.Z]` -> `releases/tag/vX.Y.Z`.
- For a release candidate, the section stays `## [X.Y.Z]` with the target stable
  version. CI falls back from `0.2.0-rc.1` to the `0.2.0` section, so both the
  rc and the eventual stable release reuse one section. Do not write an
  `-rc.N` heading.

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "X.Y.Z"
git push origin nightly
```

## Step 4: Release PR `nightly` -> `master`

`master` is protected; every commit arrives via PR.

```bash
gh pr create --repo donovan-yohan/relay-ide \
  --base master --head nightly --title "vX.Y.Z" \
  --body "Release vX.Y.Z. See CHANGELOG.md."
gh pr merge --merge          # merge commit, not squash: master must contain the nightly SHAs
```

Use `--merge`. A squash rewrites the SHA, and CI's "tag is on master" check
looks for the tagged commit's SHA on `origin/master`.

## Step 5: Tag on `master`

Tags bypass branch protection; this is the only push that reaches `master`
directly.

```bash
git checkout master && git pull --ff-only
node -p "require('./package.json').version"   # must equal the tag minus its leading v
git tag vX.Y.Z
git push origin vX.Y.Z
```

CI then: verifies the tag is on `master`, verifies the tag equals `v` +
`package.json` version, classifies the channel (no suffix -> `latest`, `-rc.N`
-> `rc`, anything else fails), builds, tests, publishes, and cuts a GitHub
Release with the matching `CHANGELOG.md` section as the body. The stable publish
step independently refuses any hyphenated tag or version, so a prerelease can
never take `@latest`.

```bash
gh run watch --repo donovan-yohan/relay-ide
```

## Step 6: Post-tag verification

Run all four. These are the decisive lines to paste into the release issue or PR.

```bash
npm dist-tag ls relay-ide                     # latest / rc / nightly all point where you expect
npm info relay-ide@<X.Y.Z> version            # the exact version resolves
gh release view vX.Y.Z --repo donovan-yohan/relay-ide   # body matches the CHANGELOG section
```

Install smoke, in a throwaway prefix so it cannot disturb a running hub:

```bash
SMOKE=$(mktemp -d)
npm install --prefix "$SMOKE" relay-ide@<latest|rc>
"$SMOKE/node_modules/.bin/relay-ide" --version
"$SMOKE/node_modules/.bin/relay-ide" manifest >/dev/null && echo "manifest ok"
rm -rf "$SMOKE"
```

For an rc, confirm `npm dist-tag ls relay-ide` still shows the **previous**
stable under `latest`. An rc that moved `latest` is a P1 incident: re-point it
with `npm dist-tag add relay-ide@<previous-stable> latest` before anything else.

## Step 7: Dogfood gate (release candidates only)

An rc is not promoted to stable until it has run the prod hub. The prod hub is
`relay-stable-hub.service` on port `3456`, installed globally through bun
(`~/.bun/bin/relay-ide` -> `~/.bun/install/global/node_modules/relay-ide`).

```bash
bun add -g relay-ide@rc
node -p "require(process.env.HOME + '/.bun/install/global/node_modules/relay-ide/package.json').version"
systemctl --user restart relay-stable-hub.service
systemctl --user status relay-stable-hub.service --no-pager
curl -s http://127.0.0.1:3456/healthz
```

Confirm the printed version is the rc before claiming the deploy landed —
installing through the wrong package manager or prefix updates the files but
leaves the service on the old bytes (see the prefix-override notes in
`docs/references/devbox-hub-deploy.md`).
`/healthz` must return `{"status":"ok",...}`; a port-only check reports a false
green on a wedged hub.

Then use it. The gate is a real soak, not a boot check:

- Post in a channel and get a streamed agent reply with detail cards.
- Open a DM, a thread, and search; confirm the sidebar and unread counts.
- Exercise whatever the release's headline entries claim.

Rollback if the rc misbehaves — `latest` is untouched, so stable is one command
away:

```bash
bun add -g relay-ide@latest
systemctl --user restart relay-stable-hub.service
curl -s http://127.0.0.1:3456/healthz
```

Record the outcome, then either cut `-rc.N+1` with the fixes or promote: bump to
the plain `X.Y.Z` and run Steps 3-6 again. Health, recovery, and evidence
templates for the other hubs are in
`docs/references/devbox-hub-deploy.md`.

## Step 8: Sync `master` back to `nightly`

The bump commit and the merge live on `master`; `nightly` must not diverge.

```bash
git checkout nightly && git pull --ff-only
git merge master
git push origin nightly
git log --oneline -1 origin/master origin/nightly
```

Skipping this makes the next release PR replay old commits and the next
`[Unreleased]` diff conflict.

## Step 9: Report

- Version and tag, and the SHA that was tagged.
- npm dist-tag table before and after.
- GitHub Release URL, and whether the body matched the changelog section.
- Install smoke result.
- For an rc: dogfood outcome and prod-hub version/health lines.
- `master`/`nightly` sync confirmation.

## Pitfalls

1. **Bump without drain.** The GitHub Release body is extracted from the
   `## [X.Y.Z]` section. No section, empty release notes on a published tag.
2. **Squash-merging the release PR.** The tagged SHA must be reachable from
   `origin/master` or CI aborts at the first step. Use `--merge`.
3. **Tag/version mismatch.** `git tag v0.2.0` on a tree whose `package.json`
   says `0.1.0` fails the classify step. Read the version back before tagging.
4. **Invented prerelease shapes.** `-beta.1`, `-next.1`, and bare `-rc` have no
   lane and fail CI. Only `-rc.N`.
5. **An `-rc.N` changelog heading.** CI looks for `## [X.Y.Z]` first and falls
   back to the base version; an `## [0.2.0-rc.1]` heading orphans the stable
   release's notes.
6. **Assuming `@nightly` advanced.** Publishes occasionally get skipped for a
   merge. Check `npm view relay-ide@nightly version` against the head you think
   you are testing.
7. **Global install through the wrong manager.** The prod hub runs the bun
   global install; `npm i -g relay-ide@rc` updates a different tree and the
   service keeps serving the old version.
8. **Claiming a dogfood pass from a boot.** A hub that starts is not a hub that
   works. Drive a channel round trip.
9. **Forgetting the back-merge.** `master` ahead of `nightly` is a conflict you
   pay for at the next release, not this one.
