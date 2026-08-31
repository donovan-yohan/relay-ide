#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * #1455 slice 4: plant a minted Relay actor credential into an agent host's
 * per-profile environment file.
 *
 *   relay-ide v1 agent-profiles credential mint --id agent-profile:hermes:tako \
 *     | node dist/scripts/install-profile-credential.js \
 *         --profile-env ~/.hermes/profiles/tako-planner/.env
 *
 * The flag is `--profile-env`, NOT `--env-file`: Node itself owns `--env-file`
 * and consumes it even when it appears after the script path, so
 * `--env-file <missing path>` aborts the runtime with `not found` before this
 * file executes — exactly the first-run case — and an existing path is silently
 * hydrated into this process's environment. `--env-file` is refused with that
 * explanation whenever argv still carries it.
 *
 * The pipe is the point. The token is read from stdin and written to the file;
 * it is never an argument (argv is world-readable in /proc), never echoed, and
 * never part of this script's output or of any error it raises. What the
 * operator sees is a JSON receipt naming the file, the action, and the backup.
 *
 * This is deliberately a script and not a `relay-ide` subcommand: it runs where
 * the agent's PROFILE lives, which is not necessarily where the hub runs.
 *
 * Note that the CLI's gateway lane dials `127.0.0.1:<port>` and nothing else
 * (`bin/relay-ide.ts` — "v1 commands only ever dial loopback"), so a profile on
 * a genuinely different machine needs an SSH tunnel to the hub's port before
 * the planted credential can reach it. This script plants the token; it does
 * not create that path.
 *
 * Nothing here knows what Hermes is. `--env-file` is a path; the Hermes-side
 * recipe (which profile, which toolset, how the file is hydrated) lives in
 * `docs/references/hermes-multiplex-setup.md`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EnvFileError,
  extractMintedToken,
  preflightEnvFile,
  upsertEnvFile,
  type EnvFileAssignment,
} from '../shared/agent-host-env-file.js';

/** The variable name `bin/relay-ide.ts` resolves the actor lane from. */
export const ACTOR_TOKEN_VARIABLE = 'RELAY_IDE_ACTOR_TOKEN';
/** The hub port the CLI's gateway lane dials on loopback. */
export const HUB_PORT_VARIABLE = 'RELAY_IDE_PORT';

const USAGE = `install-profile-credential — plant a Relay actor credential in an agent profile's .env

Usage:
  relay-ide v1 agent-profiles credential mint --id <profileId> \\
    | node dist/scripts/install-profile-credential.js --profile-env <path> [--port <port>]

Options:
  --profile-env <path>  Environment file to upsert. Its directory must exist.
                        (Not --env-file: Node owns that flag and eats it.)
  --port <port>         Also write ${HUB_PORT_VARIABLE}, the hub port the agent's
                        relay-ide dials on loopback. Omit for the default port.
  --token-file <path>   Read the token from a file instead of stdin.
  --dry-run             Check the target file without writing. Reads no token,
                        so it never consumes a freshly minted one.
  --help                This text.

The token is read from stdin (the mint envelope, or the bare token) or from
--token-file. There is no --token flag: a secret in argv is readable by every
local process.`;

export interface ParsedInstallArgs {
  profileEnv: string;
  port?: string;
  tokenFile?: string;
  dryRun: boolean;
}

/** Expand a leading `~/` the shell would have expanded if it were unquoted. */
export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export function parseInstallArgs(argv: readonly string[]): ParsedInstallArgs {
  let profileEnv = '';
  let port: string | undefined;
  let tokenFile: string | undefined;
  let dryRun = false;
  // A flag's value must not itself look like a flag. `--profile-env --dry-run`
  // silently setting the path to "--dry-run" is the failure mode
  // `parseChannelCliFlags` in bin/relay-ide.ts already refuses; the same rule
  // applies where the value names a file we are about to rewrite.
  const valueFor = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith('--')) {
      throw new EnvFileError(`${flag} needs a value`, 'USAGE');
    }
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--profile-env':
        profileEnv = valueFor('--profile-env', next);
        index += 1;
        break;
      case '--port':
        port = valueFor('--port', next);
        index += 1;
        break;
      case '--token-file':
        tokenFile = valueFor('--token-file', next);
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--env-file':
        // Only reachable when the path exists — Node aborts the runtime first
        // when it does not. Refusing with the reason beats accepting a flag
        // whose side effect is loading somebody's secrets into our own
        // environment.
        throw new EnvFileError(
          "--env-file is Node's own flag and is consumed before this script runs (and hydrates that file into this process). Use --profile-env.",
          'RESERVED_FLAG'
        );
      case '--token':
        // Refused, not accepted-with-a-warning. `bin/relay-ide.ts` already
        // refuses secrets in argv for agent-profile writes; the same rule has
        // to hold on the host where the secret comes to rest.
        throw new EnvFileError(
          '--token is refused: argv is readable by every local process. Pipe the mint output to stdin, or use --token-file.',
          'ARGV_SECRET'
        );
      default:
        throw new EnvFileError(`unknown argument ${String(arg)}`, 'USAGE');
    }
  }
  if (!profileEnv) throw new EnvFileError('--profile-env is required', 'USAGE');
  let normalizedPort: string | undefined;
  if (port !== undefined) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new EnvFileError(`--port ${port} is not a valid port`, 'USAGE');
    }
    // Write the NORMALIZED value: `+3481` and `3481.0` both parse here but
    // neither is a port number any reader would accept out of the file.
    normalizedPort = String(parsed);
  }
  return {
    profileEnv,
    ...(normalizedPort ? { port: normalizedPort } : {}),
    ...(tokenFile ? { tokenFile } : {}),
    dryRun,
  };
}

export function buildAssignments(
  token: string,
  port: string | undefined
): EnvFileAssignment[] {
  const assignments: EnvFileAssignment[] = [
    { name: ACTOR_TOKEN_VARIABLE, value: token },
  ];
  if (port) assignments.push({ name: HUB_PORT_VARIABLE, value: port });
  return assignments;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseInstallArgs(argv);
  const home = os.homedir();
  const envFile = expandHome(args.profileEnv, home);

  if (args.dryRun) {
    // Deliberately reads NO token. A dry run that drained stdin would consume
    // the one-time output of a `credential mint` that has already revoked its
    // predecessor — a preflight that destroys the thing it is checking. This
    // resolves the symlink and throws on a missing directory or a
    // group/other-readable file, exactly as the write would.
    const preflight = preflightEnvFile(envFile);
    console.log(
      JSON.stringify(
        {
          envFile: preflight.envFile,
          variables: [
            ACTOR_TOKEN_VARIABLE,
            ...(args.port ? [HUB_PORT_VARIABLE] : []),
          ],
          action:
            preflight.existingMode === null ? 'would-create' : 'would-update',
          dryRun: true,
        },
        null,
        2
      )
    );
    return;
  }

  const raw = args.tokenFile
    ? fs.readFileSync(expandHome(args.tokenFile, home), 'utf8')
    : await readStdin();
  const token = extractMintedToken(raw);
  const assignments = buildAssignments(token, args.port);

  const result = upsertEnvFile({ envFile, assignments });
  // The receipt names the file and the action. It cannot name the token: the
  // result type has no field for one.
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message =
      error instanceof EnvFileError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
