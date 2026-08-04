---
name: changelog
description: >
  Write or fix a CHANGELOG.md [Unreleased] entry for relay-ide: pick the Keep a
  Changelog category, write it in user-visible voice, attach the PR or issue ref,
  and decide whether the change earns an entry at all. Use when the user says
  "changelog", "changelog entry", "add to [Unreleased]", "release note", or when
  a PR needs its entry before review.
---

# /changelog -- Write an [Unreleased] entry

Every user-visible PR adds one entry to the `[Unreleased]` section of
`CHANGELOG.md`. A PR with no entry states "no user-visible change" in its
description. `/release` drains `[Unreleased]` into a dated `## [X.Y.Z]` section
at bump time and CI publishes that section verbatim as the GitHub Release body —
so the entry is written for whoever reads the release note, not for the reviewer
of the diff.

ARGUMENTS: a PR number, an issue number, a branch, or a description of what
landed. With none, read the working diff (`git diff origin/nightly...HEAD`).

## Step 1: Does it earn an entry?

| Gets an entry                                        | No entry                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| New surface, command, route, or setting a user meets | Internal refactor with identical behavior                                |
| Behavior a user could notice changing                | Test-only changes, fixtures, harness work                                |
| A bug someone could have hit                         | Docs-only changes, comments, `AGENTS.md`                                 |
| Security fix or hardening with user-facing effect    | CI, workflow, lint, formatting, dependency bumps with no behavior change |
| Removal or rename of anything public                 | Pure typing, dead-code deletion                                          |

Two tests when it is close:

- **Would a user notice without reading the diff?** If no, no entry.
- **Would you mention it in a release announcement?** If no, no entry.

Declining is a legitimate outcome — state it in the PR. Silence is not, and CI
agrees: `.github/workflows/changelog.yml` fails any PR touching `server/`,
`frontend/`, or `shared/` that neither adds an `[Unreleased]` line nor declares
the exemption. To decline, put the literal phrase **"no user-visible change"** in
the PR body, or apply the `no-user-visible-change` label. Paraphrases do not
satisfy the gate.

## Step 2: Pick the category

`[Unreleased]` uses flat `### <Category>` headings, in this order. Only include
the headings you have entries for.

| Category   | Use for                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `Added`    | New capability that did not exist                                                  |
| `Changed`  | Existing behavior now works differently, including removals and renames            |
| `Fixed`    | Something that was broken now works                                                |
| `Security` | Auth, capability, policy, redaction, or dependency fixes with a threat behind them |

`Deprecated` and `Removed` are available from Keep a Changelog when a release
genuinely needs them; otherwise fold removals into `Changed` and say what
replaced the thing.

Classification traps:

- A fix to a feature that never shipped in a tagged release is part of that
  feature's `Added` entry, not a separate `Fixed` line. Users never saw the bug.
- A rewrite that users cannot detect is not `Changed`; it is no entry.
- If a fix has a security consequence, it belongs in `Security`, not `Fixed`,
  even if it started as a bug report.

## Step 3: Write the line

One line per change. Sentence case, no trailing period, no emoji.

- **User-visible voice.** Describe the product behavior, not the implementation.
- **Present tense, active.** "Search jumps to the matching message", not
  "added jump-to-message support".
- **Product vocabulary.** Channel, DM, thread, agent profile, workspace, node,
  hub, session — the nouns from `AGENTS.md`, not internal class names.
- **Name the surface** when the change is scoped to one: mobile cockpit,
  sidebar, command palette, CLI.
- **No file paths, function names, or table names.** They belong in the PR.

| Weak                                                     | Better                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Add FTS5 index to `channel_messages` and wire the router | Full-text message search with jump-to-message from the sidebar and palette |
| Fix race in `channel-agent-binder.ts`                    | Agent replies no longer land in the wrong channel after a fast re-mention  |
| Refactor `AgentDetailCard`                               | (no entry — no user-visible change)                                        |
| Bump `sharp`                                             | (no entry unless behavior changed)                                         |

## Step 4: Attach the ref

End the line with the reference in parentheses: `(#1315)`.

- Use the **PR** number. It resolves on GitHub and reaches the issue through the
  PR body's `Refs`/`Closes` line.
- If the PR number is not known yet, use the issue number and correct it after
  the PR opens.
- Multiple numbers for one line: `(#1233, #1236)`. Prefer splitting into
  separate entries when they are separate user-facing changes.
- An entry with no ref is only acceptable when there is genuinely no issue or
  PR — rare enough to be worth questioning.

## Step 5: Place it

Append under the right `###` heading in `[Unreleased]`, creating the heading if
it does not exist. Do not reorder or reword existing entries. Do not touch
already-released sections — they are the published body of a GitHub Release.

```markdown
## [Unreleased]

### Added

- Full-text message search with jump-to-message from the sidebar and palette (#1315)

### Fixed

- Unread counts survive a reload instead of resetting to zero (#1290)
```

Keep `[Unreleased]` flat while it accumulates. Released sections may add a second
level (`### <area>` then `#### <Category>`) once a release runs past roughly 25
entries and a flat list stops scanning — `/release` Step 3 does that regrouping
at drain time, so entry authors never pick an area.

## Step 6: Verify

```bash
awk '/^## \[Unreleased\]/{f=1;next} f && /^## \[/{exit} f' CHANGELOG.md
```

Read the output as if it were the release note. If a line only makes sense with
the diff open, rewrite it.

## Pitfalls

1. **Implementation voice.** The most common failure. Release notes are read by
   people who never see the code.
2. **Editing a released section.** It is already published as a GitHub Release
   body; changing it makes the two disagree.
3. **Entry for a feature the head does not actually ship.** Reviewers check the
   entry against the diff; an aspirational entry is a review finding.
4. **Missing `Security` classification.** Auth and capability fixes buried under
   `Fixed` are invisible to anyone scanning for reasons to upgrade.
5. **Skipping the entry because "it's obvious".** Nothing is obvious at tag
   time, when nobody remembers the PR.
