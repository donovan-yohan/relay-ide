export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Create a namespaced logger that prefixes all messages.
 *
 * @param namespace - Namespace used in the log prefix.
 * @returns A logger that delegates to `console.*`.
 */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;

  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    console[level](`${prefix} ${message}`, ...args);
  };

  return {
    debug: (message: string, ...args: unknown[]) => log('debug', message, ...args),
    info: (message: string, ...args: unknown[]) => log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  };
}
