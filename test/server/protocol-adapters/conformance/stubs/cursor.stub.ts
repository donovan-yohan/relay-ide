import { vi } from 'vitest';
import {
  AcpClient,
  type AcpClientOptions,
  type AcpNotification,
  type AcpPeerRequest,
} from '../../../../../server/acp-client.js';

export const CURSOR_SESSION_ID = '91d58156-4230-4c0a-a171-bcc28c95873c';

export const CURSOR_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { audio: false, embeddedContext: false, image: true },
    sessionCapabilities: { list: {} },
  },
  authMethods: [
    {
      id: 'cursor_login',
      name: 'Cursor Login',
      description:
        "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in.",
    },
  ],
};

export interface CursorAcpRequest {
  method: string;
  params: Record<string, unknown> | undefined;
}

export interface CursorAcpClientDouble {
  client: AcpClient;
  factory: (options: AcpClientOptions) => AcpClient;
  factoryOptions: AcpClientOptions[];
  requests: CursorAcpRequest[];
  prompts: Record<string, unknown>[];
  notifications: CursorAcpRequest[];
  responses: Array<{ id: string | number; result: unknown }>;
  emitNotification(notification: AcpNotification): void;
  emitPeerRequest(request: AcpPeerRequest): void;
  settlePrompt(stopReason: string): boolean;
  stopped(): boolean;
}

export function makeCursorAcpClientDouble(): CursorAcpClientDouble {
  const client = new AcpClient({ command: 'cursor-agent' });
  client.setMaxListeners(50);
  const requests: CursorAcpRequest[] = [];
  const prompts: Record<string, unknown>[] = [];
  const notifications: CursorAcpRequest[] = [];
  const responses: Array<{ id: string | number; result: unknown }> = [];
  const factoryOptions: AcpClientOptions[] = [];
  let pendingPrompt: ((value: unknown) => void) | null = null;
  let stopped = false;

  vi.spyOn(client, 'start').mockResolvedValue({ ...CURSOR_INITIALIZE_RESULT });

  vi.spyOn(client, 'request').mockImplementation(
    async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'authenticate') return { authenticated: true };
      if (method === 'session/new' || method === 'session/load')
        return { sessionId: CURSOR_SESSION_ID };
      return {};
    }
  );

  vi.spyOn(client, 'prompt').mockImplementation(
    (params: Record<string, unknown>) => {
      prompts.push(params);
      return new Promise((resolve) => {
        pendingPrompt = resolve;
      });
    }
  );

  vi.spyOn(client, 'notify').mockImplementation(
    (method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params });
    }
  );

  vi.spyOn(client, 'respond').mockImplementation(
    (id: string | number, result: unknown) => {
      responses.push({ id, result });
    }
  );

  vi.spyOn(client, 'respondError').mockImplementation(() => undefined);

  vi.spyOn(client, 'stop').mockImplementation(async () => {
    stopped = true;
    pendingPrompt = null;
  });

  return {
    client,
    factory: (options) => {
      factoryOptions.push(options);
      return client;
    },
    factoryOptions,
    requests,
    prompts,
    notifications,
    responses,
    emitNotification: (notification) => {
      client.emit('notification', notification);
    },
    emitPeerRequest: (request) => {
      client.emit('peerRequest', request);
    },
    settlePrompt: (stopReason) => {
      if (!pendingPrompt) return false;
      const resolve = pendingPrompt;
      pendingPrompt = null;
      resolve({ stopReason });
      return true;
    },
    stopped: () => stopped,
  };
}
