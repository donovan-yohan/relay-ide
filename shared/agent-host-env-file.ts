import fs from 'node:fs';
import path from 'node:path';

/**
 * #1455 slice 4: plant a Relay actor credential in an agent host's per-profile
 * environment file.
 *
 * This module knows nothing about Hermes. It is the generic half of the recipe:
 * "put `NAME=value` into a dotenv-style file that some other process hydrates
 * into an agent's environment", written so the file survives the edit. Which
 * host, which path, and which profile are the operator's business — the
 * Hermes-specific paths live in `docs/references/hermes-multiplex-setup.md`,
 * never in an adapter or in this file.
 *
 * The rules that make it safe to run against a file holding somebody else's
 * secrets:
 *
 * - **Every other line survives byte for byte.** Only the target assignment is
 *   touched; comments, blank lines, ordering, and the file's line endings are
 *   preserved. A `.env` on an agent host is not ours to reformat.
 * - **Fail closed on loose permissions.** A file any other local user can read
 *   is not a place to put a credential. We refuse rather than silently
 *   tightening it, because the operator may have shared it deliberately and a
 *   surprise `chmod` is its own incident.
 * - **Exactly one assignment afterwards.** Duplicates of the target name are
 *   removed, so the result does not depend on whether the reader's dotenv
 *   dialect takes the first or the last occurrence.
 * - **Idempotent.** Writing the value already present is a no-op: no rewrite,
 *   no backup, no mtime change.
 * - **Backup before the first destructive write**, at the same mode, with a
 *   timestamped name that never clobbers an earlier backup.
 * - **The value is never returned, logged, or embedded in an error.** Callers
 *   get an action and a path; the secret goes to the file and nowhere else.
 */

/** Mode a newly created environment file is born with. */
export const AGENT_HOST_ENV_FILE_MODE = 0o600;

/**
 * Values are written unquoted, so the charset has to be one that every dotenv
 * dialect and `set -a; . file` agree on. A Relay actor token is
 * `relay-sac-v1.<uuid>.<hex>`, comfortably inside this. Anything else is
 * refused rather than quoted by guesswork — quoting rules differ between
 * python-dotenv, node dotenv, and the shell, and a value that round-trips
 * through one and not another is the worst possible failure here.
 */
const SAFE_VALUE = /^[A-Za-z0-9._:/+=@-]+$/;

/** POSIX-ish env var names. Deliberately no lowercase: these are exported. */
const SAFE_NAME = /^[A-Z][A-Z0-9_]*$/;

export type EnvFileUpsertAction = 'created' | 'updated' | 'unchanged';

export interface EnvFileUpsertResult {
  /** Absolute path to the file that was inspected or written. */
  envFile: string;
  /** Variable names that were upserted, in the order supplied. */
  variables: string[];
  /** What actually happened to the file. */
  action: EnvFileUpsertAction;
  /** Backup written before a destructive rewrite, absent otherwise. */
  backupFile?: string;
  /** Resulting file mode, as an octal string (e.g. `600`). */
  mode: string;
  /** Duplicate assignments of the target names that were collapsed away. */
  duplicatesRemoved: number;
}

export interface EnvFileAssignment {
  name: string;
  value: string;
}

export interface UpsertEnvFileOptions {
  /** Path to the environment file. Its parent directory must already exist. */
  envFile: string;
  /** Assignments to upsert. Names must be unique within one call. */
  assignments: readonly EnvFileAssignment[];
  /** Injectable clock, for the backup suffix. Tests pin it. */
  now?: () => Date;
}

/** Thrown for every refusal, so callers can report without leaking a value. */
export class EnvFileError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'EnvFileError';
  }
}

/**
 * Matches an assignment line for `name`, with or without a `export ` prefix and
 * with arbitrary leading whitespace, which is how these files are written in
 * the wild. A commented-out `# NAME=...` is NOT an assignment and is left
 * alone: it is documentation, and rewriting somebody's note is not our job.
 */
function assignmentPattern(name: string): RegExp {
  return new RegExp(`^(\\s*)(export\\s+)?${name}\\s*=`);
}

/**
 * Split into lines while remembering the original terminators, so a CRLF file
 * stays CRLF and a file with no trailing newline does not silently gain one on
 * a line we did not touch.
 */
