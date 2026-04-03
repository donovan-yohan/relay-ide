import { test, expect } from 'vitest';
import * as service from '../server/service.js';

test('getPlatform returns macos or linux', () => {
  const platform = service.getPlatform();
  expect(platform === 'macos' || platform === 'linux').toBeTruthy();
});

test('getServicePaths returns expected keys', () => {
  const paths = service.getServicePaths();
  expect(paths.servicePath).toBeTruthy();
  expect(typeof paths.label).toBe('string');
  expect('logDir' in paths).toBeTruthy();
});

test('generateServiceFile for macos contains plist XML', () => {
  const content = service.generateServiceFile('macos', {
    nodePath: '/usr/local/bin/node',
    scriptPath: '/usr/local/lib/node_modules/relay-ide/bin/relay-ide.js',
    configPath: '/Users/test/.config/relay-ide/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: '/Users/test/.config/relay-ide/logs',
  });
  expect(content).toMatch(/<!DOCTYPE plist/);
  expect(content).toMatch(/com\.relay-ide/);
  expect(content).toMatch(/RunAtLoad/);
  expect(content).toMatch(/KeepAlive/);
  expect(content).toMatch(/3456/);
});

test('generateServiceFile for linux contains systemd unit', () => {
  const content = service.generateServiceFile('linux', {
    nodePath: '/usr/bin/node',
    scriptPath: '/usr/lib/node_modules/relay-ide/bin/relay-ide.js',
    configPath: '/home/test/.config/relay-ide/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: null,
  });
  expect(content).toMatch(/\[Unit\]/);
  expect(content).toMatch(/\[Service\]/);
  expect(content).toMatch(/\[Install\]/);
  expect(content).toMatch(/Restart=on-failure/);
  expect(content).toMatch(/3456/);
});
