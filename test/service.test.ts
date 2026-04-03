import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../server/service.js';

test('getPlatform returns macos or linux', () => {
  const platform = service.getPlatform();
  assert.ok(
    platform === 'macos' || platform === 'linux',
    'Expected macos or linux, got ' + platform
  );
});

test('getServicePaths returns expected keys', () => {
  const paths = service.getServicePaths();
  assert.ok(paths.servicePath, 'missing servicePath');
  assert.equal(typeof paths.label, 'string', 'label should be a string');
  assert.ok('logDir' in paths, 'missing logDir key');
});

test('generateServiceFile for macos contains plist XML', () => {
  const content = service.generateServiceFile('macos', {
    nodePath: '/usr/local/bin/node',
    scriptPath:
      '/usr/local/lib/node_modules/claude-remote-cli/bin/claude-remote-cli.js',
    configPath: '/Users/test/.config/claude-remote-cli/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: '/Users/test/.config/claude-remote-cli/logs',
  });
  assert.match(content, /<!DOCTYPE plist/, 'should be plist XML');
  assert.match(content, /com\.claude-remote-cli/, 'should have label');
  assert.match(content, /RunAtLoad/, 'should have RunAtLoad');
  assert.match(content, /KeepAlive/, 'should have KeepAlive');
  assert.match(content, /3456/, 'should include port');
});

test('generateServiceFile for linux contains systemd unit', () => {
  const content = service.generateServiceFile('linux', {
    nodePath: '/usr/bin/node',
    scriptPath:
      '/usr/lib/node_modules/claude-remote-cli/bin/claude-remote-cli.js',
    configPath: '/home/test/.config/claude-remote-cli/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: null,
  });
  assert.match(content, /\[Unit\]/, 'should have Unit section');
  assert.match(content, /\[Service\]/, 'should have Service section');
  assert.match(content, /\[Install\]/, 'should have Install section');
  assert.match(content, /Restart=on-failure/, 'should restart on failure');
  assert.match(content, /3456/, 'should include port');
});