interface SplitLine {
  text: string;
  terminator: string;
}

function splitLines(raw: string): SplitLine[] {
  const lines: SplitLine[] = [];
  let index = 0;
  while (index < raw.length) {
    const next = raw.indexOf('\n', index);
    if (next === -1) {
      lines.push({ text: raw.slice(index), terminator: '' });
      break;
    }
    const text = raw.slice(index, next);
    const hasCarriageReturn = text.endsWith('\r');
    lines.push({
      text: hasCarriageReturn ? text.slice(0, -1) : text,
      terminator: hasCarriageReturn ? '\r\n' : '\n',
    });
    index = next + 1;
  }
  return lines;
}

function joinLines(lines: readonly SplitLine[]): string {
  return lines.map((line) => `${line.text}${line.terminator}`).join('');
}

/** Opens a quoted value: `NAME="` or `NAME='`, capturing the quote character. */
const QUOTED_VALUE_START =
  /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(['"])/;

/**
 * Index the lines that are the CONTINUATION of a multi-line quoted value, so a
 * `NAME=` sitting inside somebody's quoted block is never mistaken for an
 * assignment.
 *
 * A `.env` holding a PEM key is the case that matters:
 *
 *     SIGNING_KEY="-----BEGIN PRIVATE KEY-----
 *     …
 *     -----END PRIVATE KEY-----"
 *
 * A naive line scanner that matched inside that block would rewrite a line of
 * somebody's private key. Escaped quotes are not modelled.
 *
 * A block still open at end of file is REFUSED rather than appended to: an
 * append there would land inside that value for every parser that supports
 * multi-line quoted values, so the variable would silently never be set while
 * the receipt claimed success. Refusing is the only honest answer — we cannot
 * tell a truncated file from a dialect we do not understand.
 */
function quotedContinuationLines(lines: readonly SplitLine[]): {
  inside: Set<number>;
  unterminated: boolean;
} {
  const inside = new Set<number>();
  let openQuote: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? '';
    if (openQuote !== null) {
      inside.add(index);
      if (text.includes(openQuote)) openQuote = null;
      continue;
    }
    const match = QUOTED_VALUE_START.exec(text);
    if (!match) continue;
    const quote = match[1] as string;
    if (!text.slice(match[0].length).includes(quote)) openQuote = quote;
  }
  return { inside, unterminated: openQuote !== null };
}

/** The terminator to give an appended line: whatever the file already uses. */
function dominantTerminator(lines: readonly SplitLine[]): string {
  const crlf = lines.filter((line) => line.terminator === '\r\n').length;
  const lf = lines.filter((line) => line.terminator === '\n').length;
  return crlf > lf ? '\r\n' : '\n';
}

function validateAssignments(assignments: readonly EnvFileAssignment[]): void {
  if (assignments.length === 0) {
    throw new EnvFileError('no assignments supplied', 'NO_ASSIGNMENTS');
  }
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (!SAFE_NAME.test(assignment.name)) {
      throw new EnvFileError(
        `${assignment.name || '(empty)'} is not a valid environment variable name`,
        'INVALID_NAME'
      );
    }
    if (seen.has(assignment.name)) {
      throw new EnvFileError(
        `${assignment.name} was supplied twice`,
        'DUPLICATE_NAME'
      );
    }
    seen.add(assignment.name);
    // The value is a secret in the case this exists for, so it is described,
    // never echoed. `length` is the most a refusal may say about it.
    if (!assignment.value) {
      throw new EnvFileError(
        `${assignment.name} has an empty value`,
        'EMPTY_VALUE'
      );
    }
    if (!SAFE_VALUE.test(assignment.value)) {
      throw new EnvFileError(
        `${assignment.name} has a value containing characters that cannot be written unquoted (length ${assignment.value.length})`,
        'UNSAFE_VALUE'
      );
    }
  }
}

/** Refuse a file any other local user can read. */
function readExistingMode(envFile: string): number | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(envFile);
  } catch (error) {
    // ONLY "it is not there" means "create it". An ELOOP, EACCES, or EOVERFLOW
    // swallowed here would take the create branch — no backup, then a rename
    // straight over a file we could not read. Fail loudly instead.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
  if (!stats.isFile()) {
    throw new EnvFileError(`${envFile} is not a regular file`, 'NOT_A_FILE');
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new EnvFileError(
      `${envFile} is readable by group or other (mode ${mode.toString(8).padStart(3, '0')}); run \`chmod 600\` on it before planting a credential`,
      'LOOSE_MODE'
    );
  }
  return mode;
}

