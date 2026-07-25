import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import type { Sharp } from 'sharp';

import {
  CHANNEL_IMAGE_ALT_MAX_LENGTH,
  CHANNEL_MESSAGE_MAX_IMAGE_PARTS,
  type ChannelAttachmentId,
  type ChannelImageMime,
  type ChannelImagePart,
} from '../shared/channel-chat-protocol.js';

export const CHANNEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHANNEL_IMAGE_MAX_PER_MESSAGE = CHANNEL_MESSAGE_MAX_IMAGE_PARTS;
/** Decode backstop for compressed image bombs; independent of the 5MB byte cap. */
export const CHANNEL_IMAGE_MAX_PIXELS = 40_000_000;

const SCHEMA_VERSION = 1;
const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
} as const satisfies Record<string, ChannelImageMime>;
const EXTENSION_BY_MIME: Record<ChannelImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channel_attachments (
  id           TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL UNIQUE,
  mime         TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  payload_path TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
`;

interface ChannelAttachmentRow {
  id: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  payload_path: string;
  created_at: string;
}

export interface ChannelAttachmentRecord {
  part: ChannelImagePart;
  sha256: string;
  payloadPath: string;
  createdAt: string;
}

export interface ChannelAttachmentIngestInput {
  bytes: Buffer;
  /** Advisory only. Actual MIME is derived from decoded bytes. */
  declaredMime?: string;
  alt?: string;
}

export interface ChannelAttachmentStore {
  close(): void;
  ingest(input: ChannelAttachmentIngestInput): Promise<ChannelImagePart>;
  ingestMany(
    inputs: readonly ChannelAttachmentIngestInput[]
  ): Promise<ChannelImagePart[]>;
  get(id: string): ChannelAttachmentRecord | null;
  canonicalizeParts(raw: unknown): ChannelImagePart[];
}

export class ChannelAttachmentStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ChannelAttachmentStoreError';
  }
}

function rowToRecord(row: ChannelAttachmentRow): ChannelAttachmentRecord {
  return {
    part: {
      type: 'image',
      id: row.id as ChannelAttachmentId,
      mime: row.mime as ChannelImageMime,
      w: row.width,
      h: row.height,
      bytes: row.bytes,
    },
    sha256: row.sha256,
    payloadPath: row.payload_path,
    createdAt: row.created_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputPipeline(
  format: keyof typeof MIME_BY_FORMAT,
  image: Sharp,
  options: { animated: boolean; quality: 95 | 85 | 75 }
): Sharp {
  // libvips cannot auto-orient multi-page images. Re-encoding without rotate
  // still strips metadata while preserving every animation frame.
  const sanitized = options.animated ? image : image.rotate();
  switch (format) {
    case 'png':
      return sanitized.png();
    case 'jpeg':
      return sanitized.jpeg({ quality: options.quality });
    case 'webp':
      return sanitized.webp({ quality: options.quality });
    case 'gif':
      return sanitized.gif();
  }
}

async function sanitizeImage(input: ChannelAttachmentIngestInput): Promise<{
  bytes: Buffer;
  mime: ChannelImageMime;
  width: number;
  height: number;
  alt?: string;
}> {
  if (input.bytes.length === 0) {
    throw new ChannelAttachmentStoreError(
      400,
      'channel_image_empty',
      'image payload is empty'
    );
  }
  if (input.bytes.length > CHANNEL_IMAGE_MAX_BYTES) {
    throw new ChannelAttachmentStoreError(
      413,
      'channel_image_too_large',
      'image exceeds 5MB cap',
      { bytes: input.bytes.length, maxBytes: CHANNEL_IMAGE_MAX_BYTES }
    );
  }
  const prefix = input.bytes.subarray(0, 1024).toString('utf8');
  if (/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) {
    throw new ChannelAttachmentStoreError(
      415,
      'channel_image_unsupported_type',
      'unsupported image type (allowed: png, jpeg, webp, gif)'
    );
  }

  let format: keyof typeof MIME_BY_FORMAT;
  let animated: boolean;
  // Lazy-load sharp's native binding only when actually decoding an image, so
  // importing this module (transitively reached from the CLI via local-node)
  // never eagerly loads the native addon at module-eval — that eager load raced
  // under parallel CLI spawns and intermittently threw during ESM load (#1263).
  const sharp = (await import('sharp')).default;
  try {
    const metadata = await sharp(input.bytes, {
      animated: true,
      limitInputPixels: CHANNEL_IMAGE_MAX_PIXELS,
    }).metadata();
    if (
      metadata.format !== 'png' &&
      metadata.format !== 'jpeg' &&
      metadata.format !== 'webp' &&
      metadata.format !== 'gif'
    ) {
      throw new ChannelAttachmentStoreError(
        415,
        'channel_image_unsupported_type',
        'unsupported image type (allowed: png, jpeg, webp, gif)'
      );
    }
    format = metadata.format;
    animated = (metadata.pages ?? 1) > 1;
  } catch (error) {
    if (error instanceof ChannelAttachmentStoreError) throw error;
    throw new ChannelAttachmentStoreError(
      400,
      'channel_image_invalid',
      'invalid or undecodable image payload'
    );
  }

  let sanitized: Buffer;
  let width: number;
  let height: number;
  try {
    const qualities: readonly (95 | 85 | 75)[] =
      format === 'jpeg' || format === 'webp' ? [95, 85, 75] : [95];
    let result: Awaited<ReturnType<Sharp['toBuffer']>> | undefined;
    for (const quality of qualities) {
      result = await outputPipeline(
        format,
        sharp(input.bytes, {
          animated: true,
          limitInputPixels: CHANNEL_IMAGE_MAX_PIXELS,
        }),
        { animated, quality }
      ).toBuffer({ resolveWithObject: true });
      if (result.data.length <= CHANNEL_IMAGE_MAX_BYTES) break;
    }
    if (!result) throw new Error('image sanitizer produced no output');
    sanitized = result.data;
    width = result.info.width;
    height = result.info.pageHeight ?? result.info.height;
  } catch {
    throw new ChannelAttachmentStoreError(
      400,
      'channel_image_invalid',
      'image could not be sanitized'
    );
  }

  if (sanitized.length > CHANNEL_IMAGE_MAX_BYTES) {
    throw new ChannelAttachmentStoreError(
      413,
      'channel_image_sanitized_too_large',
      'sanitized image exceeds 5MB cap',
      { bytes: sanitized.length, maxBytes: CHANNEL_IMAGE_MAX_BYTES }
    );
  }
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    throw new ChannelAttachmentStoreError(
      400,
      'channel_image_dimensions_invalid',
      'image dimensions are invalid'
    );
  }
  const alt = input.alt?.trim().slice(0, CHANNEL_IMAGE_ALT_MAX_LENGTH);

  return {
    bytes: sanitized,
    mime: MIME_BY_FORMAT[format],
    width,
    height,
    ...(alt ? { alt } : {}),
  };
}

export function initChannelAttachmentStore(
  configDir: string
): ChannelAttachmentStore {
  return createChannelAttachmentStore({
    dbPath: path.join(configDir, 'channel-attachments.db'),
    payloadRoot: path.join(configDir, 'channel-attachments', 'payloads'),
  });
}

export function createChannelAttachmentStore(input: {
  dbPath: string;
  payloadRoot: string;
}): ChannelAttachmentStore {
  fs.mkdirSync(path.dirname(input.dbPath), { recursive: true });
  fs.mkdirSync(input.payloadRoot, { recursive: true });
  const db = new Database(input.dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS channel_attachment_schema_version (version INTEGER NOT NULL)'
    );
    const current = db
      .prepare('SELECT version FROM channel_attachment_schema_version LIMIT 1')
      .get() as { version: number } | undefined;
    if ((current?.version ?? 0) > SCHEMA_VERSION) {
      throw new Error(
        `channel-attachments.db schema ${current!.version} is newer than supported ${SCHEMA_VERSION}`
      );
    }
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      if (current) {
        db.prepare(
          'UPDATE channel_attachment_schema_version SET version = ?'
        ).run(SCHEMA_VERSION);
      } else {
        db.prepare(
          'INSERT INTO channel_attachment_schema_version (version) VALUES (?)'
        ).run(SCHEMA_VERSION);
      }
    })();
  } catch (error) {
    db.close();
    throw error;
  }

  const selectById = db.prepare(
    'SELECT * FROM channel_attachments WHERE id = ?'
  );
  const insert = db.prepare(`
    INSERT INTO channel_attachments (
      id, sha256, mime, width, height, bytes, payload_path, created_at
    ) VALUES (
      @id, @sha256, @mime, @width, @height, @bytes, @payloadPath, @createdAt
    ) ON CONFLICT(id) DO NOTHING
  `);

  function get(id: string): ChannelAttachmentRecord | null {
    const row = selectById.get(id) as ChannelAttachmentRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async function statPayloadSize(payloadPath: string): Promise<number | null> {
    try {
      return (await fs.promises.stat(payloadPath)).size;
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') return null;
      throw error;
    }
  }

  async function publishPayloadAtomically(
    payloadPath: string,
    bytes: Buffer
  ): Promise<void> {
    const tempPath = path.join(
      path.dirname(payloadPath),
      `.${path.basename(payloadPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    const handle = await fs.promises.open(tempPath, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const existingSize = await statPayloadSize(payloadPath);
      if (existingSize === bytes.length) return;
      try {
        // Same-directory rename keeps readers from ever observing a partial
        // payload. Concurrent writers publish identical content-addressed
        // bytes, so a last-complete-writer win is safe.
        await fs.promises.rename(tempPath, payloadPath);
      } catch (error) {
        if (!isRecord(error) || error['code'] !== 'EEXIST') throw error;
        const racedSize = await statPayloadSize(payloadPath);
        if (racedSize === bytes.length) return;
        // Some platforms do not replace an existing path via rename. Only
        // remove a known wrong-sized payload before retrying publication.
        await fs.promises.unlink(payloadPath);
        await fs.promises.rename(tempPath, payloadPath);
      }
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async function persistPrepared(
    prepared: Awaited<ReturnType<typeof sanitizeImage>>
  ): Promise<ChannelImagePart> {
    const sha256 = createHash('sha256').update(prepared.bytes).digest('hex');
    const id = `cha:${sha256}` as ChannelAttachmentId;
    const extension = EXTENSION_BY_MIME[prepared.mime];
    const dir = path.join(
      input.payloadRoot,
      sha256.slice(0, 2),
      sha256.slice(2, 4)
    );
    await fs.promises.mkdir(dir, { recursive: true });
    const payloadPath = path.join(dir, `${sha256}${extension}`);
    await publishPayloadAtomically(payloadPath, prepared.bytes);
    insert.run({
      id,
      sha256,
      mime: prepared.mime,
      width: prepared.width,
      height: prepared.height,
      bytes: prepared.bytes.length,
      payloadPath,
      createdAt: new Date().toISOString(),
    });
    return {
      type: 'image',
      id,
      mime: prepared.mime,
      w: prepared.width,
      h: prepared.height,
      bytes: prepared.bytes.length,
      ...(prepared.alt ? { alt: prepared.alt } : {}),
    };
  }

  return {
    close() {
      db.close();
    },

    async ingest(ingestInput) {
      return persistPrepared(await sanitizeImage(ingestInput));
    },

    async ingestMany(inputs) {
      if (inputs.length === 0) {
        throw new ChannelAttachmentStoreError(
          400,
          'channel_images_required',
          'at least one image is required'
        );
      }
      if (inputs.length > CHANNEL_IMAGE_MAX_PER_MESSAGE) {
        throw new ChannelAttachmentStoreError(
          400,
          'channel_image_count_exceeded',
          `at most ${CHANNEL_IMAGE_MAX_PER_MESSAGE} images are allowed`,
          { count: inputs.length, maxCount: CHANNEL_IMAGE_MAX_PER_MESSAGE }
        );
      }
      // Decode sequentially to keep libvips memory bounded. Validate the whole
      // batch before writing any payload so an invalid later file does not make
      // a partial successful upload response.
      const prepared: Awaited<ReturnType<typeof sanitizeImage>>[] = [];
      for (const item of inputs) prepared.push(await sanitizeImage(item));
      const parts: ChannelImagePart[] = [];
      for (const item of prepared) parts.push(await persistPrepared(item));
      return parts;
    },

    get,

    canonicalizeParts(raw) {
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) {
        throw new ChannelAttachmentStoreError(
          400,
          'channel_parts_invalid',
          'parts must be an array'
        );
      }
      if (raw.length > CHANNEL_IMAGE_MAX_PER_MESSAGE) {
        throw new ChannelAttachmentStoreError(
          400,
          'channel_image_count_exceeded',
          `at most ${CHANNEL_IMAGE_MAX_PER_MESSAGE} images are allowed`,
          { count: raw.length, maxCount: CHANNEL_IMAGE_MAX_PER_MESSAGE }
        );
      }
      return raw.map((part, index) => {
        if (!isRecord(part) || part['type'] !== 'image') {
          throw new ChannelAttachmentStoreError(
            400,
            'channel_part_invalid',
            'only image parts are supported',
            { index }
          );
        }
        const id = part['id'];
        if (typeof id !== 'string') {
          throw new ChannelAttachmentStoreError(
            400,
            'channel_attachment_id_required',
            'image part id is required',
            { index }
          );
        }
        const record = get(id);
        if (!record) {
          throw new ChannelAttachmentStoreError(
            404,
            'channel_attachment_not_found',
            'channel attachment not found',
            { index, id }
          );
        }
        return {
          ...record.part,
          ...(typeof part['alt'] === 'string' && part['alt'].trim()
            ? {
                alt: part['alt'].trim().slice(0, CHANNEL_IMAGE_ALT_MAX_LENGTH),
              }
            : {}),
        };
      });
    },
  };
}
