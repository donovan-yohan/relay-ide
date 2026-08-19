/**
 * Offline Hermes gateway stub for the adapter conformance suite.
 *
 * `HermesProtocolAdapter` talks to a real HTTP gateway, so the conformance
 * seam is the gateway itself rather than a spawn hook: an in-process
 * `http.Server` bound to loopback, handed to the adapter through
 * `config.extra.endpoint` / `config.extra.apiToken`. Those two keys win over
 * every env/`config.yaml` lookup in `resolveHermesGatewaySettings`, so the rig
 * needs no HOME sandboxing and cannot pick up a developer's live Hermes.
 *
 * The routes are lifted from the inline gateway already used by
 * `hermes-adapter.test.ts` (`/health`, `/v1/models`, `/v1/responses` SSE) and
 * extended with the two control routes the lifecycle needs:
 * `POST /session/:id/abort` (interrupt, `hermes-adapter.ts` ~line 978) and
 * `POST /permission/:id/(allow|deny)` (approval, ~line 992).
 *
 * The one behavioural difference from that test helper is PUSH mode. The test
 * helper writes a whole scripted stream in one callback; the conformance
 * harness must release exactly one native event at a time so a silent drop is
 * attributable to a single event. So `/v1/responses` holds the response open
 * and `push()` writes one SSE frame into it; `endStream()` ends it, which is
 * what lets the adapter's `consumeResponsesSse` return and `sendMessage`
 * resolve.
 *
 * This file is a transport double only — it contains no assertions and no
 * provider grammar. Event payloads live in `fixtures/hermes.fixture.ts`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Upper bound on waiting for the adapter's `/v1/responses` POST to arrive. */
const STREAM_WAIT_MS = 3_000;

export interface HermesGatewayStub {
  /** `http://127.0.0.1:<port>` — feed straight into `config.extra.endpoint`. */
  endpoint: string;
  /** Parsed bodies POSTed to `/v1/responses`, in arrival order. */
  responsesRequests: Array<Record<string, unknown>>;
  /** Paths hit on the abort/permission control routes, in arrival order. */
  controlCalls: string[];
  /** Release exactly one SSE frame on the turn's open response stream. */
  push(event: unknown): Promise<void>;
  /** End the open response stream (no-op when none is open). */
  endStream(): void;
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONTROL_ROUTE =
  /^\/(?:permission\/[^/]+\/(?:allow|deny)|session\/[^/]+\/abort)$/;

export async function startHermesGatewayStub(): Promise<HermesGatewayStub> {
  const responsesRequests: Array<Record<string, unknown>> = [];
  const controlCalls: string[] = [];
  let active: http.ServerResponse | null = null;

  const detach = (res: http.ServerResponse): void => {
    if (active === res) active = null;
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const url = req.url ?? '';

      if (url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }

      if (url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'hermes-conformance-stub' }] }));
        return;
      }

      if (url === '/v1/responses') {
        try {
          responsesRequests.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          responsesRequests.push({});
        }
        // A new turn supersedes any stream the previous turn left open, so a
        // stale response can never absorb the next turn's frames.
        const previous = active;
        active = null;
        if (previous && !previous.writableEnded) previous.end();

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // Flush now so the adapter's `fetch` resolves and starts reading before
        // the first frame is pushed — one fed step, one observable frame.
        res.flushHeaders();
        active = res;
        res.on('close', () => detach(res));
        return;
      }

      if (CONTROL_ROUTE.test(url)) {
        controlCalls.push(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  const waitForStream = async (): Promise<http.ServerResponse> => {
    const deadline = Date.now() + STREAM_WAIT_MS;
    while (Date.now() < deadline) {
      if (active && !active.writableEnded) return active;
      await sleep(1);
    }
    throw new Error(
      'hermes conformance stub: no /v1/responses stream was open to push into'
    );
  };

  return {
    endpoint: `http://127.0.0.1:${port}`,
    responsesRequests,
    controlCalls,
    push: async (event) => {
      const res = await waitForStream();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    endStream: () => {
      const res = active;
      active = null;
      if (res && !res.writableEnded) res.end();
    },
    close: async () => {
      const res = active;
      active = null;
      if (res && !res.writableEnded) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
