import type http from 'node:http';

interface SessionRestoreResultHandlers {
  restored(count: number): void;
  failed(error: unknown): void;
}

/**
 * Start serialized-session restore only after the HTTP server is listening.
 * The restore promise is intentionally detached so provider work cannot hold
 * the listener callback or any request path open.
 */
export function restoreSessionsAfterListen(
  server: http.Server,
  restore: () => Promise<number>,
  handlers: SessionRestoreResultHandlers
): () => void {
  let active = true;
  const fail = (error: unknown): void => {
    if (!active) return;
    try {
      handlers.failed(error);
    } catch {
      // Startup diagnostics must never become an unhandled rejection.
    }
  };
  const onListening = (): void => {
    let restorePromise: Promise<number>;
    try {
      restorePromise = restore();
    } catch (err) {
      fail(err);
      return;
    }
    void restorePromise
      .then((count) => {
        if (!active) return;
        handlers.restored(count);
      })
      .catch(fail);
  };
  server.once('listening', onListening);
  return () => {
    active = false;
    server.off('listening', onListening);
  };
}
