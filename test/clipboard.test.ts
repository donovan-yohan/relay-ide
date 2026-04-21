import { describe, it, expect } from 'vitest';
import { detectClipboardTool, setClipboardImage } from '../server/clipboard.js';

describe('clipboard', () => {
  it('detectClipboardTool returns a string or null', () => {
    const result = detectClipboardTool();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('setClipboardImage rejects unsupported mime types', async () => {
    await expect(() =>
      setClipboardImage('/tmp/test.txt', 'text/plain')
    ).rejects.toThrow(/Unsupported/);
  });
});
