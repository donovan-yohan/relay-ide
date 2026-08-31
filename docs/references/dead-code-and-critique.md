# Dead code and critique

Two tools, deliberately different in kind.

| Tool                     | Command                       | Kind                                   | Output        |
| ------------------------ | ----------------------------- | -------------------------------------- | ------------- |
| [knip](https://knip.dev) | `npm run deadcode`            | Deterministic. Same tree, same report. | stdout        |
| `scripts/critique.mjs`   | `npm run critique -- <scope>` | Non-deterministic. An LLM's opinion.   | markdown file |

Neither is a gate. Neither runs in CI. Both produce **candidates** that a human
grep-verifies before anything is deleted. The failure mode this pair exists to
avoid is the opposite one: nobody looks, and the tree accumulates modules that
only their own tests still reach.

## `npm run deadcode` — knip

Reports unused files, exports, exported types, and dependencies by building the
import graph from the entry points declared in `knip.jsonc`.

```bash
npm run deadcode                       # full report
npx knip --include files,dependencies  # just the high-signal categories
npx knip --reporter json               # machine-readable, for scripted triage
```

### What `knip.jsonc` declares, and why

| Setting                                             | Why                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry: bin/*.ts`                                   | The four `bin` entries in `package.json`. knip infers `server/index.ts` from package.json `main`/`exports` and `frontend/src/main.tsx` from `frontend/index.html`, so neither is listed — re-declaring an inferred entry earns a "redundant entry pattern" hint on every run, and a report that nags is a report nobody reads.                                                          |
| `entry:` seven enumerated `scripts/*.ts` files      | **Enumerated, not globbed.** `scripts/*` as an entry pattern makes every file in the directory an entry by definition, so an orphan script stays invisible for exactly as long as the glob lives — it was hiding `scripts/seed-channel-chat.ts`. Listed here are only the scripts an npm script invokes through a built `dist/scripts/*.js` path, which knip cannot map back to source. |
| `entry: frontend/src/main.tsx`                      | The Vite entry, reached from `frontend/index.html`.                                                                                                                                                                                                                                                                                                                                     |
| `entry: frontend/src/test-*.tsx`                    | E2E component fixtures. They are only Rollup inputs when `RELAY_IDE_E2E_FIXTURES=1` (see `frontend/vite.config.ts`), so knip cannot see them as entries — declared explicitly. Deleting one also means deleting its `.html` and its `buildInputs` line; `test/e2e/fixture-targets.ts` guards that pairing.                                                                              |
| `entry: test/**/*.test.ts`, `test/e2e/**/*.spec.ts` | Tests are entry points, not project files. This is what makes "kept alive only by its own test" visible as a _conscious_ judgement rather than a knip finding.                                                                                                                                                                                                                          |
| `ignoreDependencies: ['@xterm/addon-webgpu']`       | Not a package. It is a Vite alias onto a path inside the custom `@xterm/xterm` fork (`frontend/vite.config.ts`).                                                                                                                                                                                                                                                                        |
| `ignoreExportsUsedInFile: true`                     | Suppresses ~930 findings of the form "this symbol is exported but only used inside its own file". Those symbols are **alive**; only the `export` keyword may be unnecessary. Turn it off to audit over-exporting — a different, much lower-value job.                                                                                                                                   |
| `rules: { duplicates: 'off' }`                      | The frontend convention is to export a component both named and as default. knip counts that as a duplicate on every component.                                                                                                                                                                                                                                                         |

Nothing is path-ignored to make numbers look better: `knip.jsonc` has **no
`ignore` key at all**. Generated projections (`.claude/`, `.codex/`,
`opencode.json`, projected from `.chalk/` by chalkbag) are already outside
knip's `project` globs, so they are never analysed and need no entry.

### Known false positives — read before deleting anything

1. **Referenced by path string, not by import.** `test/e2e-sweep-ledger.ts` and
   `test/components/leaf-component-migration.test.ts` name component files as
   string literals. knip cannot see that edge, so it reports several
   `frontend/src/components/*.tsx` files as unused when a ledger test still
   asserts against them. Deleting the component means updating the ledger.
2. **Registered by import side effect.** A module that calls a
   `register*()` at module scope is invisible to the import graph in one
   direction and _fake_ in the other. The worked example was the per-framework
   telemetry registry (`server/telemetry-adapter.ts` plus
   `server/adapters/*-telemetry.ts`): the registration edge looked live, but the
   whole registry had no production importer at all, and it was deleted as
   obsolete under #1483. Check the other direction before trusting a registry.
3. **Named in the shared command manifest.** `shared/relay-command-manifest.ts`
   carries command-name inventories (`sessions.kill`, `worktrees.create`, …) as
   strings. A knip hit on a frontend `…CommandDefinition()` factory does _not_
   mean the command is dead — it means that particular factory has no caller.
4. **Route/auth drift guards.** `test/auth.test.ts` keeps a literal inventory of
   HTTP routes. It constrains what you may add, not what knip may report, but it
   is the second file to check whenever a server surface looks orphaned.
5. **`scripts/seed-channel-chat.ts`.** Reported as an unused file, and
   technically correct: nothing imports it and no npm script runs it. It is a
   manual dev utility whose own header documents `node dist/scripts/seed-channel-chat.js`.
   It is deliberately _not_ added to `entry` — adding it would hide the open
   question of whether anyone still uses the seeder. See #1477.
6. **The named/default component pair.** Roughly 80 of the reported unused
   exports are one systemic pattern: a component exports both `export function
Foo` and `export default Foo`, and consumers use one. That is one decision
   (a codemod, or a lint rule), not 80.

### Triage discipline

For every candidate, before it becomes a diff:

```bash
grep -rn '\bSymbolName\b' --include='*.ts' --include='*.tsx' server frontend shared test bin scripts
grep -rn 'module-basename' --include='*.ts' --include='*.tsx' --include='*.json' .   # path-string references
git log -1 --format='%ad %s' --date=short -- path/to/file
```

A candidate whose only references are its own test is not a false positive —
it is the most interesting kind of finding, and the decision is "delete both"
or "wire it up", never "leave it".

**Re-run knip after every deletion round.** The report is not a fixpoint. Under
`ignoreExportsUsedInFile`, an export suppressed because its only consumer sits
in the same file becomes genuinely dead the moment you delete that consumer —
and stays invisible until the next run. In this tree, 77 of the 137 files
carrying a reported-unused export also carry masked in-file-only exports, so a
single-pass sweep will leave rot behind by construction.

## `npm run critique` — LLM critique lane

Packs a scoped slice of the tracked source and asks a model on the local
gateway for dead/vestigial candidates, duplication, layering violations,
complexity hotspots, and ranked improvements. The report is a markdown file
written outside the repo; **it is never committed**. The script is.

```bash
npm run critique                                  # default scope: server/
npm run critique -- server/protocol-adapters
npm run critique -- shared frontend/src/lib --include-tests
npm run critique -- server --dry-run              # pack only, print sizes, no call
npm run critique -- server --out /tmp/report.md --max-tokens 32000
```

| Flag                 | Default                                 | Notes                                                                                      |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `--include-tests`    | off                                     | Tests are excluded so the model does not mistake test coverage for use.                    |
| `--model <id>`       | `deepseek-v4-flash`                     | Any model the gateway serves. Also `RELAY_CRITIQUE_MODEL`.                                 |
| `--budget <n>`       | `200000` input tokens                   | Packing budget, estimated at 4 chars/token.                                                |
| `--max-tokens <n>`   | `24000`                                 | Completion budget. See the reasoning-model caveat below.                                   |
| `--reasoning-effort` | `low`                                   | `low` \| `medium` \| `high` \| `max`. Reasoning tokens are charged against `--max-tokens`. |
| `--out <path>`       | `$RELAY_CRITIQUE_OUT_DIR` or a temp dir | The script prints the path on stdout, diagnostics on stderr.                               |
| `--dry-run`          | off                                     | Pack and report sizes without calling the gateway.                                         |

### Packing

File selection is `git ls-files -- <scope>`, so `.gitignore` is honoured by
construction and untracked or generated files cannot leak into the payload.
Only text source extensions are packed.

When the scope exceeds the budget, the script binary-searches a single per-file
character cap and truncates every file above it, keeping 70% head and 30% tail
with an explicit `… N characters elided …` marker. Files are never dropped
outright: a missing file reads to the model as "this does not exist", which is
precisely how you get confident hallucinated dead-code claims. Truncated files
are listed in the report header and the prompt tells the model not to reason
about regions it cannot see.

### Gateway wiring

The script needs an OpenAI-compatible `/chat/completions` endpoint:

- `LOCAL_LLM_BASE` — base URL including `/v1`
- `LOCAL_LLM_KEY` — bearer token

Resolution order, at runtime, every run:

1. `LOCAL_LLM_BASE` / `LOCAL_LLM_KEY` already exported in the environment.
2. Otherwise, parsed out of an env file — `$RELAY_CRITIQUE_ENV_FILE`, defaulting
   to `~/.config/finn-nancy/prod.env`.

No credential is read from source or written to the report. Two things are
enforced rather than assumed:

- **Every gateway-derived string is scrubbed of the key before it is printed.**
  Several OpenAI-compatible proxies echo the received `Authorization` header in
  their 401 body — the one failure an operator is most likely to paste into a
  chat asking why auth broke. `scrub()` runs on the error body and on any
  transport error message.
- **Only `protocol//host/pathname` of the endpoint is echoed.** A base URL is
  not automatically non-secret: userinfo (`https://user:tok@host/v1`) and query
  tokens (`?api-key=…`) are both common gateway shapes.

If you point this at a metered provider, mind that a full `server/` scope is a
~200k-token request.

### Caveats

- **Reasoning models spend their budget before they write, and this one is
  slow.** Measured on `deepseek-v4-flash` against `server/protocol-adapters`
  (18 files, ~131k tokens): the gateway generates at roughly 7-8 tokens/s, and
  at default reasoning effort the model burned **19 minutes and ~8,700 reasoning
  tokens without emitting a single character of report**. That is why
  `--reasoning-effort` defaults to `low`. The script streams and prints a
  progress line every 10s (`Ns — N reasoning chars, N report chars`) precisely
  so you can see which of the two it is doing. If the report comes back empty or
  `finish_reason` is `length`: lower the effort, raise `--max-tokens`, or narrow
  the scope — in that order. Budget 15-25 minutes for a directory-sized scope.
  Reference point: `server/protocol-adapters` at `--reasoning-effort low` took
  21 minutes, emitted 52k characters of discarded reasoning, and still hit
  `finish_reason: length` at 16k completion tokens — which is why the default is
  now 24k. Check the `finish_reason` row in the report header before trusting
  that the last section is missing rather than truncated.
- **Scope blindness is structural.** The model sees only the packed files. A
  symbol with no caller _inside the scope_ may be called from outside it. The
  prompt demands "candidate" language for exactly this, but check anyway.
- **Cross-check dead-code claims against knip.** knip has the whole import
  graph; the model has a window. Where they disagree, knip is right about
  reachability and the model may still be right about intent.
- **Whole-`server/` is the wrong scope.** 193 files against a 200k budget
  solves to a ~4.4k-character cap per file, i.e. the model sees little more than
  each file's imports and top-level declarations. `--dry-run` prints the cap and
  the truncation count — if most files are truncated, narrow the scope instead
  of raising the budget. One directory at a time produces specific findings; the
  whole tree at once produces architecture-flavoured generalities.
