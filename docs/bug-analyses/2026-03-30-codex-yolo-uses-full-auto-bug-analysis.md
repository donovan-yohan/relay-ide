# Bug Analysis: Codex yolo mode still requests permissions

> **Status**: Confirmed | **Date**: 2026-03-30
> **Severity**: Medium
> **Affected Area**: backend agent flag mapping for Codex session creation and restore

## Symptoms
- Starting a Codex session with yolo mode enabled still leads to approval prompts during the session
- The UI advertises yolo as "skip permission checks"
- The same behavior persists after session restore because the same yolo mapping is reused on restart

## Reproduction Steps
1. Start a session with `agent: codex` and `yolo: true`
2. Follow the backend session creation path in `POST /sessions`
3. Observe that the backend appends `AGENT_YOLO_ARGS.codex`
4. Inspect the installed Codex CLI help text
5. Observe that the mapped flag is `--full-auto`, which expands to `-a on-request --sandbox workspace-write`, not "never ask for approval"

## Root Cause

The app's yolo abstraction is mapped per agent in `server/types.ts`. For Codex, the current mapping is:

```ts
export const AGENT_YOLO_ARGS: Record<AgentType, string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--full-auto'],
};
```

That mapping is threaded into every Codex session launch path:

- `server/index.ts` appends `AGENT_YOLO_ARGS[resolvedAgent]` when `resolved.yolo` is true
- `server/workspace-groups.ts` does the same for grouped workspace launches
- `server/sessions.ts` reuses the same mapping when restoring disconnected sessions

The problem is that the installed Codex CLI does **not** define `--full-auto` as "skip permission checks." Its help text says:

- `--full-auto` = "low-friction sandboxed automatic execution"
- specifically `(-a on-request, --sandbox workspace-write)`

`on-request` still allows the model to request approval. So the code is faithfully passing the configured Codex yolo flag, but the chosen flag does not match the product's yolo semantics.

This is therefore a **semantic mapping bug**, not a missing-forwarding bug.

## Evidence
- `server/types.ts:25-28` maps Codex yolo to `['--full-auto']`
- `server/index.ts:1262-1272` appends `AGENT_YOLO_ARGS[resolvedAgent]` into normal agent session args
- `server/workspace-groups.ts:348-355` appends the same mapping for workspace-group launches
- `server/sessions.ts:476-489` re-applies the same mapping during session restore
- `frontend/src/components/dialogs/CustomizeSessionDialog.svelte:140` labels yolo as "skip permission checks"
- Local `codex --help` output:
  - `--full-auto` = `(-a on-request, --sandbox workspace-write)`
  - `--ask-for-approval never` = "Never ask for user approval"
  - `--dangerously-bypass-approvals-and-sandbox` = skip approvals and sandbox entirely

## Impact Assessment
- Every Codex session launched with yolo currently gets a weaker mode than the UI promises
- Restored Codex sessions preserve the same incorrect mapping, so the issue is persistent across restart
- Claude and Codex now have materially different yolo semantics under one shared UI label
- Users may believe Codex is in a no-approval mode when it is actually allowed to escalate approvals

## Recommended Fix Direction

Choose the intended Codex meaning of yolo explicitly:

1. If yolo means "no approval prompts, but keep sandboxing," map Codex to:
   - `['--ask-for-approval', 'never', '--sandbox', 'workspace-write']`
2. If yolo means "dangerously remove approvals and sandbox," map Codex to:
   - `['--dangerously-bypass-approvals-and-sandbox']`

Option 1 is the safer semantic match for the current UI copy "skip permission checks."

Separately, if the app wants Claude/Codex parity on risk level, the UI label should stop pretending these are equivalent until the mapping is made explicit.

## Notes
- I did not run a live interactive Codex session during this investigation. The diagnosis is still high-confidence because the forwarding path is explicit in code and the installed Codex CLI help text defines the current flag semantics directly.
- Even after fixing approval policy, Codex may still ask the user non-permission questions. That is distinct from command approval prompts.
