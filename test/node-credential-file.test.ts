import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNodeCredentialFile } from '../bin/node-credential-file.js';

const cleanupDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-credential-'));
  cleanupDirs.push(dir);
  return dir;
}

function readCredential(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('node credential file writes', () => {
  it('writes credentials through a same-directory 0600 temp file and atomic rename', () => {
    const dir = makeTempDir();
    const credentialPath = path.join(dir, 'node-credential.json');

    writeNodeCredentialFile(
      credentialPath,
      { nodeId: 'node-a', token: 'next-token', credentialId: 'cred-next' },
      { tempSuffix: () => 'first' }
    );

    expect(JSON.parse(readCredential(credentialPath))).toEqual({
      nodeId: 'node-a',
      token: 'next-token',
      credentialId: 'cred-next',
    });
    expect(fs.existsSync(path.join(dir, '.node-credential.json.first.tmp'))).toBe(
      false
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves the old credential when the temp write fails', () => {
    const dir = makeTempDir();
    const credentialPath = path.join(dir, 'node-credential.json');
    const oldCredential = '{"nodeId":"node-a","token":"old-token"}\n';
    fs.writeFileSync(credentialPath, oldCredential, { mode: 0o600 });

    expect(() =>
      writeNodeCredentialFile(
        credentialPath,
        { nodeId: 'node-a', token: 'next-token' },
        {
          tempSuffix: () => 'write-fail',
          fs: {
            writeFileSync: () => {
              throw new Error('disk full');
            },
          },
        }
      )
    ).toThrow('disk full');

    expect(readCredential(credentialPath)).toBe(oldCredential);
    expect(
      fs.existsSync(path.join(dir, '.node-credential.json.write-fail.tmp'))
    ).toBe(false);
  });

  it('preserves the old credential and removes the temp file when rename fails before replacement', () => {
    const dir = makeTempDir();
    const credentialPath = path.join(dir, 'node-credential.json');
    const tempPath = path.join(dir, '.node-credential.json.rename-fail.tmp');
    const oldCredential = '{"nodeId":"node-a","token":"old-token"}\n';
    fs.writeFileSync(credentialPath, oldCredential, { mode: 0o600 });

    expect(() =>
      writeNodeCredentialFile(
        credentialPath,
        { nodeId: 'node-a', token: 'next-token' },
        {
          tempSuffix: () => 'rename-fail',
          fs: {
            renameSync: () => {
              throw new Error('rename denied');
            },
          },
        }
      )
    ).toThrow('rename denied');

    expect(readCredential(credentialPath)).toBe(oldCredential);
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
