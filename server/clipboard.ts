import { execFile, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SUPPORTED_MIME: Record<string, { ext: string; osascriptClass: string }> =
  {
    'image/png': { ext: '.png', osascriptClass: '«class PNGf»' },
    'image/jpeg': { ext: '.jpg', osascriptClass: '«class JPEG»' },
    'image/gif': { ext: '.gif', osascriptClass: '«class GIFf»' },
    'image/webp': { ext: '.webp', osascriptClass: '«class PNGf»' },
  };

let cachedTool: string | null | undefined;

export function detectClipboardTool(): string | null {
  if (cachedTool !== undefined) return cachedTool;

  if (process.platform === 'darwin') {
    cachedTool = 'osascript';
    return cachedTool;
  }

  if (process.env['WAYLAND_DISPLAY']) {
    try {
      execFileSync('which', ['wl-copy'], { stdio: 'ignore' });
      cachedTool = 'wl-copy';
      return cachedTool;
    } catch {
      // wl-copy not found
    }
  }

  if (process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']) {
    try {
      execFileSync('which', ['xclip'], { stdio: 'ignore' });
      cachedTool = 'xclip';
      return cachedTool;
    } catch {
      // xclip not found
    }
  }

  cachedTool = null;
  return cachedTool;
}

function mimeInfo(mimeType: string): { ext: string; osascriptClass: string } {
  const info = SUPPORTED_MIME[mimeType];
  if (!info) throw new Error(`Unsupported MIME type: ${mimeType}`);
  return info;
}

export function extensionForMime(mimeType: string): string {
  return mimeInfo(mimeType).ext;
}

function writeFileToStdin(
  command: string,
  args: string[],
  filePath: string,
  timeoutMs = 5_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const chunks: Buffer[] = [];
    let settled = false;
    function settle(error?: Error, killChild = false): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killChild) child.kill();
      if (error) reject(error);
      else resolve();
    }
    const timer = setTimeout(() => {
      settle(new Error(`${command} timed out after ${timeoutMs}ms`), true);
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => settle(error));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') settle(error, true);
    });
    child.on('close', (code) => {
      if (code === 0) {
        settle();
        return;
      }
      const stderr = Buffer.concat(chunks).toString('utf8').trim();
      settle(new Error(`${command} exited ${code}${stderr ? `: ${stderr}` : ''}`));
    });
    fs.createReadStream(filePath)
      .on('error', (error) => settle(error, true))
      .pipe(child.stdin);
  });
}

export async function setClipboardImage(
  filePath: string,
  mimeType: string
): Promise<boolean> {
  const tool = detectClipboardTool();
  const info = mimeInfo(mimeType); // throws if unsupported

  if (tool === 'osascript') {
    const script = `set the clipboard to (read (POSIX file "${filePath}") as ${info.osascriptClass})`;
    await execFileAsync('osascript', ['-e', script]);
    return true;
  }

  if (tool === 'xclip') {
    await execFileAsync('xclip', [
      '-selection',
      'clipboard',
      '-t',
      mimeType,
      '-i',
      filePath,
    ]);
    return true;
  }

  if (tool === 'wl-copy') {
    await writeFileToStdin('wl-copy', ['--type', mimeType], filePath);
    return true;
  }

  return false;
}

export function _resetForTesting(): void {
  cachedTool = undefined;
}
