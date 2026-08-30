#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * critique.mjs — send a scoped slice of the repo to an OpenAI-compatible
 * gateway and write the model's architectural critique to a local markdown
 * report.
 *
 * This is a *research* tool, not a gate. Its output is a prompt for human
 * judgement: every claim it makes has to be grep-verified before it turns
 * into a change. `npm run deadcode` (knip) is the deterministic half of the
 * pair; this is the fuzzy half.
 *
 * Usage:
 *   npm run critique                          # default scope: server/
 *   npm run critique -- server/protocol-adapters
 *   npm run critique -- shared frontend/src/lib --include-tests
 *   npm run critique -- server --out /tmp/report.md --model qwen3-coder-next
 *
 * Flags:
 *   --include-tests     keep *.test.ts / *.spec.ts / test fixtures (default: skipped)
 *   --model <id>        gateway model id (default: deepseek-v4-flash)
 *   --out <path>        report destination (default: a timestamped file under
 *                       the scratch dir; see RELAY_CRITIQUE_OUT_DIR)
 *   --budget <tokens>   input packing budget (default: 200000)
 *   --max-tokens <n>    completion budget (default: 24000 — a reasoning model
 *                       spends most of this before it writes anything)
 *   --reasoning-effort  low | medium | high | max (default: low). Reasoning
 *                       tokens come out of --max-tokens, and on a large scope a
 *                       high-effort model will happily burn the whole budget
 *                       deliberating and emit no report at all.
 *   --dry-run           pack and report sizes, do not call the gateway
 *
 * Credentials: read at runtime from an env file, never from source and never
 * echoed. Default file is ~/.config/finn-nancy/prod.env; override with
 * RELAY_CRITIQUE_ENV_FILE. Already-exported LOCAL_LLM_BASE / LOCAL_LLM_KEY in
 * the process environment win over the file, so CI can inject them instead.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BUDGET_TOKENS = 200_000;
const DEFAULT_MAX_TOKENS = 24_000;
// Reasoning tokens are charged against max_tokens and, on a 100k+ token scope,
// a high-effort reasoning model will spend the entire budget thinking and
// return an empty report. We want findings, not deliberation.
const DEFAULT_REASONING_EFFORT = 'low';
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const CHARS_PER_TOKEN = 4; // rough, deliberately conservative
// Idle watchdog. Must exceed prefill: a 200k-token prompt on a local box can
// sit silent for several minutes before the first output token exists.
const IDLE_TIMEOUT_MS = 12 * 60 * 1000;

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.sql',
]);

const TEST_PATTERN =
  /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// ── argv ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const scopes = [];
  // `--model --dry-run` must not silently set the model to "--dry-run", and a
  // flag at the end of argv must not silently become `undefined`.
  const value = (flag, next) => {
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return next;
  };
  const opts = {
    includeTests: false,
    model: process.env.RELAY_CRITIQUE_MODEL || DEFAULT_MODEL,
    out: null,
    budget: DEFAULT_BUDGET_TOKENS,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--include-tests':
        opts.includeTests = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--model':
        opts.model = value('--model', argv[++i]);
        break;
      case '--out':
        opts.out = value('--out', argv[++i]);
        break;
      case '--budget':
        opts.budget = Number(value('--budget', argv[++i]));
        break;
      case '--max-tokens':
        opts.maxTokens = Number(value('--max-tokens', argv[++i]));
        break;
      case '--reasoning-effort':
        opts.reasoningEffort = value('--reasoning-effort', argv[++i]);
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`unknown flag: ${arg}`);
        }
        scopes.push(arg);
    }
  }
  if (scopes.length === 0) scopes.push('server');
  if (!Number.isFinite(opts.budget) || opts.budget <= 0) {
    throw new Error('--budget must be a positive number of tokens');
  }
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    throw new Error('--max-tokens must be a positive number');
  }
  if (!REASONING_EFFORTS.has(opts.reasoningEffort)) {
    throw new Error(
      `--reasoning-effort must be one of: ${[...REASONING_EFFORTS].join(', ')}`
    );
  }
  return { scopes, opts };
}

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * Parse a shell-style env file into a map. Only `KEY=value` lines are read;
 * `export ` prefixes and surrounding quotes are stripped. Values are never
 * logged by this script — callers must keep it that way.
 */
function readEnvFile(file, wanted) {
  const out = new Map();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length)
      : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Only the keys we were asked for. This file holds a whole production
    // environment; there is no reason to hold the rest in memory.
    if (wanted.has(key)) out.set(key, value);
  }
  return out;
}

