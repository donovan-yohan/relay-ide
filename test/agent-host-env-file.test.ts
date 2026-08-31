import {
  chmodSync,
  existsSync,
  mkdtempSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOST_ENV_FILE_MODE,
  EnvFileError,
  extractMintedToken,
  preflightEnvFile,
  upsertEnvFile,
} from '../shared/agent-host-env-file.js';
import {
  ACTOR_TOKEN_VARIABLE,
  HUB_PORT_VARIABLE,
  buildAssignments,
  expandHome,
  parseInstallArgs,
} from '../scripts/install-profile-credential.js';

const TOKEN = `relay-sac-v1.7c2f0a1e-0000-4000-8000-000000000001.${'a1b2c3d4'.repeat(8)}`;
const OTHER_TOKEN = `relay-sac-v1.7c2f0a1e-0000-4000-8000-000000000002.${'f0e1d2c3'.repeat(8)}`;

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-env-file-'));
  roots.push(dir);
  return dir;
}

function envPath(contents?: string, mode = 0o600): string {
  const file = path.join(tempDir(), '.env');
  if (contents !== undefined) {
    writeFileSync(file, contents, { encoding: 'utf8', mode });
    chmodSync(file, mode);
  }
  return file;
}

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

function backupsIn(file: string): string[] {
  const base = path.basename(file);
  return readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${base}.bak-`))
    .sort();
}

function install(
  file: string,
  token = TOKEN,
  port?: string
): ReturnType<typeof upsertEnvFile> {
  return upsertEnvFile({
    envFile: file,
    assignments: buildAssignments(token, port),
    now: () => new Date('2026-08-31T04:05:06.789Z'),
  });
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('upsertEnvFile', () => {
  it('creates a missing env file at mode 600 with no backup', () => {
    const file = envPath();
    const result = install(file);

    expect(result.action).toBe('created');
    expect(result.backupFile).toBeUndefined();
    expect(modeOf(file)).toBe(AGENT_HOST_ENV_FILE_MODE);
    expect(readFileSync(file, 'utf8')).toBe(
      `${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
    expect(backupsIn(file)).toHaveLength(0);
  });

  it('preserves every other line, its comments, and its order', () => {
    const original = [
      '# hermes profile secrets',
      'API_SERVER_KEY=abc123',
      '',
      '# model routing',
      'OPENAI_API_KEY=sk-not-a-real-key',
      '',
    ].join('\n');
    const file = envPath(original);

    install(file);

    expect(readFileSync(file, 'utf8')).toBe(
      `${original}${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('is idempotent: a second install writes nothing and takes no backup', () => {
    const file = envPath('API_SERVER_KEY=abc123\n');
    const first = install(file);
    expect(first.action).toBe('updated');
    expect(first.backupFile).toBeDefined();
    const afterFirst = readFileSync(file, 'utf8');
    const mtime = statSync(file).mtimeMs;

    const second = install(file);

    expect(second.action).toBe('unchanged');
    expect(second.backupFile).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(backupsIn(file)).toHaveLength(1);
  });

  it('rotates the value in place rather than appending a second assignment', () => {
    const file = envPath(`A=1\n${ACTOR_TOKEN_VARIABLE}=${TOKEN}\nB=2\n`);

    const result = install(file, OTHER_TOKEN);

    expect(result.action).toBe('updated');
    expect(readFileSync(file, 'utf8')).toBe(
      `A=1\n${ACTOR_TOKEN_VARIABLE}=${OTHER_TOKEN}\nB=2\n`
    );
  });

  it('collapses duplicate assignments so first-wins and last-wins agree', () => {
    const file = envPath(
      `${ACTOR_TOKEN_VARIABLE}=stale-one\nA=1\nexport ${ACTOR_TOKEN_VARIABLE}=stale-two\n`
    );

    const result = install(file);

    expect(result.duplicatesRemoved).toBe(1);
    // The surviving line is the last one, and it keeps its `export ` prefix.
    expect(readFileSync(file, 'utf8')).toBe(
      `A=1\nexport ${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('leaves a commented-out assignment alone', () => {
    const file = envPath(`# ${ACTOR_TOKEN_VARIABLE}=documented-example\n`);

    install(file);

    expect(readFileSync(file, 'utf8')).toBe(
      `# ${ACTOR_TOKEN_VARIABLE}=documented-example\n${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('adds a newline before appending to a file that lacked one', () => {
    const file = envPath('API_SERVER_KEY=abc123');

    install(file);

    expect(readFileSync(file, 'utf8')).toBe(
      `API_SERVER_KEY=abc123\n${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('keeps CRLF files on CRLF', () => {
    const file = envPath('A=1\r\nB=2\r\n');

    install(file);

    expect(readFileSync(file, 'utf8')).toBe(
      `A=1\r\nB=2\r\n${ACTOR_TOKEN_VARIABLE}=${TOKEN}\r\n`
    );
  });

  it('preserves a tighter-than-600 mode instead of loosening it', () => {
    const file = envPath('A=1\n', 0o400);

    install(file);

    expect(modeOf(file)).toBe(0o400);
    expect(
      backupsIn(file).map((name) => modeOf(path.join(path.dirname(file), name)))
    ).toEqual([0o400]);
  });

  it('refuses a group- or other-readable file rather than tightening it', () => {
    const file = envPath('A=1\n', 0o644);

    expect(() => install(file)).toThrow(/readable by group or other/);
    expect(readFileSync(file, 'utf8')).toBe('A=1\n');
    expect(backupsIn(file)).toHaveLength(0);
  });

  it('backs up the pre-edit contents at the same mode and never clobbers a backup', () => {
    const file = envPath('A=1\n');

    const first = install(file);
    const second = install(file, OTHER_TOKEN);

    expect(first.backupFile).toBeDefined();
    expect(second.backupFile).toBeDefined();
    expect(second.backupFile).not.toBe(first.backupFile);
    expect(readFileSync(first.backupFile as string, 'utf8')).toBe('A=1\n');
    expect(readFileSync(second.backupFile as string, 'utf8')).toBe(
      `A=1\n${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
    expect(modeOf(first.backupFile as string)).toBe(AGENT_HOST_ENV_FILE_MODE);
  });

  it('writes the hub port alongside the token when asked', () => {
    const file = envPath();

    install(file, TOKEN, '3481');

    expect(readFileSync(file, 'utf8')).toBe(
      `${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n${HUB_PORT_VARIABLE}=3481\n`
    );
  });

  it('never writes inside a multi-line quoted value', () => {
    // A PEM body whose middle line looks exactly like an assignment. Rewriting
    // it would silently destroy the key.
    const original = [
      'SIGNING_KEY="-----BEGIN PRIVATE KEY-----',
      `${ACTOR_TOKEN_VARIABLE}=this-is-key-material-not-an-assignment`,
      '-----END PRIVATE KEY-----"',
      '',
    ].join('\n');
    const file = envPath(original);

    const result = install(file);

    expect(result.duplicatesRemoved).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      `${original}${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('does not match a variable whose name merely shares a prefix or suffix', () => {
    const original = [
      `MY_${ACTOR_TOKEN_VARIABLE}=untouched-one`,
      `${ACTOR_TOKEN_VARIABLE}X=untouched-two`,
      `${ACTOR_TOKEN_VARIABLE}_BACKUP=untouched-three`,
      '',
    ].join('\n');
    const file = envPath(original);

    install(file);

    expect(readFileSync(file, 'utf8')).toBe(
      `${original}${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('collapses three duplicates, including an adjacent pair, down to one', () => {
    const file = envPath(
      `${ACTOR_TOKEN_VARIABLE}=a\n${ACTOR_TOKEN_VARIABLE}=b\nA=1\n  export ${ACTOR_TOKEN_VARIABLE} = c\n`
    );

    const result = install(file);

    expect(result.duplicatesRemoved).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(
      `A=1\n  export ${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
  });

  it('writes through a symlink instead of replacing it', () => {
    const target = envPath('A=1\n');
    const link = path.join(path.dirname(target), 'linked.env');
    symlinkSync(target, link);

    const result = upsertEnvFile({
      envFile: link,
      assignments: buildAssignments(TOKEN, undefined),
    });

    expect(result.envFile).toBe(target);
    expect(statSync(link, { bigint: false }).isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(
      `A=1\n${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n`
    );
    // The link itself survives as a link.
    expect(readFileSync(link, 'utf8')).toBe(readFileSync(target, 'utf8'));
  });

  it('preflight resolves the symlink and refuses the same things the write does', () => {
    const missing = path.join(tempDir(), 'nope', '.env');
    expect(() => preflightEnvFile(missing)).toThrow(/does not exist/);

    const loose = envPath('A=1\n', 0o644);
    expect(() => preflightEnvFile(loose)).toThrow(/readable by group or other/);

    const fresh = envPath();
    expect(preflightEnvFile(fresh)).toEqual({
      envFile: fresh,
      requestedPath: fresh,
      existingMode: null,
    });
  });

  it('refuses to create a file in a directory that does not exist', () => {
    const file = path.join(tempDir(), 'missing-profile', '.env');

    expect(() => install(file)).toThrow(/does not exist/);
  });

  it('preserves an `export ` prefix and the line indent when rotating', () => {
    const file = envPath(`  export ${ACTOR_TOKEN_VARIABLE}=stale\nA=1\n`);

    install(file);

    // Dropping `export` would silently stop a `. file` consumer from exporting
    // the variable to the agent's child process.
    expect(readFileSync(file, 'utf8')).toBe(
      `  export ${ACTOR_TOKEN_VARIABLE}=${TOKEN}\nA=1\n`
    );
  });

  it('refuses a file that ends inside an unterminated quoted value', () => {
    // Appending here would land inside FOO's value for every parser that
    // supports multi-line quoted values, so the variable would never be set.
    const original = 'FOO="abc\n';
    const file = envPath(original);

    expect(() => install(file)).toThrow(/unterminated quoted value/);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(backupsIn(file)).toHaveLength(0);
  });

  it('refuses rather than silently leaving a stale assignment inside an open quote', () => {
    const original = `FOO="abc\n${ACTOR_TOKEN_VARIABLE}=stale\n`;
    const file = envPath(original);

    expect(() => install(file)).toThrow(EnvFileError);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('takes the backup beside the path the caller named, not beside the link target', () => {
    // A .env symlinked into a dotfiles checkout: a secret-bearing .bak- there
    // is one `git add -A` from being committed.
    const checkout = tempDir();
    const target = path.join(checkout, 'env');
    writeFileSync(target, 'A=1\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(target, 0o600);
    const profileDir = tempDir();
    const link = path.join(profileDir, '.env');
    symlinkSync(target, link);

    const result = upsertEnvFile({
      envFile: link,
      assignments: buildAssignments(TOKEN, undefined),
    });

    expect(result.envFile).toBe(target);
    expect(path.dirname(result.backupFile as string)).toBe(profileDir);
    expect(readdirSync(checkout)).toEqual(['env']);
  });

  it('refuses a stat failure that is not "missing" instead of taking the create branch', () => {
    // A path whose parent component is a file, not a directory: stat gives
    // ENOTDIR. Guessing "create" there would skip the backup and rename over
    // whatever is really at the end of that path.
    const dir = tempDir();
    const notADirectory = path.join(dir, 'regular-file');
    writeFileSync(notADirectory, 'x', { mode: 0o600 });
    expect(() =>
      upsertEnvFile({
        envFile: path.join(notADirectory, '.env'),
        assignments: buildAssignments(TOKEN, undefined),
      })
    ).toThrow(/ENOTDIR|does not exist/);
  });

  it('never puts the value in the result or in a refusal message', () => {
    const file = envPath();
    const result = install(file);
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    let message = '';
    try {
      upsertEnvFile({
        envFile: envPath(),
        assignments: [{ name: ACTOR_TOKEN_VARIABLE, value: 'has space' }],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/cannot be written unquoted/);
    expect(message).not.toContain('has space');
  });

  it('refuses a value that could not survive an unquoted round trip', () => {
    for (const value of ['a b', 'a\nb', 'a"b', "a'b", 'a#b', 'a$b', '']) {
      expect(() =>
        upsertEnvFile({
          envFile: envPath(),
          assignments: [{ name: ACTOR_TOKEN_VARIABLE, value }],
        })
      ).toThrow(EnvFileError);
    }
  });

  it('refuses an invalid or repeated variable name', () => {
    expect(() =>
      upsertEnvFile({
        envFile: envPath(),
        assignments: [{ name: 'lower_case', value: TOKEN }],
      })
    ).toThrow(/not a valid environment variable name/);
    expect(() =>
      upsertEnvFile({
        envFile: envPath(),
        assignments: [
          { name: ACTOR_TOKEN_VARIABLE, value: TOKEN },
          { name: ACTOR_TOKEN_VARIABLE, value: OTHER_TOKEN },
        ],
      })
    ).toThrow(/supplied twice/);
  });
});

describe('extractMintedToken', () => {
  it('reads the token out of the CLI mint envelope', () => {
    const envelope = JSON.stringify({
      ok: true,
      contract: 'v1',
      command: 'agent-profiles.credential.mint',
      data: { credential: { credentialId: 'abc' }, token: TOKEN },
    });

    expect(extractMintedToken(envelope)).toBe(TOKEN);
  });

  it('reads the token out of the bare route response', () => {
    expect(
      extractMintedToken(JSON.stringify({ credential: {}, token: TOKEN }))
    ).toBe(TOKEN);
  });

  it('accepts a bare token on its own line', () => {
    expect(extractMintedToken(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it('reports an upstream mint failure instead of writing nothing quietly', () => {
    const envelope = JSON.stringify({
      ok: false,
      command: 'agent-profiles.credential.mint',
      error: { code: 'AGENT_PROFILE_HOST_LOCAL_REQUIRED', message: 'nope' },
    });

    expect(() => extractMintedToken(envelope)).toThrow(
      /AGENT_PROFILE_HOST_LOCAL_REQUIRED/
    );
  });

  it('refuses a status envelope, which never carries a token', () => {
    const envelope = JSON.stringify({
      ok: true,
      command: 'agent-profiles.credential.status',
      data: { credential: { credentialId: 'abc', state: 'active' } },
    });

    expect(() => extractMintedToken(envelope)).toThrow(/only `mint` does/);
  });

  it('refuses empty and unrecognized input', () => {
    expect(() => extractMintedToken('   ')).toThrow(EnvFileError);
    expect(() => extractMintedToken('some-other-secret')).toThrow(
      /neither a mint envelope nor a relay-sac-v1 token/
    );
    expect(() => extractMintedToken('{not json')).toThrow(/not valid JSON/);
  });
});

describe('parseInstallArgs', () => {
  it('refuses a token on argv', () => {
    expect(() =>
      parseInstallArgs(['--profile-env', '/tmp/.env', '--token', TOKEN])
    ).toThrow(/argv is readable by every local process/);
  });

  it("refuses --env-file, which is Node's own flag", () => {
    expect(() => parseInstallArgs(['--env-file', '/tmp/.env'])).toThrow(
      /Use --profile-env/
    );
  });

  it('requires --profile-env and normalizes --port', () => {
    expect(() => parseInstallArgs([])).toThrow(/--profile-env is required/);
    expect(() =>
      parseInstallArgs(['--profile-env', '/tmp/.env', '--port', '0'])
    ).toThrow(/not a valid port/);
    expect(() =>
      parseInstallArgs(['--profile-env', '/tmp/.env', '--port', 'abc'])
    ).toThrow(/not a valid port/);
    expect(() =>
      parseInstallArgs(['--profile-env', '/tmp/.env', '--port', '99999'])
    ).toThrow(/not a valid port/);
    expect(
      parseInstallArgs(['--profile-env', '/tmp/.env', '--port', '3481'])
    ).toEqual({ profileEnv: '/tmp/.env', port: '3481', dryRun: false });
    // `+3481` parses but is not a port string any reader would accept.
    expect(
      parseInstallArgs(['--profile-env', '/tmp/.env', '--port', '+3481'])
    ).toEqual({ profileEnv: '/tmp/.env', port: '3481', dryRun: false });
  });

  it('refuses a flag-shaped value instead of silently using it as a path', () => {
    expect(() => parseInstallArgs(['--profile-env', '--dry-run'])).toThrow(
      /--profile-env needs a value/
    );
    expect(() =>
      parseInstallArgs(['--profile-env', '/tmp/.env', '--port'])
    ).toThrow(/--port needs a value/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() =>
      parseInstallArgs(['--profile-env', '/tmp/.env', '--wat'])
    ).toThrow(/unknown argument --wat/);
  });

  it('expands a leading tilde the shell would have expanded', () => {
    expect(expandHome('~/x/.env', '/home/agent')).toBe('/home/agent/x/.env');
    expect(expandHome('~', '/home/agent')).toBe('/home/agent');
    expect(expandHome('/abs/.env', '/home/agent')).toBe('/abs/.env');
    expect(expandHome('./rel/.env', '/home/agent')).toBe('./rel/.env');
  });
});

describe('install-profile-credential run through node', () => {
  // The unit tests above call `parseInstallArgs` as a function, which is
  // exactly why the `--env-file`/Node collision survived review: the flag never
  // reached Node's own parser. These spawn the real script.
  const script = fileURLToPath(
    new URL('../scripts/install-profile-credential.ts', import.meta.url)
  ).replace(/\.ts$/, '.js');
  const built = fileURLToPath(
    new URL('../dist/scripts/install-profile-credential.js', import.meta.url)
  );
  const entry = existsSync(built) ? built : script;
  const runnable = existsSync(entry);

  function run(
    args: string[],
    input = ''
  ): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [entry, ...args], {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const spawned = error as {
        status?: number | null;
        stdout?: string;
        stderr?: string;
      };
      return {
        status: spawned.status ?? -1,
        stdout: spawned.stdout ?? '',
        stderr: spawned.stderr ?? '',
      };
    }
  }

  it.runIf(runnable)(
    'creates a missing file through the real CLI entry point',
    () => {
      const file = path.join(tempDir(), '.env');

      const result = run(['--profile-env', file, '--port', '3481'], TOKEN);

      expect(result.status).toBe(0);
      const receipt = JSON.parse(result.stdout) as { action: string };
      expect(receipt.action).toBe('created');
      expect(readFileSync(file, 'utf8')).toBe(
        `${ACTOR_TOKEN_VARIABLE}=${TOKEN}\n${HUB_PORT_VARIABLE}=3481\n`
      );
      // The receipt is the whole of stdout, and it does not carry the token.
      expect(result.stdout).not.toContain(TOKEN);
      expect(result.stderr).not.toContain(TOKEN);
    }
  );

  it.runIf(runnable)('refuses --env-file with the reason', () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, 'A=1\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);

    const result = run(['--env-file', file], TOKEN);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/--profile-env/);
    expect(readFileSync(file, 'utf8')).toBe('A=1\n');
  });

  it.runIf(runnable)('dry-run consumes no token and writes nothing', () => {
    const file = path.join(tempDir(), '.env');

    const result = run(['--profile-env', file, '--dry-run']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: 'would-create',
      dryRun: true,
    });
    expect(existsSync(file)).toBe(false);
  });

  it.runIf(runnable)('prints usage without touching anything', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--profile-env');
    expect(result.stdout).not.toContain('relay-sac-v1.');
  });
});
