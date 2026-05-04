# .chalk

`chalkbag` source of truth lives here for shared skills, subagents, and provider config.

- Keep repo-specific instructions in tracked `AGENTS.md`; keep chalkbag workflow/tooling notes here.
- Edit `.chalk/skills/`, `.chalk/subagents/`, `providers.yaml`, and `permissions.yaml`; do not hand-edit generated `.agents/`, `.claude/`, `.codex/`, `.opencode/`, or `opencode.json`.
- Run `chalkbag validate` before `chalkbag build --yes` when changing this tree.
- Use `--provider <ids>` only when you want a one-off override; otherwise `chalkbag build` defaults to all providers (or the last rendered set if one exists).
- On macOS, prefer `chalkbag daemon install --provider claude,codex` plus `chalkbag daemon status`; otherwise run `chalkbag watch` while editing `.chalk/`.