function resolveCredentials() {
  const envFile =
    process.env.RELAY_CRITIQUE_ENV_FILE ||
    path.join(os.homedir(), '.config', 'finn-nancy', 'prod.env');
  const fromFile = readEnvFile(
    envFile,
    new Set(['LOCAL_LLM_BASE', 'LOCAL_LLM_KEY'])
  );
  const base = process.env.LOCAL_LLM_BASE || fromFile.get('LOCAL_LLM_BASE');
  const key = process.env.LOCAL_LLM_KEY || fromFile.get('LOCAL_LLM_KEY');
  if (!base || !key) {
    throw new Error(
      `missing LOCAL_LLM_BASE / LOCAL_LLM_KEY.\n` +
        `  Export them, or put them in ${envFile}, or point\n` +
        `  RELAY_CRITIQUE_ENV_FILE at a file that defines them.`
    );
  }
  return { base: base.replace(/\/+$/, ''), key };
}

/**
 * What is safe to print. A base URL is not automatically non-secret: userinfo
 * (`https://user:tok@host/v1`) and query tokens (`?api-key=...`) are both
 * common gateway shapes, and both would otherwise land in stderr, CI logs and
 * agent transcripts alongside a message that says the key is never printed.
 */
function displayEndpoint(base) {
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<unparseable endpoint>';
  }
}

// ── packing ─────────────────────────────────────────────────────────────────

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Tracked files under the given scopes. `git ls-files` is the .gitignore
 * contract itself, so nothing ignored, generated, or untracked can leak into
 * the payload.
 */
function collectFiles(root, scopes, includeTests) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...scopes], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listed.split('\0').filter(Boolean);
  return files
    .filter((f) => TEXT_EXTENSIONS.has(path.extname(f)))
    .filter((f) => includeTests || !TEST_PATTERN.test(f))
    .sort();
}

const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Pick the largest per-file character cap that keeps the whole payload inside
 * the budget. Truncating every oversized file to the same cap keeps small
 * modules whole (where most structural signal lives) and only clips the few
 * megamodules, instead of dropping files wholesale — a dropped file reads to
 * the model as "this does not exist", which is exactly how you get
 * hallucinated dead-code claims.
 */
