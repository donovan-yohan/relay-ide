import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

interface NodeCredentialFileSystem {
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  writeFileSync(
    filePath: string,
    data: string,
    options: { mode: number; flag: 'wx' }
  ): unknown;
  chmodSync(filePath: string, mode: number): unknown;
  renameSync(oldPath: string, newPath: string): unknown;
  rmSync(filePath: string, options: { force: true }): unknown;
}

export interface WriteNodeCredentialFileOptions {
  fs?: Partial<NodeCredentialFileSystem>;
  tempSuffix?: () => string;
}

export function writeNodeCredentialFile(
  credentialPath: string,
  credential: unknown,
  options: WriteNodeCredentialFileOptions = {}
): void {
  const dir = path.dirname(credentialPath);
  const tempSuffix =
    options.tempSuffix?.() ?? `${process.pid}-${Date.now()}-${randomUUID()}`;
  const tempPath = path.join(
    dir,
    `.${path.basename(credentialPath)}.${tempSuffix}.tmp`
  );
  const fileSystem = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    chmodSync: fs.chmodSync,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    ...options.fs,
  };

  fileSystem.mkdirSync(dir, { recursive: true });

  try {
    fileSystem.writeFileSync(
      tempPath,
      `${JSON.stringify(credential, null, 2)}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      }
    );
    fileSystem.chmodSync(tempPath, 0o600);
    fileSystem.renameSync(tempPath, credentialPath);
  } catch (error) {
    fileSystem.rmSync(tempPath, { force: true });
    throw error;
  }
}
