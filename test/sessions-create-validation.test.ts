import { describe, expect, it } from 'vitest';
import { validateSessionCreateRequest } from '../server/index.js';
import type { Config } from '../server/types.js';
import type { WorkContextStore } from '../server/work-context.js';

// Minimal config stub with the two repos we'll test with
function makeConfig(repos: string[]): Config {
  return {
    host: '0.0.0.0',
    port: 3000,
    cookieTTL: '30d',
    repos,
    claudeArgs: [],
    defaultFramework: 'claude',
    defaultContinue: false,
    defaultYolo: false,
    maxPtySessions: 10,
    launchInTmux: true,
    defaultNotifications: false,
    claudeFullscreen: false,
  };
}

// Minimal WorkContextStore stub
function makeStore(): WorkContextStore {
  const contexts = new Map<string, unknown>();
  return {
    get(id: string) {
      return contexts.get(id);
    },
    associateSession() {},
    findSessionWorkContextIds() { return []; },
    // @ts-expect-error partial stub
  } as WorkContextStore;
}

// Captures res.status(N).json(body) calls
function makeRes() {
  let capturedStatus = 200;
  let capturedBody: unknown = undefined;
  return {
    get status() { return capturedStatus; },
    get body() { return capturedBody; },
    resObj: {
      status(code: number) {
        capturedStatus = code;
        return {
          json(body: unknown) {
            capturedBody = body;
            return this;
          },
        };
      },
    },
  };
}

describe('validateSessionCreateRequest', () => {
  const configuredPath = '/configured/repo';
  const nonGitPath = '/configured/non-git';
  const unconfiguredPath = '/not/configured';

  const config = makeConfig([configuredPath, nonGitPath]);
  const store = makeStore();

  it('returns true for agent session with configured repoPath', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      undefined,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200); // no error response sent
  });

  it('returns false with 400 for agent session with no repoPath', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      undefined,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('repoPath') });
  });

  it('returns false with 400 for agent session with unconfigured repoPath', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      unconfiguredPath,
      undefined,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
  });

  it('returns true for terminal session with configured cwd (no repoPath)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      nonGitPath,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns true for terminal session with configured repoPath (legacy)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      configuredPath,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns false with 400 for terminal session with unconfigured cwd', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      unconfiguredPath,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('configured') });
  });

  it('defaults to agent type when type is undefined (requires repoPath)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      nonGitPath,
      undefined,
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
  });

  it('returns false with 404 when workContextId is set but not found', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      undefined,
      'agent',
      config,
      store,
      'missing-context-id',
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'work_context_not_found' });
  });
});
