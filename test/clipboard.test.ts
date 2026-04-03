import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectClipboardTool, setClipboardImage } from '../server/clipboard.js';

describe('clipboard', () => {
  it('detectClipboardTool returns a string or null', () => {
    const result = detectClipboardTool();
    assert.ok(result === null || typeof result === 'string');
  });

  it('setClipboardImage rejects unsupported mime types', async () => {
    await assert.rejects(
      () => setClipboardImage('/tmp/test.txt', 'text/plain'),
      /Unsupported/
    );
  });
});
