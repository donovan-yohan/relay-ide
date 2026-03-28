# Bug Analysis: Hook 403 errors after server restart + TMUX_PREFIX test regression

> **Status**: Confirmed | **Date**: 2026-03-28
> **Severity**: High
> **Affected Area**: `server/sessions.ts` (serialization), `server/pty-handler.ts` (hook injection + TMUX_PREFIX)

## Symptoms
- Every Claude Code tool call shows `PreToolUse:Bash hook error` and `PostToolUse:Bash hook error`
- Stop hook explicitly returns `HTTP 403` with the full URL visible
- Commands still execute (hooks are advisory) but session state detection degrades to parser-only
- 4 test failures: `TMUX_PREFIX` evaluates to `crcd-` instead of expected `crc-`

## Reproduction Steps

### Hook 403 errors
1. Start the server with tmux enabled (`launchInTmux: true`)
2. Create a Claude Code session — hooks work normally
3. Restart the server (Ctrl-C + restart, or auto-update via POST /update)
4. The tmux session survives the restart
5. Server restores the session by attaching to the surviving tmux session
6. All hook calls from the old Claude Code instance return 403

### TMUX_PREFIX test failures
1. Have `NO_PIN=1` in the shell environment (set by `npm run dev` or exported)
2. Run `npm test`
3. Tests expecting `TMUX_PREFIX === 'crc-'` fail because it evaluates to `'crcd-'`

## Root Cause

### Hook 403: hookToken lost during tmux session restoration

The `hookToken` (32-byte random hex string) is generated at session creation and stored in-memory on the Session object. It's also written to a hooks-settings.json file that Claude Code reads via `--settings`.

**The token is never serialized.** `SerializedPtySession` (sessions.ts:16-33) does not include `hookToken` or `hooksActive`. When the server restarts:

