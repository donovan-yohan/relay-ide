# .chalk

`chalkbag` source of truth lives here for shared skills and provider config.

- Keep repo-specific instructions in tracked `AGENTS.md`; keep chalkbag workflow/tooling notes here.
- Edit `.chalk/skills/`, `providers.yaml`, and `permissions.yaml`; do not hand-edit generated `.agents/`, `.claude/`, `.codex/`, `.opencode/`, or `opencode.json`.
- Subagents are out of chalkbag scope; `.chalk/subagents/` now hard-fails `chalkbag validate`. Define agents natively per provider (e.g. `.claude/agents/`).
- Run `chalkbag validate` before `chalkbag build --yes` when changing this tree.
- Use `--provider <ids>` only when you want a one-off override; otherwise `chalkbag build` defaults to all providers (or the last rendered set if one exists).
- On macOS, prefer `chalkbag daemon install --provider claude,codex` plus `chalkbag daemon status`; otherwise run `chalkbag watch` while editing `.chalk/`.
