import { describe, expect, it } from 'vitest';

import {
  DEV_BACKEND_PORT,
  DEV_FRONTEND_PORT,
  buildBackendProxyTarget,
  backendProxyPaths,
  createDevProxyConfig,
} from '../frontend/dev-server.js';

describe('Vite dev proxy config', () => {
  it('uses non-production default dev ports', () => {
    expect(DEV_BACKEND_PORT).toBe(3457);
    expect(DEV_FRONTEND_PORT).toBe(5173);
  });

  it('builds the backend target from env overrides', () => {
    expect(buildBackendProxyTarget({ RELAY_IDE_DEV_BACKEND_PORT: '4567' })).toBe(
      'http://127.0.0.1:4567'
    );
    expect(
      buildBackendProxyTarget({ RELAY_IDE_DEV_BACKEND_URL: 'http://localhost:9999' })
    ).toBe('http://localhost:9999');
  });

  it('proxies backend REST endpoints and both WebSocket channels', () => {
    const proxy = createDevProxyConfig('http://127.0.0.1:4567');

    for (const path of backendProxyPaths) {
      expect(proxy[path]?.target).toBe('http://127.0.0.1:4567');
    }

    expect(proxy['/ws']?.ws).toBe(true);
    expect(backendProxyPaths).toContain('/auth');
    expect(backendProxyPaths).toContain('/sessions');
    expect(backendProxyPaths).toContain('/branches');
    expect(backendProxyPaths).toContain('/workspaces');
    expect(backendProxyPaths).toContain('/presets');
    expect(backendProxyPaths).toContain('/api');
    expect(backendProxyPaths).toContain('/ws');
  });
});
