/**
 * Moved to `shared/node-credential-file.ts` (#1467) so the hub can reuse the
 * same atomic 0600 secret writer for the local CLI trust token. This file stays
 * as the CLI-side import path.
 */
export {
  writeNodeCredentialFile,
  type WriteNodeCredentialFileOptions,
} from '../shared/node-credential-file.js';