1. `serializeAll()` saves sessions without hookToken
2. Tmux sessions survive (intentionally — the auto-update path doesn't kill them)
3. `restoreFromDisk()` creates the session with `command='tmux'` for surviving tmux sessions
4. `shouldInjectHooks = agent === 'claude' && !command && ...` → **false** (because `!command` is false when `command='tmux'`)
5. Session gets `hookToken = ''` (empty string default)
6. Old Claude Code inside tmux still calls hooks with the original token
7. Token verification: `timingSafeEqual(Buffer.from(originalToken), Buffer.from(''))` → length mismatch → **403**

### TMUX_PREFIX: module-level evaluation polluted by environment

```typescript
export const TMUX_PREFIX = process.env.NO_PIN === '1' ? 'crcd-' : 'crc-';
```

This evaluates at module load time. The user's shell has `NO_PIN=1` (from running `npm run dev`), which leaks into all processes including `npm test`. The tests assume `NO_PIN` is unset.

## Evidence

- `server/pty-handler.ts:131`: `shouldInjectHooks` excludes `command='tmux'`
- `server/pty-handler.ts:128`: `hookToken = ''` default when hooks not injected
- `server/sessions.ts:16-33`: `SerializedPtySession` has no `hookToken` field
- `server/sessions.ts:420-423`: Restore sets `command='tmux'` for surviving sessions
- `server/index.ts:1282-1289`: Auto-update serializes but does NOT kill tmux sessions
- `server/hooks.ts:167-172`: Token verification returns 403 on mismatch
- Test output: `'crcd-' !== 'crc-'` confirms `NO_PIN=1` pollution
- `package.json:19`: `dev` script sets `NO_PIN=1`
- User environment: `echo $NO_PIN` → `1`

## Impact Assessment

- **Hook 403s**: After any server restart, ALL tmux-based sessions lose hook-driven state detection. They fall back to output parser detection, which is less accurate (no permission-prompt detection, no tool activity tracking). Push notifications for attention states stop working for these sessions.
- **Test failures**: 4 tests fail in any environment where `NO_PIN=1` is set. CI would pass (no `NO_PIN`), but local dev testing is unreliable.
- **Recurrence**: This is the THIRD instance of the serialization gap pattern (first: `tmuxSessionName` in 2026-03-17, second: `yolo`/`claudeArgs` in 2026-03-22, now: `hookToken`/`hooksActive`).

## Recommended Fix Direction

### Hook 403
1. Add `hookToken` and `hooksActive` to `SerializedPtySession`
2. Update `serializeAll()` to persist them
3. Update `restoreFromDisk()` to pass them through to `create()`
4. In `createPtySession()`, when `hookToken` is provided in params, use it directly instead of generating a new one (skip `shouldInjectHooks` for restored sessions that already have a token)

### TMUX_PREFIX test regression
Either:
- Make `TMUX_PREFIX` a function that accepts an explicit parameter for testability, OR
- Clear `NO_PIN` in the test setup, OR
- Update tests to be environment-aware

### Systemic fix
Audit ALL Session properties against `SerializedPtySession` and add any functionally important fields that are missing (see Architecture Review below).

## Architecture Review

### Systemic Spread
The same serialization gap affects multiple properties beyond `hookToken`:

| Property | On Session? | Serialized? | Impact |
|----------|:-----------:|:-----------:|--------|
| `hookToken` | Yes | **No** | CRITICAL — causes 403 on all hooks |
| `hooksActive` | Yes | **No** | CRITICAL — server doesn't know hooks were active |
| `branchRenamePrompt` | Yes | **No** | Medium — custom rename prompt lost |
| `needsBranchRename` | Yes | **No** | Medium — pending rename lost |
| `agentState` | Yes | **No** | Medium — resets to 'initializing' |
| `status` | Yes | **No** | Medium — 'disconnected' state lost |
| `idle` | Yes | **No** | Low — self-corrects after 5s timeout |

This is the **third time** this pattern has caused a bug:
1. `2026-03-17`: `tmuxSessionName` not serialized → orphan cleanup killed restored sessions
2. `2026-03-22`: `yolo`/`claudeArgs` not serialized → session flags lost on restart
3. `2026-03-28`: `hookToken`/`hooksActive` not serialized → hook 403 errors

### Design Gap
**Whitelist serialization without enforcement.** `serializeAll()` manually picks properties to serialize. When new properties are added to Session, there's no mechanism to flag that they need serialization. The `SerializedPtySession` interface is maintained independently from the `Session`/`PtySession` types, so TypeScript doesn't catch the gap.

A better design would either:
- Use a **derivation approach**: `type SerializedPtySession = Pick<PtySession, 'id' | 'type' | ...>` with an explicit `Omit` for transient fields, so adding a new field to PtySession forces a decision
- Add a **compile-time check**: a type-level assertion that every non-transient property of PtySession is either in SerializedPtySession or in an explicit exclusion list

### Testing Gaps
- **Missing test cases:**
  - No test verifies that `hookToken` survives a serialize/restore round trip
  - No test verifies that hook calls succeed after session restoration
  - No test for the auto-update path's impact on hook tokens
  - TMUX_PREFIX tests don't isolate from environment variables
- **Infrastructure gaps:**
  - No integration test exercises the full "create session → restart server → restore → verify hooks work" cycle
  - The serialize/restore round-trip test (`sessions.test.ts`) checks `tmuxSessionName`, `yolo`, `claudeArgs` but not `hookToken` or `hooksActive` — each fix added its own field but nobody audited all fields

### Harness Context Gaps
- `docs/DESIGN.md:92` says "Restored tmux sessions...fall back to parser-based state detection" — this is misleading. The old Claude Code instance doesn't fall back; it keeps calling hooks with the old token and gets 403 errors. The fallback only works for SERVER-SIDE state detection, not for the Claude Code client's hook calls.
- `docs/ARCHITECTURE.md:167` mentions session serialization but doesn't list which properties are serialized or the known gaps.
- No LEARNINGS.md entry captures the recurring serialization gap pattern despite it being the third occurrence.