function backupSuffix(now: Date): string {
  // Second resolution with the punctuation stripped: sorts lexically, is legal
  // on every filesystem, and two runs in the same second are the only
  // collision — which the `wx` open below turns into a distinct name.
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function writeBackup(
  envFile: string,
  contents: string,
  mode: number,
  now: Date
): string {
  const base = `${envFile}.bak-${backupSuffix(now)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      // `wx` never overwrites: an existing backup is a previous state of this
      // file and is worth more than the one we are about to take.
      fs.writeFileSync(candidate, contents, {
        encoding: 'utf8',
        mode,
        flag: 'wx',
      });
      fs.chmodSync(candidate, mode);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new EnvFileError(
    `could not find a free backup name next to ${envFile}`,
    'BACKUP_EXHAUSTED'
  );
}

function atomicWrite(envFile: string, contents: string, mode: number): void {
  const directory = path.dirname(envFile);
  const prefix = `.${path.basename(envFile)}.tmp-${process.pid}-${Date.now()}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tempPath = path.join(
      directory,
      attempt === 0 ? prefix : `${prefix}-${attempt}`
    );
    try {
      // `wx`, not the default `w`. `writeFileSync`'s `mode` is honoured only
      // when the call CREATES the file, and `chmodSync` runs after the bytes
      // are already on disk — so with `w` a pre-existing world-readable file
      // at this path (or a symlink planted there by anyone who can write the
      // directory) would receive the token first and be tightened afterwards,
      // or not at all. `wx` refuses both: EEXIST on a regular file and on a
      // symlink alike.
      fs.writeFileSync(tempPath, contents, {
        encoding: 'utf8',
        mode,
        flag: 'wx',
      });
      try {
        fs.chmodSync(tempPath, mode);
        fs.renameSync(tempPath, envFile);
      } catch (error) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* nothing to clean up */
        }
        throw error;
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new EnvFileError(
    `could not create a temporary file next to ${envFile}`,
    'TEMP_EXHAUSTED'
  );
}

/**
 * Upsert `assignments` into `envFile`, returning what changed. Never returns or
 * throws a value.
 */
export interface EnvFilePreflight {
  /** The real path written to: a symlink is followed, never replaced. */
  envFile: string;
  /**
   * The path the caller named. Backups are taken HERE rather than beside the
   * resolved file: a `.env` symlinked into a dotfiles checkout is the whole
   * reason we follow the link, and dropping a secret-bearing `.bak-` beside
   * the link target would put the previous credential inside a git working
   * tree, one `git add -A` from being committed.
   */
  requestedPath: string;
  /** Current mode when the file exists, null when it does not yet. */
  existingMode: number | null;
}

export function preflightEnvFile(envFilePath: string): EnvFilePreflight {
  const requested = path.resolve(envFilePath);
  const directory = path.dirname(requested);
  if (!fs.existsSync(directory)) {
    throw new EnvFileError(
      `${directory} does not exist; create the profile before planting a credential`,
      'MISSING_DIRECTORY'
    );
  }
  // Resolve through a symlink so the atomic rename replaces the FILE, not the
  // link. A `.env` symlinked into a dotfiles checkout is common enough that
  // silently converting the link into a regular file would be a nasty surprise.
  let envFile = requested;
  try {
    if (fs.lstatSync(requested).isSymbolicLink()) {
      envFile = fs.realpathSync(requested);
    }
  } catch {
    /* does not exist yet; the requested path is the one to create */
  }
  return {
    envFile,
    requestedPath: requested,
    existingMode: readExistingMode(envFile),
  };
}

export function upsertEnvFile(
  options: UpsertEnvFileOptions
): EnvFileUpsertResult {
  validateAssignments(options.assignments);
  const now = options.now?.() ?? new Date();

  const { envFile, requestedPath, existingMode } = preflightEnvFile(
    options.envFile
  );
  const mode = existingMode ?? AGENT_HOST_ENV_FILE_MODE;
  const original =
    existingMode === null ? '' : fs.readFileSync(envFile, 'utf8');

  const lines = splitLines(original);
  const terminator = dominantTerminator(lines);
  let duplicatesRemoved = 0;

  for (const { name, value } of options.assignments) {
    // Recomputed per assignment: the previous one may have spliced a duplicate
    // out, and a stale index set would then point at the wrong lines.
    const quoted = quotedContinuationLines(lines);
    if (quoted.unterminated) {
      throw new EnvFileError(
        `${envFile} ends inside an unterminated quoted value; fix the quoting before planting a credential`,
        'UNBALANCED_QUOTE'
      );
    }
    const pattern = assignmentPattern(name);
    let replaced = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || quoted.inside.has(index)) continue;
      const match = pattern.exec(line.text);
      if (!match) continue;
      if (replaced) {
        // A duplicate earlier in the file. Drop it so the result does not
        // depend on the reader's first-wins/last-wins convention.
        lines.splice(index, 1);
        duplicatesRemoved += 1;
        continue;
      }
      // Rewrite in place, keeping the line's indent AND its `export ` prefix.
      // Dropping `export` would be a silent functional regression: a `.env`
      // read by a plain `. file` would stop exporting the variable, and the
      // agent's child process would stop seeing it.
      lines[index] = {
        text: `${match[1] ?? ''}${match[2] ?? ''}${name}=${value}`,
        terminator: line.terminator || terminator,
      };
      replaced = true;
    }
    if (replaced) continue;
    const last = lines[lines.length - 1];
    if (last && last.terminator === '') {
      // File did not end with a newline; give the last line one so the new
      // assignment does not graft onto it.
      lines[lines.length - 1] = { text: last.text, terminator };
    }
    lines.push({ text: `${name}=${value}`, terminator });
  }

  const next = joinLines(lines);
  if (existingMode !== null && next === original) {
    return {
      envFile,
      variables: options.assignments.map((assignment) => assignment.name),
      action: 'unchanged',
      mode: mode.toString(8).padStart(3, '0'),
      duplicatesRemoved: 0,
    };
  }

  const backupFile =
    existingMode === null
      ? undefined
      : writeBackup(requestedPath, original, mode, now);
  atomicWrite(envFile, next, mode);

  return {
    envFile,
    variables: options.assignments.map((assignment) => assignment.name),
    action: existingMode === null ? 'created' : 'updated',
    ...(backupFile ? { backupFile } : {}),
    mode: mode.toString(8).padStart(3, '0'),
    duplicatesRemoved,
  };
}

