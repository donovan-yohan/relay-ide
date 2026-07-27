import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { extensionForMime, setClipboardImage } from './clipboard.js';
import type { Session } from './types.js';
import type { ControlActor } from '../shared/control-state.js';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// Base64 is ~33% larger than binary; 10 MB binary ≈ 13.3 MB base64.
export const MAX_SESSION_IMAGE_BASE64_BYTES = 14 * 1024 * 1024;
export const SESSION_IMAGE_TTL_MS = 60 * 60 * 1000;

export interface SessionImagePayload {
  data: string;
  mimeType: string;
}

export interface SessionImageIngressResult {
  path: string;
  clipboardSet: boolean;
  inserted: boolean;
  mode: 'clipboard' | 'path' | 'attachment';
}

export class SessionImageIngressError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SessionImageIngressError';
    this.status = status;
  }
}

export interface SessionImageBoundary {
  get(id: string): Session | undefined;
  write(id: string, data: string): void;
  supervisorWrite?(
    id: string,
    input: { action: 'sendText'; actor: ControlActor; payload: string }
  ): unknown;
}

function imageTempDir(sessionId: string): string {
  const safeSessionDir = Buffer.from(sessionId, 'utf8').toString('base64url');
  return path.join(os.tmpdir(), 'relay-ide', safeSessionDir);
}

export function cleanupSessionImageTempDir(sessionId: string): void {
  fs.rmSync(imageTempDir(sessionId), { recursive: true, force: true });
}

function scheduleSessionImageCleanup(filePath: string): void {
  const timer = setTimeout(() => {
    fs.rm(filePath, { force: true }, () => undefined);
  }, SESSION_IMAGE_TTL_MS);
  timer.unref?.();
}

function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export function parseSessionImagePayload(raw: unknown): SessionImagePayload {
  const body =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const data = body['data'];
  const mimeType = body['mimeType'];
  if (typeof data !== 'string' || typeof mimeType !== 'string') {
    throw new SessionImageIngressError(400, 'data and mimeType are required');
  }
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new SessionImageIngressError(
      400,
      `Unsupported image type: ${mimeType}`
    );
  }
  if (data.length > MAX_SESSION_IMAGE_BASE64_BYTES) {
    throw new SessionImageIngressError(413, 'Image too large (max 10MB)');
  }
  return { data, mimeType };
}

export async function ingressSessionImage(input: {
  sessions: SessionImageBoundary;
  sessionId: string;
  payload: SessionImagePayload;
  actor?: ControlActor;
  now?: () => number;
}): Promise<SessionImageIngressResult> {
  const session = input.sessions.get(input.sessionId);
  if (!session) throw new SessionImageIngressError(404, 'Session not found');

  const ext = extensionForMime(input.payload.mimeType);
  const dir = imageTempDir(input.sessionId);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = input.now?.() ?? Date.now();
  const filePath = path.join(dir, `paste-${stamp}${ext}`);
  await fs.promises.writeFile(
    filePath,
    Buffer.from(input.payload.data, 'base64')
  );
  scheduleSessionImageCleanup(filePath);

  let clipboardSet = false;
  try {
    clipboardSet = await setClipboardImage(filePath, input.payload.mimeType);
  } catch {
    // Clipboard tools failed — fall back to bracketed path paste.
  }

  const payload = clipboardSet ? '\x16' : bracketedPaste(filePath);
  if (input.sessions.supervisorWrite) {
    input.sessions.supervisorWrite(input.sessionId, {
      action: 'sendText',
      actor:
        input.actor ??
        ({
          kind: 'human',
          id: 'browser-image-paste',
          displayName: 'Browser image paste',
        } satisfies ControlActor),
      payload,
    });
  } else {
    input.sessions.write(input.sessionId, payload);
  }

  return {
    path: filePath,
    clipboardSet,
    inserted: true,
    mode: clipboardSet ? 'clipboard' : 'path',
  };
}
