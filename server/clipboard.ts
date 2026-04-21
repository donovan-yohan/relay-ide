import { execFile, execFileSync } from 'node:child_process';
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

  return false;
}

export function _resetForTesting(): void {
  cachedTool = undefined;
}
