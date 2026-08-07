import type { Express } from 'express';
import type { Server } from 'node:http';

export interface TestServer {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

/**
 * Starts an Express app on a random loopback port and returns the base URL,
 * the underlying Server, and a close() helper.
 *
 * Usage:
 *   const { url, server, close } = await createTestServer(app);
 *   // ... run tests ...
 *   await close();
 */
export async function createTestServer(app: Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      let url = '';
      if (typeof addr === 'object' && addr) {
        url = `http://127.0.0.1:${addr.port}`;
      }
      resolve({
        url,
        server,
        close: () =>
          new Promise<void>((res) => {
            if (server) server.close(() => res());
            else res();
          }),
      });
    });
  });
}
