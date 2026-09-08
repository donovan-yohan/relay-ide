import path from 'node:path';

import Database from 'better-sqlite3';

import { assertConfigDirNotOwnedByAnotherLiveHub } from './hub-lock.js';

/**
 * Open a SQLite database that lives in the hub config directory.
 *
 * #1587: any process opening a config-dir database must refuse if another live
 * hub owns the directory (hub.lock + pid liveness check).
 */
export function openConfigDirDatabase(
  configDir: string,
  fileName: string
): Database.Database {
  assertConfigDirNotOwnedByAnotherLiveHub(configDir);
  return new Database(path.join(configDir, fileName));
}

/**
 * Guard that refuses opening a database under a configDir owned by another hub.
 *
 * Call from `create*(dbPath)` factories that accept an explicit path, so unit
 * tests stay able to open DBs anywhere while still refusing accidental opens of
 * the live config dir when `hub.lock` says it is owned.
 */
export function assertConfigDirSafeForDbPath(dbPath: string): void {
  assertConfigDirNotOwnedByAnotherLiveHub(path.dirname(dbPath));
}
