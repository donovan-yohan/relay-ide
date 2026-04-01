import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusLineRelayScript } from '../server/pty-handler.js';

describe('status-line relay script', () => {
  it('writes telemetry via a temp file while streaming stdin once', () => {
    const script = buildStatusLineRelayScript('session-123', '/tmp/claude-remote-config', '/usr/local/bin/status-line');

    assert.match(script, /mktemp/);
    assert.match(script, /tee "\$tmp_file"/);
    assert.match(script, /mv "\$tmp_file"/);
    assert.doesNotMatch(script, /input=\$\(cat\)/);
  });
});
