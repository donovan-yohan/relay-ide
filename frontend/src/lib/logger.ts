/**
 * Supported log levels for the frontend logger.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Minimal logger interface used by the frontend.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Creates a namespaced logger that prefixes each message with the namespace.
 *
 * @param namespace - Namespace to prepend to every log message.
 * @returns A logger that delegates to `console.*`.
 */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;

  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console[level](`${prefix} ${message}`, ...args);
  };

  return {
    debug: (message, ...args) => log('debug', message, ...args),
    info: (message, ...args) => log('info', message, ...args),
    warn: (message, ...args) => log('warn', message, ...args),
    error: (message, ...args) => log('error', message, ...args),
  };
}
