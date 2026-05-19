/**
 * session-rename-resolver.ts
 *
 * Deterministic rename resolver for Relay sessions.
 *
 * Precedence (highest → lowest):
 *   1. explicit user name   — session.userSetName is non-empty
 *   2. pinned session name  — session.pinnedName is non-empty (persisted meta display name)
 *   3. agent-suggested name — resolved by running the configured renamer tool
 *   4. heuristic name       — derived from cwd, repoName, or branchName
 *   5. default              — ISO timestamp + repo path fragment
 *
 * Phase 3 (per-Workspace overrides, blocked by #444) and Phase 4 (web-interface
 * metadata, blocked by #300/#301) are explicitly deferred.
 */

import path from 'node:path';
import { execFile, type ExecFileOptions } from 'node:child_process';

import { phraseToBranchName } from './git.js';
import { stripAnsi, cleanEnv } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-rename-resolver');

/**
 * Promise-based wrapper around execFile that resolves with { stdout, stderr }.
 * Written without util.promisify so the mocked `execFile` is called consistently
 * in both production and test environments.
 */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        const richErr = Object.assign(err, {
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
        reject(richErr);
      } else {
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Renamer tool setting.
 *  - `'claude'`        — use `claude -p --model haiku` (default, if installed)
 *  - `'codex'`         — use `codex` CLI
 *  - `'none'`          — skip the agent-suggested-name branch entirely
 *  - `'custom-script'` — run renamerCustomScript; first trimmed stdout line is the name
 */
export type RenamerTool = 'claude' | 'codex' | 'none' | 'custom-script';

export interface RenameInput {
  /**
   * The plain-text user prompt that kicked off the session (first message).
   * Already stripped of ANSI and truncated at 500 chars by the caller.
   */
  promptText: string;

  /** Session working directory — used as cwd for exec calls. */
  cwd: string;

  /**
   * Per-session custom rename prompt.  When set, replaces the default
   * DEFAULT_RENAME_PROMPT preamble (e.g. configured via branchRenamePrompt).
   */
  customRenamePrompt?: string | undefined;

  /** Optional override: session.repoName, used in heuristic + default fallbacks. */
  repoName?: string | undefined;

  /**
   * Optional override: session.branchName, used in heuristic fallback.
   * Not the target branch — the current branch name as context.
   */
  branchName?: string | undefined;

  /** ISO creation timestamp, used in the final default fallback. */
  createdAt: string;
}

export interface RenameResult {
  displayName: string;
  branchName: string;
  /** Which precedence branch fired. */
  source: RenamePrecedenceBranch;
}

/** Ordered precedence branches from highest to lowest. */
export type RenamePrecedenceBranch =
  | 'explicit-user'
  | 'pinned'
  | 'agent-suggested'
  | 'heuristic'
  | 'default';

export interface RenamerConfig {
  /** Which CLI tool is used for the agent-suggested-name branch. */
  tool: RenamerTool;
  /** Path to a user-provided binary; first trimmed stdout line is the name. Required when tool is 'custom-script'. */
  customScript?: string | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RENAME_PROMPT = `Output two lines (no explanation, no backticks, no quotes):
Line 1: A short descriptive phrase (3-8 words) summarizing this task
Line 2: A kebab-case git branch name for the same task

Example:
Fix sidebar disappearing on mobile
fix-sidebar-disappearing-on-mobile

Task:`;

/** Maximum characters from the user prompt passed to the renamer. */
const MAX_PROMPT_CHARS = 500;

/** Hard timeout for agent-suggested-name exec calls. */
const AGENT_EXEC_TIMEOUT_MS = 30_000;

/** Maximum length for a custom-script path to guard against obviously wrong input. */
const MAX_CUSTOM_SCRIPT_PATH_LEN = 4096;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildFullPrompt(input: RenameInput): string {
  const cleaned = stripAnsi(input.promptText).slice(0, MAX_PROMPT_CHARS);
  const preamble = input.customRenamePrompt ?? DEFAULT_RENAME_PROMPT;
  return preamble + '\n\n' + cleaned;
}

function parseRenamerOutput(
  stdout: string
): { displayName: string; branchName: string } | null {
  const lines = stdout
    .replace(/`/g, '')
    .replace(/["']/g, '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return null;

  const raw = lines[0]!.slice(0, 80);
  const displayName = raw.charAt(0).toUpperCase() + raw.slice(1);
  const branchName = phraseToBranchName(lines[1] ?? displayName);
  if (!branchName) return null;

  return { displayName, branchName };
}

// ---------------------------------------------------------------------------
// Agent-suggested-name runners
// ---------------------------------------------------------------------------

async function runClaudeRenamer(
  fullPrompt: string,
  cwd: string
): Promise<{ displayName: string; branchName: string } | null> {
  const env = cleanEnv();
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', '--model', 'haiku', fullPrompt],
      { cwd, timeout: AGENT_EXEC_TIMEOUT_MS, env }
    );
    return parseRenamerOutput(stdout);
  } catch (err) {
    logger.warn('claude renamer exec failed:', err);
    return null;
  }
}

async function runCodexRenamer(
  fullPrompt: string,
  cwd: string
): Promise<{ displayName: string; branchName: string } | null> {
  const env = cleanEnv();
  try {
    // Codex: non-interactive one-shot mode with --quiet so only model output is emitted
    const { stdout } = await execFileAsync(
      'codex',
      ['--quiet', '-p', fullPrompt],
      { cwd, timeout: AGENT_EXEC_TIMEOUT_MS, env }
    );
    return parseRenamerOutput(stdout);
  } catch (err) {
    logger.warn('codex renamer exec failed:', err);
    return null;
  }
}

async function runCustomScriptRenamer(
  scriptPath: string,
  fullPrompt: string,
  cwd: string
): Promise<{ displayName: string; branchName: string } | null> {
  if (!scriptPath || scriptPath.length > MAX_CUSTOM_SCRIPT_PATH_LEN) {
    logger.error('custom-script renamer: invalid script path');
    return null;
  }

  // Validate: must be an absolute path.
  if (!path.isAbsolute(scriptPath)) {
    logger.error(
      'custom-script renamer: script path must be absolute:',
      scriptPath
    );
    return null;
  }

  const env = cleanEnv();

  // Do NOT use string interpolation / shell: use execFile so the path is
  // passed as a direct argument with no shell injection surface.
  const { outText, errText } = await execFileAsync(scriptPath, [], {
    cwd,
    timeout: AGENT_EXEC_TIMEOUT_MS,
    env: { ...env, RELAY_RENAME_PROMPT: fullPrompt },
  }).then(
    (result) => ({ outText: result.stdout, errText: result.stderr }),
    (err: NodeJS.ErrnoException & { stderr?: string; stdout?: string }) => {
      // execFile throws on non-zero exit or timeout — capture output from the error
      const capturedOut = err.stdout ?? '';
      const capturedErr = err.stderr ?? '';
      logger.warn(
        'custom-script renamer exec failed (exit/timeout):',
        err.message ?? String(err)
      );
      if (capturedErr)
        logger.warn('custom-script renamer stderr:', capturedErr);
      return { outText: capturedOut, errText: capturedErr };
    }
  );

  if (errText && !outText) {
    logger.warn(
      'custom-script renamer produced only stderr, no stdout:',
      errText
    );
    return null;
  }

  const parsed = parseRenamerOutput(outText);
  if (!parsed) {
    if (errText) logger.warn('custom-script renamer stderr:', errText);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Heuristic name
// ---------------------------------------------------------------------------

/**
 * Build a heuristic display name from what we know about the session without
 * calling any external tool.
 */
export function buildHeuristicName(
  cwd: string,
  repoName?: string | undefined,
  branchName?: string | undefined
): string {
  if (repoName && branchName) return `${repoName}/${branchName}`;
  if (repoName) return repoName;
  if (branchName) return branchName;
  return path.basename(cwd) || cwd;
}

// ---------------------------------------------------------------------------
// Default name
// ---------------------------------------------------------------------------

/** Last-resort: timestamp + repo context. */
export function buildDefaultName(
  createdAt: string,
  cwd: string,
  repoName?: string | undefined
): string {
  const ts = createdAt.slice(0, 16).replace('T', ' '); // "2026-05-19 14:30"
  const ctx = repoName || path.basename(cwd);
  return ctx ? `${ctx} ${ts}` : ts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a session display name + branch name using the configured precedence.
 *
 * This function is pure with respect to I/O **except** for the `agent-suggested`
 * branch which shells out to the configured renamer tool.  Callers that have
 * already applied `explicit-user` or `pinned` precedence at a higher layer
 * (e.g. the hooks router) should pass `undefined` for those fields and let the
 * resolver handle the remaining tiers.
 *
 * @param userSetName   — explicit name the user gave the session (highest priority)
 * @param pinnedName    — name persisted from a previous session in worktree meta
 * @param input         — session context (prompt, cwd, created-at, …)
 * @param config        — which renamer tool to use
 * @returns             Promise resolving to { displayName, branchName, source }
 */
export async function resolveSessionRename(
  userSetName: string | undefined,
  pinnedName: string | undefined,
  input: RenameInput,
  config: RenamerConfig
): Promise<RenameResult> {
  // 1. Explicit user name (highest precedence)
  if (userSetName && userSetName.trim()) {
    const trimmed = userSetName.trim();
    logger.info('[rename] source=explicit-user displayName="%s"', trimmed);
    return {
      displayName: trimmed,
      branchName: phraseToBranchName(trimmed) || trimmed,
      source: 'explicit-user',
    };
  }

  // 2. Pinned session name
  if (pinnedName && pinnedName.trim()) {
    const trimmed = pinnedName.trim();
    logger.info('[rename] source=pinned displayName="%s"', trimmed);
    return {
      displayName: trimmed,
      branchName: phraseToBranchName(trimmed) || trimmed,
      source: 'pinned',
    };
  }

  // 3. Agent-suggested name (if tool is not 'none')
  if (config.tool !== 'none') {
    const fullPrompt = buildFullPrompt(input);
    let agentResult: { displayName: string; branchName: string } | null = null;

    if (config.tool === 'claude') {
      agentResult = await runClaudeRenamer(fullPrompt, input.cwd);
    } else if (config.tool === 'codex') {
      agentResult = await runCodexRenamer(fullPrompt, input.cwd);
    } else if (config.tool === 'custom-script') {
      if (config.customScript) {
        agentResult = await runCustomScriptRenamer(
          config.customScript,
          fullPrompt,
          input.cwd
        );
      } else {
        logger.warn(
          '[rename] custom-script tool configured but renamerCustomScript is not set; skipping agent branch'
        );
      }
    }

    if (agentResult) {
      logger.info(
        '[rename] source=agent-suggested tool=%s displayName="%s" branchName="%s"',
        config.tool,
        agentResult.displayName,
        agentResult.branchName
      );
      return { ...agentResult, source: 'agent-suggested' };
    }
  }

  // 4. Heuristic name
  const heuristic = buildHeuristicName(
    input.cwd,
    input.repoName,
    input.branchName
  );
  if (heuristic) {
    const branchName = phraseToBranchName(heuristic) || heuristic;
    logger.info('[rename] source=heuristic displayName="%s"', heuristic);
    return { displayName: heuristic, branchName, source: 'heuristic' };
  }

  // 5. Default: timestamp + repo
  const fallback = buildDefaultName(input.createdAt, input.cwd, input.repoName);
  const branchName = phraseToBranchName(fallback) || fallback;
  logger.info('[rename] source=default displayName="%s"', fallback);
  return { displayName: fallback, branchName, source: 'default' };
}
