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
  const offsets = new Map<string, number>();
  const files = Array.from(new Set(options.files));
  for (const file of files) {
    offsets.set(file, initialOffset(file));
    fs.watchFile(
      file,
      { interval: options.pollIntervalMs ?? 500, persistent: true },
      (curr) => {
        if (!curr.isFile()) return;
        const previousOffset = offsets.get(file) ?? 0;
        const start = curr.size < previousOffset ? 0 : previousOffset;
        if (curr.size <= start) return;
        try {
          const stream = fs.createReadStream(file, {
            start,
            end: curr.size - 1,
            encoding: 'utf8',
          });
          stream.on('data', (chunk) => options.write(String(chunk)));
          stream.on('error', (error) => options.onError?.(error));
          stream.on('end', () => offsets.set(file, curr.size));
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    );
  }

  return {
    files,
    close() {
      for (const file of files) fs.unwatchFile(file);
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

function initialOffset(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
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
