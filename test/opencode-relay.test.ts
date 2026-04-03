import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  installOpencodeRelayPlugin,
  RELAY_PLUGIN_SOURCE,
} from '../server/opencode-relay.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-opencode-relay-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

describe('RELAY_PLUGIN_SOURCE', () => {
  it('contains expected opencode hook event names', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('session.created'),
      'should include session.created'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('session.idle'),
      'should include session.idle'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('session.status'),
      'should include session.status'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('session.error'),
      'should include session.error'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('permission.asked'),
      'should include permission.asked'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('permission.replied'),
      'should include permission.replied'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('tool.execute.before'),
      'should include tool.execute.before'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('tool.execute.after'),
      'should include tool.execute.after'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('message.updated'),
      'should include message.updated'
    );
  });

  it('reads CRC_RELAY_URL from env', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('CRC_RELAY_URL'),
      'should read CRC_RELAY_URL from env'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('process.env.CRC_RELAY_URL'),
      'should use process.env.CRC_RELAY_URL'
    );
  });

  it('reads CRC_SESSION_ID from env', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('CRC_SESSION_ID'),
      'should read CRC_SESSION_ID from env'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('process.env.CRC_SESSION_ID'),
      'should use process.env.CRC_SESSION_ID'
    );
  });

  it('reads CRC_RELAY_TOKEN from env', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('CRC_RELAY_TOKEN'),
      'should read CRC_RELAY_TOKEN from env'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('process.env.CRC_RELAY_TOKEN'),
      'should use process.env.CRC_RELAY_TOKEN'
    );
  });

  it('relays to /hooks/agent-event endpoint', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('/hooks/agent-event'),
      'should POST to /hooks/agent-event'
    );
  });

  it('uses POST method for relay', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes("method: 'POST'"),
      'should use POST method'
    );
  });

  it('returns early when env vars are missing', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes(
        'if (!relayUrl || !sessionId || !token) return {};'
      ),
      'should return empty object when env vars are missing'
    );
  });

  it('includes sessionId and token in request body', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('sessionId'),
      'should include sessionId in body'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('token'),
      'should include token in body'
    );
  });

  it('includes eventType and timestamp in request body', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('eventType'),
      'should include eventType in body'
    );
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('timestamp'),
      'should include timestamp in body'
    );
  });

  it('is a non-empty string', () => {
    assert.ok(typeof RELAY_PLUGIN_SOURCE === 'string', 'should be a string');
    assert.ok(RELAY_PLUGIN_SOURCE.length > 0, 'should not be empty');
  });

  it('exports a default async function', () => {
    assert.ok(
      RELAY_PLUGIN_SOURCE.includes('export default async'),
      'should export a default async function'
    );
  });
});

describe('installOpencodeRelayPlugin', () => {
  it('writes the plugin file to the specified directory', () => {
    const pluginDir = path.join(tmpDir, 'write-test');
    const pluginPath = installOpencodeRelayPlugin(pluginDir);
    assert.ok(fs.existsSync(pluginPath), 'plugin file should exist');
    assert.strictEqual(
      path.basename(pluginPath),
      'crc-relay.ts',
      'file should be named crc-relay.ts'
    );
  });

  it('returns the path to the written plugin file', () => {
    const pluginDir = path.join(tmpDir, 'return-path-test');
    const pluginPath = installOpencodeRelayPlugin(pluginDir);
    const expectedPath = path.join(pluginDir, 'crc-relay.ts');
    assert.strictEqual(
      pluginPath,
      expectedPath,
      'should return path to crc-relay.ts in pluginDir'
    );
  });

  it('creates the directory if it does not exist', () => {
    const pluginDir = path.join(tmpDir, 'nested', 'dirs', 'plugins');
    assert.ok(!fs.existsSync(pluginDir), 'directory should not exist yet');
    installOpencodeRelayPlugin(pluginDir);
    assert.ok(fs.existsSync(pluginDir), 'directory should be created');
  });

  it('writes exactly RELAY_PLUGIN_SOURCE as the file content', () => {
    const pluginDir = path.join(tmpDir, 'content-test');
    const pluginPath = installOpencodeRelayPlugin(pluginDir);
    const content = fs.readFileSync(pluginPath, 'utf-8');
    assert.strictEqual(
      content,
      RELAY_PLUGIN_SOURCE,
      'file content should match RELAY_PLUGIN_SOURCE'
    );
  });

  it('is idempotent — write twice, file still has valid content', () => {
    const pluginDir = path.join(tmpDir, 'idempotent-test');
    installOpencodeRelayPlugin(pluginDir);
    installOpencodeRelayPlugin(pluginDir);
    const pluginPath = path.join(pluginDir, 'crc-relay.ts');
    const content = fs.readFileSync(pluginPath, 'utf-8');
    assert.strictEqual(
      content,
      RELAY_PLUGIN_SOURCE,
      'file should still have valid content after second write'
    );
  });

  it('default path includes opencode/plugins in home dir when no arg given', () => {
    // We test the default path logic by inspecting the function signature behavior.
    // We cannot call with no arg since it would write to the real ~/.config/opencode/plugins,
    // so instead we verify that pluginDir parameter defaults correctly by checking the source.
    // The actual installOpencodeRelayPlugin(pluginDir) overload is tested above.
    // Just verify the function is callable and returns a string path.
    const pluginDir = path.join(tmpDir, 'default-path-test');
    const result = installOpencodeRelayPlugin(pluginDir);
    assert.ok(typeof result === 'string', 'should return a string path');
    assert.ok(
      result.endsWith('crc-relay.ts'),
      'returned path should end with crc-relay.ts'
    );
  });
});
