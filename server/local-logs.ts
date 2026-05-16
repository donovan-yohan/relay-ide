import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_LOG_LINES = 100;
const TAIL_CHUNK_SIZE = 64 * 1024;

export type LocalLogRole = 'hub' | 'node';

export interface LocalLogPlan {
  logDir: string;
  files: string[];
}

export interface LocalLogSnapshot {
  status: 'ok' | 'missing' | 'empty';
  logDir: string;
  files: string[];
  output: string;
  message: string;
}

export interface LocalLogFollower {
  files: string[];
  close(): void;
}

interface FollowedFileIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface FollowedFileState {
  offset: number;
  identity?: FollowedFileIdentity;
}

export function parseLogLineCount(
  value: string | undefined,
  fallback = DEFAULT_LOG_LINES
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --lines value: ${value}. Expected a non-negative integer.`);
  }
  return Number(value);
}

export function resolveLocalLogPlan(
  configPath: string,
  serviceLogDir?: string | null
): LocalLogPlan {
  const configLogDir = path.join(path.dirname(path.resolve(configPath)), 'logs');
  const logDirs = [configLogDir];
  if (serviceLogDir) logDirs.push(path.resolve(serviceLogDir));
  const uniqueDirs = Array.from(new Set(logDirs));
  const files = uniqueDirs.flatMap((dir) => [
    path.join(dir, 'relay-ide.log'),
    path.join(dir, 'stdout.log'),
    path.join(dir, 'stderr.log'),
  ]);
  return { logDir: configLogDir, files: Array.from(new Set(files)) };
}

export function readLocalLogSnapshot(options: {
  role: LocalLogRole;
  configPath: string;
  serviceLogDir?: string | null;
  lines?: number;
}): LocalLogSnapshot {
  const lines = options.lines ?? DEFAULT_LOG_LINES;
  const plan = resolveLocalLogPlan(options.configPath, options.serviceLogDir);
  const readableFiles = plan.files.filter(isReadableFile);

  if (readableFiles.length === 0) {
    return {
      status: 'missing',
      logDir: plan.logDir,
      files: plan.files,
      output: '',
      message: missingLogsMessage(options.role, plan),
    };
  }

  const chunks: Array<{ file: string; text: string }> = [];
  const readFiles: string[] = [];

  for (const file of readableFiles) {
    const text = safeReadLastLines(file, lines);
    if (text === undefined) continue;
    readFiles.push(file);
    if (text.length > 0) chunks.push({ file, text });
  }

  if (readFiles.length === 0) {
    return {
      status: 'missing',
      logDir: plan.logDir,
      files: plan.files,
      output: '',
      message: missingLogsMessage(options.role, plan),
    };
  }

  if (chunks.length === 0) {
    return {
      status: 'empty',
      logDir: plan.logDir,
      files: readFiles,
      output: '',
      message: emptyLogsMessage(options.role, readFiles),
    };
  }

  const output = chunks
    .map((entry) => formatLogChunk(entry.file, entry.text, chunks.length > 1))
    .join('');

  return {
    status: 'ok',
    logDir: plan.logDir,
    files: readableFiles,
    output,
    message: '',
  };
}

export function createLocalLogFollower(options: {
  files: string[];
  write: (chunk: string) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
}): LocalLogFollower {
  const followedFiles = new Map<string, FollowedFileState>();
  const files = Array.from(new Set(options.files));
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  const pollFile = (file: string): void => {
    let curr: fs.Stats;
    try {
      curr = fs.statSync(file);
    } catch {
      return;
    }
    if (!curr.isFile()) return;

    const previousState = followedFiles.get(file) ?? { offset: 0 };
    const currentIdentity = fileIdentity(curr);
    const rotated = !sameFileIdentity(previousState.identity, currentIdentity);
    const start = rotated || curr.size < previousState.offset ? 0 : previousState.offset;
    if (curr.size <= start) {
      followedFiles.set(file, { offset: curr.size, identity: currentIdentity });
      return;
    }
    try {
      followedFiles.set(file, { offset: curr.size, identity: currentIdentity });
      const stream = fs.createReadStream(file, {
        start,
        end: curr.size - 1,
        encoding: 'utf8',
      });
      stream.on('data', (chunk) => options.write(String(chunk)));
      stream.on('error', (error) => options.onError?.(error));
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  for (const file of files) {
    followedFiles.set(file, initialFollowedFileState(file));
  }

  const pollTimer = setInterval(() => {
    for (const file of files) pollFile(file);
  }, pollIntervalMs);

  return {
    files,
    close() {
      clearInterval(pollTimer);
    },
  };
}

function readLastLines(filePath: string, lines: number): string {
  if (lines === 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return '';
    const chunks: Buffer[] = [];
    let position = size;
    let newlineCount = 0;

    while (position > 0 && newlineCount < lines) {
      const length = Math.min(TAIL_CHUNK_SIZE, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, position);
      if (bytesRead === 0) continue;
      const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      newlineCount += countNewlines(chunk);
    }

    return takeLastLines(Buffer.concat(chunks).toString('utf8'), lines);
  } finally {
    fs.closeSync(fd);
  }
}

function safeReadLastLines(filePath: string, lines: number): string | undefined {
  try {
    return readLastLines(filePath, lines);
  } catch {
    return undefined;
  }
}

function takeLastLines(text: string, lines: number): string {
  const endsWithNewline = text.endsWith('\n');
  const parts = text.split('\n');
  if (endsWithNewline) parts.pop();
  const selected = parts.slice(-lines).join('\n');
  if (!selected) return '';
  return selected + (endsWithNewline ? '\n' : '');
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) count += 1;
  }
  return count;
}

function isReadableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function initialFollowedFileState(filePath: string): FollowedFileState {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { offset: stat.size, identity: fileIdentity(stat) } : { offset: 0 };
  } catch {
    return { offset: 0 };
  }
}

function fileIdentity(stat: fs.Stats): FollowedFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  };
}

function sameFileIdentity(
  previous: FollowedFileIdentity | undefined,
  current: FollowedFileIdentity
): boolean {
  return (
    previous !== undefined &&
    previous.dev === current.dev &&
    previous.ino === current.ino &&
    previous.birthtimeMs === current.birthtimeMs
  );
}

function formatLogChunk(file: string, text: string, includeHeader: boolean): string {
  if (!includeHeader) return text;
  return `==> ${file} <==\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

function missingLogsMessage(role: LocalLogRole, plan: LocalLogPlan): string {
  const startCommand = role === 'hub' ? 'relay-ide hub' : 'relay-ide node link --hub <url>';
  return [
    `No local Relay ${role} log files were found in ${plan.logDir}.`,
    'Checked:',
    ...plan.files.map((file) => `  ${file}`),
    `Start Relay with ${startCommand}, or install/start the Relay-managed service, then try again.`,
  ].join('\n');
}

function emptyLogsMessage(role: LocalLogRole, files: string[]): string {
  return [
    `Local Relay ${role} log files exist but are empty.`,
    'Checked:',
    ...files.map((file) => `  ${file}`),
    'If Relay was started manually, the useful output may still be in that foreground terminal.',
  ].join('\n');
}
