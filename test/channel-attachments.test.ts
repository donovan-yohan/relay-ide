import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_IMAGE_MAX_BYTES,
  CHANNEL_IMAGE_MAX_PIXELS,
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

function deterministicNoise(width: number, height: number): Buffer {
  const bytes = Buffer.allocUnsafe(width * height * 3);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

async function animatedImage(format: 'gif' | 'webp'): Promise<Buffer> {
  const width = 3;
  const pageHeight = 2;
  const pages = 2;
  const pixels = Buffer.alloc(width * pageHeight * pages * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const secondPage = index >= width * pageHeight * 4;
    pixels[index + (secondPage ? 2 : 0)] = 255;
    pixels[index + 3] = 255;
  }
  const animation = sharp(pixels, {
    raw: {
      width,
      height: pageHeight * pages,
      channels: 4,
      pageHeight,
    },
  });
  return animation[format]({ loop: 0, delay: [80, 120] }).toBuffer();
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

  it('rejects a compressed image whose decoded pixels exceed the cap', async () => {
    const store = makeStore();
    const width = 8_000;
    const height = Math.floor(CHANNEL_IMAGE_MAX_PIXELS / width) + 1;
    const compressed = await image('png', width, height);
    expect(compressed.length).toBeLessThan(CHANNEL_IMAGE_MAX_BYTES);
    expect(width * height).toBeGreaterThan(CHANNEL_IMAGE_MAX_PIXELS);

    await expect(store.ingest({ bytes: compressed })).rejects.toMatchObject({
      status: 400,
      code: 'channel_image_invalid',
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

  it('atomically heals a partial content-addressed payload', async () => {
    const store = makeStore();
    const source = await image('png', 12, 8);
    const first = await store.ingest({ bytes: source });
    const payloadPath = store.get(first.id)!.payloadPath;
    const completePayload = fs.readFileSync(payloadPath);
    fs.writeFileSync(payloadPath, completePayload.subarray(0, 7));

    const retried = await store.ingest({ bytes: source });

    expect(retried.id).toBe(first.id);
    expect(fs.readFileSync(payloadPath)).toEqual(completePayload);
    expect(
      fs
        .readdirSync(path.dirname(payloadPath))
        .filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('reduces JPEG quality when a compliant input grows past the cap', async () => {
    const store = makeStore();
    const width = 2_700;
    const height = 2_200;
    const source = await sharp(deterministicNoise(width, height), {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const quality95 = await sharp(source).jpeg({ quality: 95 }).toBuffer();
    expect(source.length).toBeLessThan(CHANNEL_IMAGE_MAX_BYTES);
    expect(quality95.length).toBeGreaterThan(CHANNEL_IMAGE_MAX_BYTES);

    const part = await store.ingest({ bytes: source });

    expect(part).toMatchObject({ mime: 'image/jpeg', w: width, h: height });
    expect(part.bytes).toBeLessThanOrEqual(CHANNEL_IMAGE_MAX_BYTES);
  });

  it.each(['gif', 'webp'] as const)(
    'preserves all frames when sanitizing animated %s images',
    async (format) => {
      const store = makeStore();
      const part = await store.ingest({ bytes: await animatedImage(format) });
      const metadata = await sharp(store.get(part.id)!.payloadPath, {
        animated: true,
      }).metadata();

      expect(part).toMatchObject({ w: 3, h: 2 });
      expect(metadata.pages).toBe(2);
      expect(metadata.pageHeight).toBe(2);
    }
  );

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
