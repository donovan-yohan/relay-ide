import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_IMAGE_MAX_BYTES,
  ChannelAttachmentStoreError,
  createChannelAttachmentStore,
  type ChannelAttachmentStore,
} from '../server/channel-attachments.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function makeStore(): ChannelAttachmentStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-images-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createChannelAttachmentStore({
    dbPath: path.join(root, 'channel-attachments.db'),
    payloadRoot: path.join(root, 'payloads'),
  });
  cleanup.push(() => store.close());
  return store;
}

async function image(
  format: 'png' | 'jpeg' | 'webp' | 'gif',
  width = 3,
  height = 2
): Promise<Buffer> {
  const input = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 },
    },
  });
  return input[format]().toBuffer();
}

describe('channel attachment store', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
  ] as const)(
    'accepts actual %s bytes and records canonical metadata',
    async (format, mime) => {
      const store = makeStore();
      const part = await store.ingest({
        bytes: await image(format),
        declaredMime: 'application/octet-stream',
        alt: `${format}-fixture`,
      });
      expect(part).toMatchObject({
        type: 'image',
        mime,
        w: 3,
        h: 2,
        alt: `${format}-fixture`,
      });
      expect(part.id).toMatch(/^cha:[a-f0-9]{64}$/);
      const record = store.get(part.id);
      expect(record).not.toBeNull();
      expect(fs.statSync(record!.payloadPath).size).toBe(part.bytes);
    }
  );

  it('rejects SVG and invalid bytes regardless of declared MIME', async () => {
    const store = makeStore();
    await expect(
      store.ingest({
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        ),
        declaredMime: 'image/png',
      })
    ).rejects.toMatchObject({
      status: 415,
      code: 'channel_image_unsupported_type',
    });
    await expect(
      store.ingest({ bytes: Buffer.from('not-an-image') })
    ).rejects.toMatchObject({
      status: 400,
      code: 'channel_image_invalid',
    });
  });

  it('enforces the byte and image-count caps before persistence', async () => {
    const store = makeStore();
    await expect(
      store.ingest({ bytes: Buffer.alloc(CHANNEL_IMAGE_MAX_BYTES + 1) })
    ).rejects.toMatchObject({
      status: 413,
      code: 'channel_image_too_large',
    });
    const png = await image('png');
    await expect(
      store.ingestMany(
        Array.from({ length: 5 }, () => ({ bytes: Buffer.from(png) }))
      )
    ).rejects.toMatchObject({
      status: 400,
      code: 'channel_image_count_exceeded',
    });
  });

  it('auto-orients, strips EXIF, and records post-sanitize dimensions', async () => {
    const store = makeStore();
    const withExif = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const part = await store.ingest({ bytes: withExif });
    expect(part).toMatchObject({ mime: 'image/jpeg', w: 2, h: 3 });
    const stored = store.get(part.id)!;
    const metadata = await sharp(stored.payloadPath).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('deduplicates sanitized payloads by content hash', async () => {
    const store = makeStore();
    const bytes = await image('png');
    const first = await store.ingest({ bytes });
    const second = await store.ingest({ bytes: Buffer.from(bytes) });
    expect(second.id).toBe(first.id);
    expect(store.get(first.id)?.payloadPath).toBe(
      store.get(second.id)?.payloadPath
    );
  });

  it('canonicalizes posted refs and rejects missing payload ids', async () => {
    const store = makeStore();
    const uploaded = await store.ingest({ bytes: await image('png') });
    expect(
      store.canonicalizeParts([
        {
          type: 'image',
          id: uploaded.id,
          mime: 'image/gif',
          w: 999,
          h: 999,
          bytes: 1,
          alt: '  useful alt  ',
        },
      ])
    ).toEqual([{ ...uploaded, alt: 'useful alt' }]);

    expect(() =>
      store.canonicalizeParts([{ type: 'image', id: `cha:${'0'.repeat(64)}` }])
    ).toThrow(ChannelAttachmentStoreError);
    try {
      store.canonicalizeParts([{ type: 'image', id: `cha:${'0'.repeat(64)}` }]);
    } catch (error) {
      expect(error).toMatchObject({
        status: 404,
        code: 'channel_attachment_not_found',
      });
    }
  });
});