function solvePerFileCap(sizes, budgetChars) {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budgetChars) return Infinity;
  let lo = 0;
  let hi = Math.max(...sizes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const packed = sizes.reduce((acc, s) => acc + Math.min(s, mid), 0);
    if (packed <= budgetChars) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const ELISION = (n) =>
  `\n\n/* … ${n} characters elided by critique.mjs … */\n\n`;
const ELISION_OVERHEAD = ELISION(999_999).length;

/** Per-file wrapper: the `===== FILE: path =====` banner plus the code fence. */
const framingChars = (file) =>
  `\n===== FILE: ${file} =====\n\`\`\`${path.extname(file).slice(1) || 'text'}\n\n\`\`\`\n`
    .length;

/** Keep the head and the tail; the middle of a big module is the least load-bearing part. */
function truncate(text, cap) {
  if (text.length <= cap) return { text, truncated: false };
  // Below this the marker is longer than the budget it is meant to respect,
  // and truncating would return *more* text than `cap`.
  if (cap <= ELISION_OVERHEAD) {
    return { text: text.slice(0, Math.max(0, cap)), truncated: true };
  }
  const headChars = Math.floor(cap * 0.7);
  const tailChars = cap - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  return {
    text: `${head}${ELISION(text.length - cap)}${tail}`,
    truncated: true,
  };
}

function packPayload(root, files, budgetTokens) {
  // The budget covers the whole payload, so the per-file banners, fences and
  // elision markers come out of it before the solver sees it. Without this
  // `--budget` is an underestimate — badly so at small caps, where the marker
  // alone can exceed the solved cap.
  const overhead = files.reduce(
    (acc, f) => acc + framingChars(f) + ELISION_OVERHEAD,
    0
  );
  const budgetChars = Math.max(
    files.length,
    budgetTokens * CHARS_PER_TOKEN - overhead
  );
  const contents = files.map((f) =>
    fs.readFileSync(path.join(root, f), 'utf8')
  );
  const cap = solvePerFileCap(
    contents.map((c) => c.length),
    budgetChars
  );

  const chunks = [];
  const truncatedFiles = [];
  let chars = 0;
  for (let i = 0; i < files.length; i += 1) {
    const { text, truncated } = truncate(contents[i], cap);
    if (truncated) truncatedFiles.push(files[i]);
    const lang = path.extname(files[i]).slice(1) || 'text';
    const block = `\n===== FILE: ${files[i]} =====\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
    chunks.push(block);
    chars += block.length;
  }
  return { body: chunks.join(''), chars, truncatedFiles, cap };
}

// ── prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior engineer auditing a TypeScript codebase you did not write.
You produce specific, falsifiable findings, never generic advice.

Hard rules:
- Every finding MUST cite at least one concrete file path from the supplied source, and a symbol or line region.
- Never suggest generic best practices ("add tests", "improve error handling", "consider TypeScript strict mode") unless you point at the exact code that is wrong and say what breaks.
- If you are not confident a symbol is unused, say "candidate" and name the grep that would settle it. Do not assert.
- Some files are truncated in the middle and marked as such. Never claim something is missing or dead based on a region you cannot see.
- Prefer 10 sharp findings over 40 shallow ones. An empty section is a valid answer.`;

function userPrompt(scopes, fileCount, truncatedCount, body) {
  return `# Repository critique request

Codebase: relay-ide — a channel-first agent workspace. A hub serves a React UI
and a stable gateway; nodes own processes, files, repos and terminals. Agent
providers are integrated behind protocol adapters.

Scope under review: ${scopes.join(', ')}
Files supplied: ${fileCount} (${truncatedCount} truncated in the middle)

Only the files below are supplied. The rest of the repository exists but you
cannot see it — so a symbol with no caller *inside this scope* may still be
called from outside it. Treat that as a candidate, not a verdict.

Produce a markdown report with exactly these sections:

## 1. Dead / vestigial code candidates
Symbols, files, branches, flags or whole subsystems that look unreachable or
superseded. For each: path, symbol, why you believe it is dead, and the single
command that would confirm or refute it.

## 2. Duplication
Logic implemented more than once. Cite every copy by path + symbol, say which
one looks canonical, and what the shared seam would be.

## 3. Layering violations
Places where a module reaches across a boundary it should not (transport into
domain, UI concepts in server code, adapter-specific knowledge leaking into
shared/generic code, direct filesystem or process access from a layer that
should be injected). Cite path + line region.

## 4. Complexity hotspots
The files or functions carrying the most accidental complexity. Say what makes
them hard — not just that they are long — and what the decomposition seam is.

## 5. Concrete improvements
Ranked, each with: the file(s), the change, the risk, and roughly how large it is.

# Source

${body}`;
}

// ── gateway ─────────────────────────────────────────────────────────────────

/** Belt and braces: the key must not survive into anything we print. */
function scrub(text, key) {
  return key ? text.split(key).join('[redacted]') : text;
}

/**
 * Streamed, deliberately. A ~200k-token prefill on a local box takes minutes
 * before the first output token exists, and a non-streamed POST spends that
 * whole window with zero bytes on the wire — long enough for an intermediate
 * proxy to drop the socket and hand back an opaque `fetch failed`. SSE keeps
 * data flowing from the first token and lets us report progress.
 */
async function callGateway({
  base,
  key,
  model,
  maxTokens,
  reasoningEffort,
  messages,
  onTick,
}) {
  const controller = new AbortController();
  // Idle watchdog, not a wall-clock deadline: a slow model that is still
  // emitting is healthy, a fast model that stopped emitting is not.
  let idleTimer;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  armIdle();

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        // Ignored by non-reasoning models; gateways that do not know the field
        // drop it rather than erroring.
        reasoning_effort: reasoningEffort,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      // Never interpolate a gateway body without scrubbing. Several
      // OpenAI-compatible proxies echo the received `Authorization` header in
      // their 401 body — the one failure an operator is most likely to paste
      // into a chat asking why auth broke.
      throw new Error(
        `gateway returned ${res.status} ${res.statusText}: ` +
          `${scrub(text, key).slice(0, 500)}`
      );
    }
    if (!res.body) throw new Error('gateway returned no response body');

    let content = '';
    let reasoningChars = 0;
    let finishReason = 'unknown';
    let usage = null;
    let buffered = '';
    let undecodableFrames = 0;

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        // `lines.pop()` guarantees this line is complete, so this is never a
        // partial frame — it is corruption or a multi-line `data:` field.
        // Count it rather than losing content silently.
        undecodableFrames += 1;
        return;
      }
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) {
        reasoningChars += delta.reasoning_content.length;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      onTick?.({ contentChars: content.length, reasoningChars });
    };

    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      armIdle();
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    // The last frame often arrives without a trailing newline, and it is the
    // one carrying `finish_reason` and `usage`. Dropping it would make a
    // truncated report look clean, which is the worst failure this tool has.
    buffered += decoder.decode();
    for (const line of buffered.split('\n')) handleLine(line);

    return { content, reasoningChars, finishReason, usage, undecodableFrames };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `gateway went idle for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s — aborted`,
        { cause: err }
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`gateway request failed: ${scrub(detail, key)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(idleTimer);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * These reports are model output, not repository content: a 40 KB wall of
 * unverified claims committed next to the code it critiques is worse than no
 * report at all. Nudge, do not block — someone may deliberately want it in a
 * scratch dir that happens to live under the tree.
 */
function warnIfInsideRepo(root, outPath) {
  const rel = path.relative(root, path.resolve(outPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  console.error(
    `critique: WARNING writing inside the repo (${rel}). ` +
      `Critique reports are not committed — move it or add it to .gitignore.`
  );
}

function defaultOutPath(root, scopes) {
  const dir =
    process.env.RELAY_CRITIQUE_OUT_DIR ||
    path.join(os.tmpdir(), 'relay-critique');
  const slug =
    scopes
      .join('-')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'repo';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  void root;
  return path.join(dir, `critique-${slug}-${stamp}.md`);
}

async function main() {
  const { scopes, opts } = parseArgs(process.argv.slice(2));
  const root = repoRoot();

  const files = collectFiles(root, scopes, opts.includeTests);
  if (files.length === 0) {
    throw new Error(
      `no tracked source files under: ${scopes.join(', ')}\n` +
        `  (paths are relative to the repo root; only ${[...TEXT_EXTENSIONS].join(', ')} are packed)`
    );
  }

  const { body, chars, truncatedFiles, cap } = packPayload(
    root,
    files,
    opts.budget
  );
  const estIn = estimateTokens(chars);

  console.error(
    `critique: ${files.length} files, ~${estIn.toLocaleString()} tokens packed` +
      (truncatedFiles.length
        ? `, ${truncatedFiles.length} truncated at ${cap.toLocaleString()} chars`
        : '')
  );

  const outPath = opts.out || defaultOutPath(root, scopes);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  warnIfInsideRepo(root, outPath);

  if (opts.dryRun) {
    console.error('critique: --dry-run, not calling the gateway');
    for (const f of truncatedFiles) console.error(`  truncated: ${f}`);
    return;
  }

  const { base, key } = resolveCredentials();
  console.error(
    `critique: model=${opts.model} reasoning=${opts.reasoningEffort} ` +
      `endpoint=${displayEndpoint(base)}`
  );

  const started = Date.now();
  let lastTick = 0;
  const result = await callGateway({
    base,
    key,
    model: opts.model,
    maxTokens: opts.maxTokens,
    reasoningEffort: opts.reasoningEffort,
    onTick: ({ contentChars, reasoningChars }) => {
      const now = Date.now();
      if (now - lastTick < 10_000) return;
      lastTick = now;
      process.stderr.write(
        `critique: ${((now - started) / 1000).toFixed(0)}s — ` +
          `${reasoningChars} reasoning chars, ${contentChars} report chars\r`
      );
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: userPrompt(scopes, files.length, truncatedFiles.length, body),
      },
    ],
  });
  process.stderr.write('\n');
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);

  if (!result.content.trim()) {
    throw new Error(
      `gateway returned empty content (finish_reason=${result.finishReason}, ` +
        `reasoning=${result.reasoningChars} chars). ` +
        `A reasoning model spends max_tokens on reasoning before it writes: ` +
        `lower --reasoning-effort, raise --max-tokens, or narrow the scope.`
    );
  }

  const header = [
    `<!-- generated by scripts/critique.mjs — not a gate, not committed -->`,
    ``,
    `# Critique — ${scopes.join(', ')}`,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| Model | \`${opts.model}\` |`,
    `| Scope | ${scopes.map((s) => `\`${s}\``).join(', ')} |`,
    `| Files packed | ${files.length}${opts.includeTests ? '' : ' (tests excluded)'} |`,
    `| Files truncated | ${truncatedFiles.length} |`,
    `| Est. input tokens | ~${estIn.toLocaleString()} |`,
    `| Reasoning effort | \`${opts.reasoningEffort}\` |`,
    `| Completion tokens | ${result.usage?.completion_tokens ?? 'n/a'} (of ${opts.maxTokens} allowed) |`,
    `| Reasoning emitted | ${result.reasoningChars.toLocaleString()} chars (discarded) |`,
    `| finish_reason | \`${result.finishReason}\` |`,
    `| Wall time | ${elapsedS}s |`,
    `| Generated | ${new Date().toISOString()} |`,
    ``,
    `> Every claim below is a hypothesis. Grep-verify before acting. Cross-check`,
    `> dead-code claims against \`npm run deadcode\`.`,
    ``,
    truncatedFiles.length
      ? `<details><summary>Truncated files (${truncatedFiles.length})</summary>\n\n${truncatedFiles.map((f) => `- \`${f}\``).join('\n')}\n\n</details>\n`
      : '',
    `---`,
    ``,
  ].join('\n');

  fs.writeFileSync(outPath, header + result.content + '\n', 'utf8');
  console.error(`critique: wrote ${outPath}`);
  if (result.undecodableFrames > 0) {
    console.error(
      `critique: WARNING ${result.undecodableFrames} stream frame(s) could not be decoded — the report may be missing content`
    );
  }
  if (result.finishReason === 'length') {
    console.error(
      'critique: WARNING finish_reason=length — the report is cut off, raise --max-tokens'
    );
  }
  console.log(outPath);
}

main().catch((err) => {
  console.error(`critique: ${err.message}`);
  process.exitCode = 1;
});