/**
 * Extract the one-time token from whatever
 * `relay-ide v1 agent-profiles credential mint` produced: the full CLI
 * envelope, the bare route response, or the raw token on its own line.
 *
 * Accepting all three is what lets the documented recipe be a pipe, which is
 * the whole point — a token that goes stdout-to-stdin never lands in a shell
 * history, an argv, or a scrollback.
 */
export function extractMintedToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EnvFileError('no token on stdin', 'EMPTY_INPUT');
  }
  if (!trimmed.startsWith('{')) {
    if (!trimmed.startsWith('relay-sac-v1.')) {
      throw new EnvFileError(
        'stdin was neither a mint envelope nor a relay-sac-v1 token',
        'UNRECOGNIZED_INPUT'
      );
    }
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new EnvFileError('stdin was not valid JSON', 'INVALID_JSON');
  }
  const envelope = parsed as Record<string, unknown>;
  // `ok === false` OR a bare `error` object: a failure envelope that omitted
  // `ok` must not fall through to the "only mint returns a token" message,
  // which would misdiagnose an upstream refusal as operator error.
  if (envelope['ok'] === false || typeof envelope['error'] === 'object') {
    const error = envelope['error'] as Record<string, unknown> | null;
    throw new EnvFileError(
      `mint failed upstream: ${String(error?.['code'] ?? 'UNKNOWN')} ${String(error?.['message'] ?? '')}`.trim(),
      'MINT_FAILED'
    );
  }
  const data = (envelope['data'] ?? envelope) as Record<string, unknown>;
  const token = data['token'];
  if (typeof token !== 'string' || !token.startsWith('relay-sac-v1.')) {
    throw new EnvFileError(
      'mint response carried no `token`; `status` and `revoke` never return one — only `mint` does',
      'NO_TOKEN'
    );
  }
  return token;
}
